import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDshPatch,
  dshReasoningEffort,
  parseDshEvents,
  resolveSdkEngine,
} from '../src/shared/dsh.ts';

describe('dsh engine', () => {
  it('is the default engine and falls back to opencode rather than fail a run', () => {
    const usable = () => true;
    assert.deepEqual(resolveSdkEngine({}, '/bin/dsh', usable), { dshBin: '/bin/dsh', reason: '' });
    assert.deepEqual(resolveSdkEngine({ JBOT_SDK_ENGINE: 'opencode' }, '/bin/dsh', usable), {
      reason: '',
    });
    for (const [env, bin, sandbox, reason] of [
      [{}, '', usable, /no dsh binary/],
      [{}, '/bin/dsh', () => false, /no usable dsh sandbox/],
      [{ JBOT_SDK_ENGINE: 'auto' }, '/bin/dsh', usable, /pi engine .* was removed/],
      [{ JBOT_SDK_ENGINE: 'pi-please' }, '/bin/dsh', usable, /unknown JBOT_SDK_ENGINE/],
    ] as const) {
      const resolved = resolveSdkEngine(env, bin, sandbox);
      assert.equal(resolved.dshBin, undefined);
      assert.match(resolved.reason, reason);
    }
  });

  it('maps efforts onto DeepSeek thinking modes only', () => {
    assert.equal(dshReasoningEffort('deepseek-v4.1-flash', { reasoningEffort: 'low' }), 'high');
    assert.equal(dshReasoningEffort('deepseek-v4.1-flash', { reasoningEffort: 'xhigh' }), 'max');
    assert.equal(dshReasoningEffort('glm-5.3', { reasoningEffort: 'high' }), undefined);
  });

  it('pins the read-only sandbox and strips write, web and customization rows', () => {
    const rows = JSON.parse(
      buildDshPatch({
        providerID: 'opencode-go',
        modelID: 'deepseek-v4.1-flash',
        workspace: '/repo',
        systemPrompt: 'sys',
        routingSession: 's1',
        toolLess: true,
      }),
    ) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.deepEqual(byId.get('sandbox-policy')?.config, {
      mode: 'read-only',
      workspaceRoot: '/repo',
    });
    assert.deepEqual(byId.get('approval')?.config, { policy: 'never' });
    for (const id of ['tool-fs', 'tool-web', 'agent-instructions', 'skill-filesystem', 'tool-bash'])
      assert.equal(byId.get(id)?.disabled, true, id);
  });

  it('folds the event stream into text, usage, tools and errors', () => {
    const lines = [
      { type: 'session', sessionId: 'session-1' },
      { type: 'tool_call', callId: 'c1', tool: 'grep', input: { pattern: 'x' } },
      { type: 'tool_result', callId: 'c1', status: 'completed', result: 'a.ts' },
      {
        type: 'status',
        phase: 'step_end',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90 },
      },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 5, outputTokens: 3 } },
      {
        type: 'status',
        phase: 'turn_end',
        reason: { kind: 'error', error: { message: '400: bad' } },
      },
      { type: 'final', text: '{}' },
    ];
    const turn = parseDshEvents(
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`,
    );
    assert.equal(turn.sessionId, 'session-1');
    assert.equal(turn.text, '{}');
    assert.equal(turn.error, '400: bad');
    assert.equal(turn.steps, 2);
    assert.deepEqual(turn.usage, {
      input: 15,
      output: 5,
      reasoning: 0,
      cacheRead: 90,
      cacheWrite: 0,
    });
    assert.deepEqual(turn.tools, [
      { name: 'grep', input: { pattern: 'x' }, result: 'a.ts', ok: true },
    ]);
  });
});
