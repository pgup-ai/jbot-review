import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import {
  codexAcpSpec,
  createNdjsonReader,
  cursorAcpSpec,
  devinAcpSpec,
  driveAcpSession,
  isAcpEnabled,
  opencodeAcpSpec,
  respondToPermissionRequest,
} from '../src/shared/acp.ts';
import { codexAuthPath } from '../src/shared/codex.ts';

const noLog = (): void => undefined;

interface FakeAgentApi {
  update: (update: Record<string, unknown>) => void;
  request: (id: number, method: string, params: Record<string, unknown>) => void;
  finish: (stopReason?: string) => void;
}

interface FakeAgentScript {
  modes?: Record<string, unknown>;
  onPrompt: (agent: FakeAgentApi) => void;
  onClientResponse?: (id: number, result: unknown, agent: FakeAgentApi) => void;
}

/** Scripted ACP agent over PassThrough streams: answers the handshake and
 * hands prompt-turn control to the script. */
function fakeAgentIo(script: FakeAgentScript): {
  input: PassThrough;
  output: PassThrough;
  setModeIds: string[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const setModeIds: string[] = [];
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
        result: { sessionId: 's1', ...(script.modes ? { modes: script.modes } : {}) },
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
  return { input, output, setModeIds };
}

describe('acp', () => {
  it('parses newline-delimited frames split across chunks and skips banner noise', () => {
    const seen: unknown[] = [];
    const read = createNdjsonReader((message) => seen.push(message));
    read('starting agent v1.2\n{"a"');
    read(':1}\n{"b":2}\n\n{"c"');
    read(':3}\n');
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

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
      assert.ok(existsSync(codexAuthPath(home)));
    } finally {
      codexEnv.cleanup?.();
    }
    rmSync(codexHome, { recursive: true, force: true });

    const opencode = opencodeAcpSpec({
      providerID: 'anthropic',
      modelID: 'claude-x',
      apiKey: 'k',
      promptCache: false,
    });
    const ocEnv = opencode.env('anthropic/claude-x');
    try {
      const config = JSON.parse(readFileSync(ocEnv.env.OPENCODE_CONFIG as string, 'utf8')) as {
        model: string;
        permission: { edit: string; external_directory: string };
        provider: Record<string, { options: { apiKey: string } }>;
      };
      assert.equal(config.model, 'anthropic/claude-x');
      assert.equal(config.permission.edit, 'deny');
      assert.equal(config.permission.external_directory, 'deny');
      assert.equal(config.provider.anthropic.options.apiKey, 'k');
    } finally {
      ocEnv.cleanup?.();
    }

    assert.deepEqual(cursorAcpSpec('key').args('cursor/composer-2'), [
      '--model',
      'composer-2',
      'acp',
    ]);
    assert.deepEqual(cursorAcpSpec('key').args('cursor/default'), ['acp']);
    assert.deepEqual(devinAcpSpec().args('devin/default'), ['acp']);
    assert.deepEqual(devinAcpSpec().args('devin/sonnet'), ['acp', '--model', 'sonnet']);

    assert.equal(isAcpEnabled({ JBOT_ACP: '1' }), true);
    assert.equal(isAcpEnabled({ JBOT_ACP: 'true' }), true);
    assert.equal(isAcpEnabled({ JBOT_ACP: '0' }), false);
    assert.equal(isAcpEnabled({}), false);
  });
});
