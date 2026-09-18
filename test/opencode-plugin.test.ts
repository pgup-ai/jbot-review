import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hermeticOpencodeConfigHome } from '../src/shared/opencode-plugin.ts';
import { PERMISSION_DENIED_MESSAGE } from '../src/shared/prompt.ts';

type Hook = (event: unknown) => unknown;

async function loadPlugin(): Promise<{ context: Hook; evaluate: Hook }> {
  const file = join(hermeticOpencodeConfigHome(), 'opencode', 'plugins', 'jbot-review.js');
  const mod = await import(pathToFileURL(file).href);
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
        limit: { type: 'integer', exclusiveMinimum: 0, minimum: 0 },
      },
    },
  },
  read: { description: 'read', input: { type: 'object', properties: {} } },
  question: { description: 'ask', input: { type: 'object', properties: {} } },
  write: { description: 'write', input: { type: 'object', properties: {} } },
  edit: { description: 'edit', input: { type: 'object', properties: {} } },
  patch: { description: 'patch', input: { type: 'object', properties: {} } },
  apply_patch: { description: 'patch', input: { type: 'object', properties: {} } },
  subagent: { description: 'spawn', input: { type: 'object', properties: {} } },
  task: { description: 'spawn', input: { type: 'object', properties: {} } },
});

const temps: string[] = [];
after(() => {
  for (const dir of [hermeticOpencodeConfigHome(), ...temps])
    rmSync(dir, { recursive: true, force: true });
});

describe('jbot opencode plugin', () => {
  it('strips mutating and interactive tools for the plan agent and rewrites the Gemini-hostile schema', async () => {
    const { context } = await loadPlugin();
    const event = { agent: 'plan', tools: tools() };
    context(event);
    assert.deepEqual(Object.keys(event.tools).sort(), ['read', 'shell']);
    assert.deepEqual(event.tools.shell.input.properties.timeout, { type: 'integer', minimum: 1 });
    assert.deepEqual(event.tools.shell.input.properties.limit, { type: 'integer', minimum: 1 });
  });

  it('strips every tool for the wrap-up and single-shot agents', async () => {
    const { context } = await loadPlugin();
    for (const agent of ['jbot-wrapup', 'jbot-plain']) {
      const event = { agent, tools: tools() };
      context(event);
      assert.deepEqual(event.tools, {}, agent);
    }
  });

  it('applies the options registered for the session and nothing for unknown ones', async () => {
    const { context } = await loadPlugin();
    const dir = mkdtempSync(join(tmpdir(), 'jbot-opts-'));
    temps.push(dir);
    const file = join(dir, 'opts.json');
    writeFileSync(file, JSON.stringify({ ses_1: { reasoningEffort: 'low' } }));
    process.env.JBOT_OPENCODE_SESSION_OPTIONS = file;
    try {
      const known = {
        agent: 'plan',
        tools: tools(),
        sessionID: 'ses_1',
        options: { temperature: 0 },
      };
      context(known);
      assert.deepEqual(known.options, { temperature: 0, reasoningEffort: 'low' });
      const unknown = { agent: 'plan', tools: tools(), sessionID: 'ses_2', options: {} };
      context(unknown);
      assert.deepEqual(unknown.options, {});
    } finally {
      delete process.env.JBOT_OPENCODE_SESSION_OPTIONS;
    }
  });

  it('turns a permission ask into a deny so headless runs never hang', async () => {
    const { evaluate } = await loadPlugin();
    const ask = { effect: 'ask', message: '' };
    evaluate(ask);
    assert.equal(ask.effect, 'deny');
    assert.equal(ask.message, PERMISSION_DENIED_MESSAGE);
    const allow = { effect: 'allow', message: '' };
    evaluate(allow);
    assert.equal(allow.effect, 'allow');
  });
});
