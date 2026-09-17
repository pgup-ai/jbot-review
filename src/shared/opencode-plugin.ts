import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * jbot's opencode plugin. V2 auto-discovers plain plugin files under a config
 * directory's `plugins/` folder, so it lives in the hermetic XDG_CONFIG_HOME
 * (a configured `plugins:` entry must be a package directory instead). It is
 * the third read-only layer (invariant 8): the `plan` agent and the permission
 * ruleset deny mutations at call time; this removes the tools from the request
 * and empties the tool list for the agents jbot uses for a tool-less reply
 * (wrap-up, single-shot models). `question` goes too: it waits for an
 * interactive form nothing in CI can answer. The schema walk keeps
 * Gemini-backed proxies happy (they 400 on `exclusiveMinimum`; `minimum: 1`
 * is the same contract for integers). The permission hook answers any `ask`
 * with deny. Plain object export: V2's `Plugin.define` is the identity
 * function, so no import is needed. Setup runs lazily on the first prompt.
 * JBOT_OPENCODE_PLUGIN_MARKER lets the E2E test prove the plugin loaded.
 */
const PLUGIN_SOURCE = `// jbot-review opencode plugin; rationale in src/shared/opencode-plugin.ts.
import { writeFileSync } from 'node:fs';
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

export default {
  id: 'jbot-review',
  async setup(ctx) {
    if (process.env.JBOT_OPENCODE_PLUGIN_MARKER) writeFileSync(process.env.JBOT_OPENCODE_PLUGIN_MARKER, 'jbot-review plugin loaded');
    await ctx.session.hook('context', (event) => {
      stripTools(event.tools, event.agent);
      geminiSafe(event.tools);
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

/**
 * XDG_CONFIG_HOME for the opencode child: empty except for jbot's own plugin,
 * so the operator's global config (ambient MCP servers, plugins) never enters
 * a review. Memoized so repeated spawns in one process share a single dir.
 */
export function hermeticOpencodeConfigHome(): string {
  if (!configHome) {
    configHome = mkdtempSync(join(tmpdir(), 'jbot-opencode-config-'));
    mkdirSync(join(configHome, 'opencode', 'plugins'), { recursive: true });
    writeFileSync(pluginFile(configHome), PLUGIN_SOURCE);
  }
  return configHome;
}

/** Where the plugin is materialized (exported for the tests that import it). */
export function pluginFile(home = hermeticOpencodeConfigHome()): string {
  return join(home, 'opencode', 'plugins', 'jbot-review.js');
}
