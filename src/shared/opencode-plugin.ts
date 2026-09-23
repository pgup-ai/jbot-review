import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERMISSION_DENIED_MESSAGE } from './prompt.ts';

/**
 * Read-only layer 3 (invariant 8), auto-discovered from the hermetic
 * XDG_CONFIG_HOME's `plugins/` dir (a configured `plugins:` entry would need a
 * package directory). Strips mutating tools per request and every tool for the
 * tool-less agents; rewrites `exclusiveMinimum: 0` → `minimum: 1` because
 * Gemini-backed proxies 400 on it; drops the nested AGENTS.md instructions
 * opencode's read tool injects; applies the per-session options file
 * because V2 ignores config model overrides on catalog providers. Plain object
 * export: V2's `Plugin.define` is the identity.
 */
const PLUGIN_SOURCE = `// jbot-review opencode plugin; rationale in src/shared/opencode-plugin.ts.
import { readFileSync } from 'node:fs';
const STRIP = new Set(['write', 'edit', 'patch', 'apply_patch', 'multiedit', 'question', 'subagent', 'task']);
const TOOL_LESS_AGENTS = new Set(['jbot-plain']);

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
// "Instructions from:" user message; reviewed-repo text is evidence, never instructions.
function dropRepoInstructions(messages) {
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const { role, content } = messages[i];
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '';
    if (role === 'user' && text.startsWith('Instructions from: ')) messages.splice(i, 1);
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
      const options = sessionOptions(event.sessionID);
      if (options) {
        delete options.jbotSessionLabel;
        Object.assign(event.options, options);
      }
    });
    await ctx.permission.hook('evaluate', (event) => {
      if (event.effect === 'ask' || (event.agent === 'jbot-wrapup' && event.action === 'shell')) {
        event.effect = 'deny';
        event.message = ${JSON.stringify(PERMISSION_DENIED_MESSAGE)};
      }
    });
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
      PLUGIN_SOURCE.replace('RETRIEVAL_MODULE', JSON.stringify(module.href)),
    );
  }
  return configHome;
}
