import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Read-only layer 3 (invariant 8), auto-discovered from the hermetic
 * XDG_CONFIG_HOME's `plugins/` dir (a configured `plugins:` entry would need a
 * package directory). Strips mutating tools per request and every tool for the
 * tool-less agents; rewrites `exclusiveMinimum: 0` → `minimum: 1` because
 * Gemini-backed proxies 400 on it; applies the per-session options file
 * because V2 ignores config model overrides on catalog providers. Plain object
 * export: V2's `Plugin.define` is the identity.
 */
const PLUGIN_SOURCE = `// jbot-review opencode plugin; rationale in src/shared/opencode-plugin.ts.
import { readFileSync, writeFileSync } from 'node:fs';
const STRIP = new Set(['write', 'edit', 'patch', 'multiedit', 'question']);
const TOOL_LESS_AGENTS = new Set(['jbot-wrapup', 'jbot-plain']);

function stripTools(tools, agent) {
  const all = TOOL_LESS_AGENTS.has(agent);
  for (const name of Object.keys(tools)) if (all || STRIP.has(name)) delete tools[name];
}

function geminiSafe(node) {
  if (Array.isArray(node)) { for (const item of node) geminiSafe(item); return; }
  if (!node || typeof node !== 'object') return;
  if (node.type === 'integer' && node.exclusiveMinimum === 0) {
    delete node.exclusiveMinimum;
    if (node.minimum === undefined) node.minimum = 1;
  }
  for (const value of Object.values(node)) geminiSafe(value);
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
    if (process.env.JBOT_OPENCODE_PLUGIN_MARKER) writeFileSync(process.env.JBOT_OPENCODE_PLUGIN_MARKER, 'jbot-review plugin loaded');
    await ctx.session.hook('context', (event) => {
      stripTools(event.tools, event.agent);
      geminiSafe(event.tools);
      const options = sessionOptions(event.sessionID);
      if (options) Object.assign(event.options, options);
    });
    await ctx.permission.hook('evaluate', (event) => {
      if (event.effect === 'ask') {
        event.effect = 'deny';
        event.message = 'jbot-review runs headless; nothing can answer a permission prompt.';
      }
    });
  },
};
`;

let configHome: string | undefined;

/** XDG_CONFIG_HOME for the opencode child: only jbot's plugin, so the operator's global config (ambient MCP servers, plugins) never enters a review. */
export function hermeticOpencodeConfigHome(): string {
  if (!configHome) {
    configHome = mkdtempSync(join(tmpdir(), 'jbot-opencode-config-'));
    mkdirSync(join(configHome, 'opencode', 'plugins'), { recursive: true });
    writeFileSync(join(configHome, 'opencode', 'plugins', 'jbot-review.js'), PLUGIN_SOURCE);
  }
  return configHome;
}
