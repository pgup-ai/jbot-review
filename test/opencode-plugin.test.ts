import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hermeticOpencodeConfigHome, pluginFile } from '../src/shared/opencode-plugin.ts';

type Hook = (event: unknown) => unknown;

async function loadPlugin(): Promise<{ context: Hook; evaluate: Hook }> {
  const mod = await import(pathToFileURL(pluginFile()).href);
  const hooks: Record<string, Hook> = {};
  await mod.default.setup({
    session: { hook: async (name: string, fn: Hook) => (hooks[`session.${name}`] = fn) },
    permission: { hook: async (name: string, fn: Hook) => (hooks[`permission.${name}`] = fn) },
  });
  return { context: hooks['session.context']!, evaluate: hooks['permission.evaluate']! };
}

const tools = () => ({
  shell: {
    description: 'run',
    input: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', exclusiveMinimum: 0 },
      },
    },
  },
  read: { description: 'read', input: { type: 'object', properties: {} } },
  question: { description: 'ask', input: { type: 'object', properties: {} } },
  write: { description: 'write', input: { type: 'object', properties: {} } },
  edit: { description: 'edit', input: { type: 'object', properties: {} } },
  patch: { description: 'patch', input: { type: 'object', properties: {} } },
});

describe('jbot opencode plugin', () => {
  it('materializes once under the hermetic config home where V2 auto-discovers it', () => {
    const home = hermeticOpencodeConfigHome();
    assert.equal(pluginFile(), join(home, 'opencode', 'plugins', 'jbot-review.js'));
    assert.ok(existsSync(pluginFile()));
    assert.equal(hermeticOpencodeConfigHome(), home);
  });

  it('strips mutating and interactive tools for the plan agent and rewrites the Gemini-hostile schema', async () => {
    const { context } = await loadPlugin();
    const event = { agent: 'plan', tools: tools() };
    context(event);
    assert.deepEqual(Object.keys(event.tools).sort(), ['read', 'shell']);
    assert.deepEqual(event.tools.shell.input.properties.timeout, { type: 'integer', minimum: 1 });
  });

  it('strips every tool for the wrap-up and single-shot agents', async () => {
    const { context } = await loadPlugin();
    for (const agent of ['jbot-wrapup', 'jbot-plain']) {
      const event = { agent, tools: tools() };
      context(event);
      assert.deepEqual(event.tools, {}, agent);
    }
  });

  it('turns a permission ask into a deny so headless runs never hang', async () => {
    const { evaluate } = await loadPlugin();
    const ask = { effect: 'ask', message: '' };
    evaluate(ask);
    assert.equal(ask.effect, 'deny');
    const allow = { effect: 'allow', message: '' };
    evaluate(allow);
    assert.equal(allow.effect, 'allow');
  });
});
