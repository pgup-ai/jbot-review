import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { hermeticOpencodeConfigHome } from '../src/shared/opencode-plugin.ts';
import { PERMISSION_DENIED_MESSAGE, TOOLS_OFF_MESSAGE } from '../src/shared/prompt.ts';

type Hook = (event: unknown) => unknown;

async function loadPlugin(
  tool = { transform: async () => {}, hook: async () => {} },
): Promise<{ context: Hook; evaluate: Hook }> {
  const file = join(hermeticOpencodeConfigHome(), 'opencode', 'plugins', 'jbot-review.js');
  const mod = await import(pathToFileURL(file).href);
  const hooks: Record<string, Hook> = {};
  await mod.default.setup({
    tool,
    session: {
      hook: async (name: string, fn: Hook) => {
        const previous = hooks[`session.${name}`];
        hooks[`session.${name}`] = (event) => {
          previous?.(event);
          return fn(event);
        };
      },
    },
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
  it('keeps core read-only hooks when optional retrieval setup fails', async (t) => {
    const previous = process.env.JBOT_EXPLORATION_CONFIG;
    t.after(() => {
      if (previous === undefined) delete process.env.JBOT_EXPLORATION_CONFIG;
      else process.env.JBOT_EXPLORATION_CONFIG = previous;
    });
    const warnings = t.mock.method(console, 'warn', () => {});
    const tool = {
      hook: t.mock.fn(async () => {
        throw new Error('retrieval registration failed');
      }),
    };
    for (const config of ['invalid JSON', '{"checkpoints":true}']) {
      process.env.JBOT_EXPLORATION_CONFIG = config;
      const { context, evaluate } = await loadPlugin(tool);
      const event = { agent: 'plan', tools: tools() };
      context(event);
      assert.deepEqual(Object.keys(event.tools).sort(), ['read', 'shell']);
      const permission = { effect: 'ask', message: '' };
      evaluate(permission);
      assert.equal(permission.effect, 'deny');
    }
    assert.equal(warnings.mock.callCount(), 2);
    assert.equal(tool.hook.mock.callCount(), 1);
    assert.doesNotMatch(
      JSON.stringify(warnings.mock.calls.map((c) => c.arguments)),
      /invalid JSON|TypeError/,
    );
  });

  it('strips mutating and interactive tools for review and wrap-up and rewrites the Gemini-hostile schema', async () => {
    const { context } = await loadPlugin();
    for (const agent of ['plan', 'jbot-wrapup', 'jbot-closed-book']) {
      const event = { agent, tools: tools() };
      context(event);
      assert.deepEqual(Object.keys(event.tools).sort(), ['read', 'shell']);
      assert.deepEqual(event.tools.shell.input.properties.timeout, { type: 'integer', minimum: 1 });
      assert.deepEqual(event.tools.shell.input.properties.limit, { type: 'integer', minimum: 1 });
    }
  });

  it('strips every tool for the single-shot agent', async () => {
    const { context } = await loadPlugin();
    const event = { agent: 'jbot-plain', tools: tools() };
    context(event);
    assert.deepEqual(event.tools, {});
  });

  it('applies the options registered for the session and nothing for unknown ones', async () => {
    const { context } = await loadPlugin();
    const dir = mkdtempSync(join(tmpdir(), 'jbot-opts-'));
    temps.push(dir);
    const file = join(dir, 'opts.json');
    writeFileSync(
      file,
      JSON.stringify({ ses_1: { reasoningEffort: 'low', jbotSessionLabel: 'review' } }),
    );
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
    const wrapShell = { agent: 'jbot-wrapup', action: 'shell', effect: 'allow', message: '' };
    evaluate(wrapShell);
    assert.equal(wrapShell.effect, 'deny');
    assert.equal(wrapShell.message, PERMISSION_DENIED_MESSAGE);
    const closedRead = { agent: 'jbot-closed-book', action: 'read', effect: 'allow', message: '' };
    evaluate(closedRead);
    assert.deepEqual(closedRead, { ...closedRead, effect: 'deny', message: TOOLS_OFF_MESSAGE });
    for (const event of [
      { agent: 'plan', action: 'shell', effect: 'allow' },
      { agent: 'jbot-wrapup', action: 'read', effect: 'allow' },
    ]) {
      evaluate(event);
      assert.equal(event.effect, 'allow');
    }
  });
});
