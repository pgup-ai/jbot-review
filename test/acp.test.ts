import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  codexAcpSpec,
  createNdjsonReader,
  cursorAcpSpec,
  devinAcpSpec,
  driveAcpSession,
  matchModelOptionValue,
  respondToPermissionRequest,
} from '../src/shared/acp.ts';
import { codexAuthPath } from '../src/shared/codex.ts';
import { devinCredentialsPath } from '../src/shared/devin.ts';

const noLog = (): void => undefined;

interface FakeAgentApi {
  update: (update: Record<string, unknown>) => void;
  request: (id: number, method: string, params: Record<string, unknown>) => void;
  finish: (stopReason?: string) => void;
}

interface FakeAgentScript {
  modes?: Record<string, unknown>;
  configOptions?: unknown[];
  onPrompt: (agent: FakeAgentApi) => void;
  onClientResponse?: (id: number, result: unknown, agent: FakeAgentApi) => void;
}

/** Scripted ACP agent over PassThrough streams: answers the handshake and
 * hands prompt-turn control to the script. */
function fakeAgentIo(script: FakeAgentScript): {
  input: PassThrough;
  output: PassThrough;
  setModeIds: string[];
  setConfigCalls: unknown[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const setModeIds: string[] = [];
  const setConfigCalls: unknown[] = [];
  let promptId: unknown;
  const send = (message: Record<string, unknown>): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };
  const agent: FakeAgentApi = {
    update: (update) =>
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } }),
    request: (id, method, params) => send({ jsonrpc: '2.0', id, method, params }),
    finish: (stopReason = 'end_turn') =>
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason } }),
  };
  const read = createNdjsonReader((message) => {
    const { id, method } = message as { id?: number; method?: string };
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: 1 } });
    } else if (method === 'session/new') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId: 's1',
          ...(script.modes ? { modes: script.modes } : {}),
          ...(script.configOptions ? { configOptions: script.configOptions } : {}),
        },
      });
    } else if (method === 'session/set_config_option') {
      setConfigCalls.push(message.params);
      const params = message.params as { configId?: string; value?: string };
      send({
        jsonrpc: '2.0',
        id,
        result: { configOptions: [{ id: params.configId, currentValue: params.value }] },
      });
    } else if (method === 'session/set_mode') {
      setModeIds.push((message.params as { modeId?: string })?.modeId ?? '');
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'session/prompt') {
      promptId = id;
      script.onPrompt(agent);
    } else if (method === undefined && id !== undefined) {
      script.onClientResponse?.(id, (message as { result?: unknown }).result, agent);
    }
  });
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => read(chunk));
  return { input, output, setModeIds, setConfigCalls };
}

describe('acp', () => {
  it('parses newline-delimited frames split across chunks and skips banner noise', () => {
    const seen: unknown[] = [];
    const read = createNdjsonReader((message) => seen.push(message));
    read('starting agent v1.2\n{"a"');
    read(':1}\n{"b":2}\n\n{"c"');
    read(':3}\n');
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
    // Oversized frame trips the budget and latches the reader off.
    const capped = createNdjsonReader(() => undefined, 8);
    assert.equal(capped('{"x":"aaaaaaaaaa'), false);
    assert.equal(capped('"}\n'), false);
    // Same budget applies when the newline lands in the same chunk.
    const oneShot: unknown[] = [];
    const capped2 = createNdjsonReader((message) => oneShot.push(message), 8);
    assert.equal(capped2('{"x":"aaaaaaaaaa"}\n'), false);
    assert.deepEqual(oneShot, []);
  });

  // execute-allow and unknown-kind-allow are the DESIGNED policy (invariant
  // #8: bash stays allowed; agent-side sandbox/plan layers police commands),
  // so this test pins them on purpose.
  it('answers permission requests read-only: mutations rejected, reads/exec allowed', () => {
    const options = [
      { optionId: 'aa', kind: 'allow_always' },
      { optionId: 'ao', kind: 'allow_once' },
      { optionId: 'ro', kind: 'reject_once' },
    ];
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'execute' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ao' },
    });
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'edit' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ro' },
    });
    // Hyphenated kinds (cursor) normalize; *_always is the same-direction fallback.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: { kind: 'delete' },
        options: [
          { optionId: 'ra', kind: 'reject-always' },
          { optionId: 'aa', kind: 'allow-always' },
        ],
      }),
      { outcome: { outcome: 'selected', optionId: 'ra' } },
    );
    // Missing kind defaults to allow — read tools commonly ship kind "other" or none.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: {},
        options: [{ optionId: 'ao', kind: 'allow_once' }],
      }),
      { outcome: { outcome: 'selected', optionId: 'ao' } },
    );
    // switch_mode is denied: jbot sets the session mode; approving one would
    // let a prompt-injected switch escape the plan-mode read-only layer.
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'switch_mode' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ro' },
    });
    // A denied tool with only allow options gets the cancelled outcome, never an allow.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: { kind: 'edit' },
        options: [{ optionId: 'aa', kind: 'allow_always' }],
      }),
      { outcome: { outcome: 'cancelled' } },
    );
  });

  it('drives a session end-to-end and returns the last assistant segment', async () => {
    const permissionAnswers: unknown[] = [];
    const fake = fakeAgentIo({
      modes: { currentModeId: 'act', availableModes: [{ id: 'plan' }, { id: 'act' }] },
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'hmm' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Let me check.' },
        });
        agent.request(99, 'session/request_permission', {
          sessionId: 's1',
          toolCall: { kind: 'execute' },
          options: [
            { optionId: 'yes', kind: 'allow_once' },
            { optionId: 'no', kind: 'reject_once' },
          ],
        });
      },
      onClientResponse: (id, result, agent) => {
        permissionAnswers.push(result);
        agent.update({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'pending' });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '{"summary":"ok",' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '"findings":[]}' },
        });
        agent.finish();
      },
    });
    const result = await driveAcpSession(
      { input: fake.input, output: fake.output },
      { cwd: '/x', prompt: 'review it', agent: 'fake', label: 'review', log: noLog },
    );
    assert.equal(result.text, '{"summary":"ok","findings":[]}');
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(fake.setModeIds, ['plan']);
    assert.deepEqual(permissionAnswers, [{ outcome: { outcome: 'selected', optionId: 'yes' } }]);

    // With messageIds, segmentation follows the ids — the last message wins.
    const fake2 = fakeAgentIo({
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: 'first' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm2',
          content: { type: 'text', text: 'second ' },
        });
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm2',
          content: { type: 'text', text: 'message' },
        });
        agent.finish();
      },
    });
    const result2 = await driveAcpSession(
      { input: fake2.input, output: fake2.output },
      { cwd: '/x', prompt: 'p', agent: 'fake', label: 'review', log: noLog },
    );
    assert.equal(result2.text, 'second message');
    assert.deepEqual(fake2.setModeIds, []);

    // Model selection rides session/set_config_option when the spec asks for it.
    const fake3 = fakeAgentIo({
      configOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'swe-1-7',
          options: [{ value: 'glm-5-2', name: 'GLM 5.2' }],
        },
      ],
      onPrompt: (agent) => {
        agent.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ok' },
        });
        agent.finish();
      },
    });
    const result3 = await driveAcpSession(
      { input: fake3.input, output: fake3.output },
      {
        cwd: '/x',
        prompt: 'p',
        agent: 'fake',
        label: 'review',
        log: noLog,
        configOptionModelId: 'glm-5.2',
      },
    );
    assert.equal(result3.text, 'ok');
    assert.deepEqual(fake3.setConfigCalls, [
      { sessionId: 's1', configId: 'model', value: 'glm-5-2' },
    ]);

    // requirePlanMode fails closed when the agent offers no plan mode.
    const fake4 = fakeAgentIo({
      modes: { currentModeId: 'code', availableModes: [{ id: 'code' }] },
      onPrompt: (agent) => agent.finish(),
    });
    await assert.rejects(
      driveAcpSession(
        { input: fake4.input, output: fake4.output },
        {
          cwd: '/x',
          prompt: 'p',
          agent: 'fake',
          label: 'review',
          log: noLog,
          requirePlanMode: true,
        },
      ),
      /offered no plan mode/,
    );
  });

  it('materializes per-agent read-only and model config', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'jbot-test-codex-'));
    writeFileSync(codexAuthPath(codexHome), '{}');
    const codex = codexAcpSpec(codexHome);
    const codexEnv = codex.env('codex/gpt-5.2-codex');
    try {
      const home = codexEnv.env.CODEX_HOME as string;
      const config = readFileSync(join(home, 'config.toml'), 'utf8');
      assert.match(config, /sandbox_mode = "read-only"/);
      assert.match(config, /model = "gpt-5\.2-codex"/);
      const weird = codex.env('codex/we"ird\\model');
      try {
        const escaped = readFileSync(join(weird.env.CODEX_HOME as string, 'config.toml'), 'utf8');
        assert.ok(escaped.includes('model = "we\\"ird\\\\model"'));
      } finally {
        weird.cleanup?.();
      }
      assert.ok(existsSync(codexAuthPath(home)));
    } finally {
      codexEnv.cleanup?.();
    }
    rmSync(codexHome, { recursive: true, force: true });

    assert.deepEqual(cursorAcpSpec('key').args('cursor/composer-2'), [
      '--model',
      'composer-2',
      'acp',
    ]);
    assert.deepEqual(cursorAcpSpec('key').args('cursor/default'), ['acp']);
    const devinHome = mkdtempSync(join(tmpdir(), 'jbot-test-devin-'));
    const sourceCredentials = devinCredentialsPath(devinHome);
    mkdirSync(dirname(sourceCredentials), { recursive: true });
    writeFileSync(sourceCredentials, 'windsurf_api_key = "k"\n');
    const devin = devinAcpSpec(devinHome);
    assert.deepEqual(devin.args('devin/glm-5.2'), ['acp']);
    assert.equal(devin.modelConfigOption, true);
    assert.equal(devin.requirePlanMode, true);
    const devinEnv = devin.env('devin/glm-5.2');
    try {
      const home = devinEnv.env.HOME as string;
      assert.notEqual(home, devinHome);
      assert.equal(devinEnv.env.XDG_CONFIG_HOME, undefined);
      assert.ok(existsSync(devinCredentialsPath(home)));
      const config = JSON.parse(
        readFileSync(join(home, '.config', 'devin', 'config.json'), 'utf8'),
      ) as { permissions: { deny: string[] } };
      assert.ok(config.permissions.deny.includes('write'));
    } finally {
      devinEnv.cleanup?.();
    }
    rmSync(devinHome, { recursive: true, force: true });

    const modelOptions = [
      { value: 'glm-5-2', name: 'GLM 5.2' },
      { value: 'claude-opus-4-8-medium', name: 'Claude Opus 4.8 Medium' },
    ];
    assert.equal(matchModelOptionValue(modelOptions, 'glm-5-2'), 'glm-5-2');
    assert.equal(matchModelOptionValue(modelOptions, 'glm-5.2'), 'glm-5-2');
    assert.equal(
      matchModelOptionValue(modelOptions, 'claude opus 4.8 medium'),
      'claude-opus-4-8-medium',
    );
    assert.equal(matchModelOptionValue(modelOptions, 'nope'), undefined);
    // Grouped option lists flatten; a group header's name is never a model.
    const grouped = [
      { name: 'Recommended', options: [{ value: 'glm-5-2', name: 'GLM 5.2' }] },
      { name: 'Other', options: [{ value: 'swe-1-7', name: 'SWE 1.7' }] },
    ];
    assert.equal(matchModelOptionValue(grouped, 'glm-5.2'), 'glm-5-2');
    assert.equal(matchModelOptionValue(grouped, 'swe-1-7'), 'swe-1-7');
    assert.equal(matchModelOptionValue(grouped, 'recommended'), undefined);
  });
});
