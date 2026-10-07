import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERIFY_AGENT } from './opencode-config.ts';
import {
  PERMISSION_DENIED_MESSAGE,
  REPORT_FINDING_TOOL_DESCRIPTION,
  TOOLS_OFF_MESSAGE,
  VERIFICATION_STEP_LIMIT_PROMPT,
} from './prompt.ts';

/**
 * Read-only layer 3 (invariant 8), auto-discovered from the hermetic
 * XDG_CONFIG_HOME's `plugins/` dir (a configured `plugins:` entry would need a
 * package directory). Strips mutating tools per request, plus the web and
 * code-execution tools reviews spent minutes fetching library bundles with, and
 * every tool for the tool-less agents; rewrites `exclusiveMinimum: 0` → `minimum: 1` because
 * Gemini-backed proxies 400 on it; drops the nested AGENTS.md instructions
 * opencode's read tool injects; applies the per-session options file
 * because V2 ignores config model overrides on catalog providers. Plain object
 * export: V2's `Plugin.define` is the identity.
 */
// Format after configuration imports finish initializing.
const pluginSource =
  () => `// jbot-review opencode plugin; rationale in src/shared/opencode-plugin.ts.
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
const STRIP = new Set(['write', 'edit', 'patch', 'apply_patch', 'multiedit', 'question', 'subagent', 'task', 'webfetch', 'websearch', 'execute']);
const TOOL_LESS_AGENTS = new Set(['jbot-plain']);
// A runaway or prompt-injected page must not grow its journal without bound.
const REPORTED_FINDINGS_MAX_BYTES = 1024 * 1024;

function stripTools(tools, agent) {
  const all = TOOL_LESS_AGENTS.has(agent);
  for (const name of Object.keys(tools)) if (all || STRIP.has(name)) delete tools[name];
}

function geminiSafe(node) {
  if (Array.isArray(node)) { for (const item of node) geminiSafe(item); return; }
  if (!node || typeof node !== 'object') return;
  if (node.type === 'integer' && node.exclusiveMinimum === 0) {
    delete node.exclusiveMinimum;
    node.minimum = Math.max(node.minimum ?? 1, 1);
  }
  for (const value of Object.values(node)) geminiSafe(value);
}

// opencode's read tool adds each nested AGENTS.md it walks past as an
// "Instructions from: <path>/AGENTS.md" user message; reviewed-repo text is evidence, never instructions.
const REPO_INSTRUCTIONS = /^Instructions from: [^\\n]*AGENTS\\.md\\n/;
function dropRepoInstructions(messages) {
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i];
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
    if (role === 'user' && REPO_INSTRUCTIONS.test(text)) messages.splice(i, 1);
  }
}

function sessionOptions(sessionID) {
  const file = process.env.JBOT_OPENCODE_SESSION_OPTIONS;
  if (!file) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8'))[sessionID];
  } catch {
    return undefined;
  }
}

export default {
  id: 'jbot-review',
  async setup(ctx) {
    await ctx.session.hook('context', (event) => {
      stripTools(event.tools, event.agent);
      geminiSafe(event.tools);
      dropRepoInstructions(event.messages);
      // OpenCode 2.0.22 asks for prose at step exhaustion; preserve the verdict contract on upgrades.
      const last = event.messages?.at(-1);
      if (event.agent?.startsWith(${JSON.stringify(VERIFY_AGENT)}) && last?.role === 'assistant') {
        const text = typeof last.content === 'string' ? last.content :
          Array.isArray(last.content) && last.content.length === 1 && last.content[0]?.type === 'text' ? last.content[0].text : '';
        if (text.startsWith('CRITICAL - MAXIMUM STEPS REACHED\\n')) {
          last.content = [{ type: 'text', text: ${JSON.stringify(VERIFICATION_STEP_LIMIT_PROMPT)} }];
        }
      }
      const options = sessionOptions(event.sessionID);
      if (!options?.jbotReportFindings) delete event.tools.report_finding;
      if (options) {
        delete options.jbotSessionLabel;
        delete options.jbotReportFindings;
        Object.assign(event.options, options);
      }
    });
    await ctx.permission.hook('evaluate', (event) => {
      if (event.agent === 'jbot-closed-book') {
        event.effect = 'deny';
        event.message = ${JSON.stringify(TOOLS_OFF_MESSAGE)};
      } else if (event.effect === 'ask' || (event.agent === 'jbot-wrapup' && event.action === 'shell')) {
        event.effect = 'deny';
        event.message = ${JSON.stringify(PERMISSION_DENIED_MESSAGE)};
      }
    });
    // Compliance pages record each confirmed violation here, so a cut-off keeps what they found.
    try {
      // The hook first: a tool whose calls are never persisted would only claim to record.
      await ctx.tool.hook('execute.after', (event) => {
        if (event.tool !== 'report_finding' || event.status !== 'completed') return;
        const file = process.env.JBOT_OPENCODE_SESSION_OPTIONS;
        if (!file) return;
        const name = 'reported-' + createHash('sha256').update(event.sessionID).digest('hex') + '.jsonl';
        const journal = join(dirname(file), name);
        try {
          if (existsSync(journal) && statSync(journal).size >= REPORTED_FINDINGS_MAX_BYTES) return;
          appendFileSync(journal, JSON.stringify(event.input) + '\\n', { mode: 0o600 });
        } catch {
          console.warn('[jbot-review] report_finding could not record a finding; the final JSON still lists it.');
        }
      });
      await ctx.tool.transform((editor) => {
        editor.add({
          name: 'report_finding',
          // A code-mode tool is reachable only through \`execute\`, which the read-only layer strips.
          options: { codemode: false },
          description: ${JSON.stringify(REPORT_FINDING_TOOL_DESCRIPTION)},
          input: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              line: { type: 'integer', minimum: 0 },
              severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
              title: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['path', 'line', 'severity', 'title', 'body'],
            additionalProperties: false,
          },
          async execute() {
            return { content: 'Recorded. Keep auditing, and list it again in your final JSON.' };
          },
        });
      });
    } catch {
      console.warn('[jbot-review] report_finding setup failed; compliance pages keep only their final JSON.');
    }
    try {
      const experiment = JSON.parse(process.env.JBOT_EXPLORATION_CONFIG || '{}');
      if (experiment.checkpoints || experiment.readEvidence) {
        const { installReviewRetrieval } = await import(RETRIEVAL_MODULE);
        await installReviewRetrieval(ctx, process.env.JBOT_RETRIEVAL_WORKSPACE, process.env.JBOT_EXPLORATION_STATS_DIR, experiment, (id) => sessionOptions(id)?.jbotSessionLabel);
      }
    } catch {
      console.warn('[jbot-review] Optional retrieval setup failed; continuing with ordinary tools.');
    }
  },
};
`;

let configHome: string | undefined;

/** XDG_CONFIG_HOME for the opencode child: only jbot's plugin, so the operator's global config (ambient MCP servers, plugins) never enters a review. */
export function hermeticOpencodeConfigHome(): string {
  if (!configHome) {
    configHome = mkdtempSync(join(tmpdir(), 'jbot-opencode-config-'));
    mkdirSync(join(configHome, 'opencode', 'plugins'), { recursive: true });
    const bundled = new URL('../review-retrieval.js', import.meta.url);
    const module = existsSync(fileURLToPath(bundled))
      ? bundled
      : new URL('./review-retrieval.ts', import.meta.url);
    writeFileSync(
      join(configHome, 'opencode', 'plugins', 'jbot-review.js'),
      pluginSource().replace('RETRIEVAL_MODULE', JSON.stringify(module.href)),
    );
  }
  return configHome;
}
