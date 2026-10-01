import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildDshPatch,
  createDshBackend,
  startDsh,
  dshReasoningEffort,
  dshBootSucceeded,
  parseDshTurn,
  resolveSdkEngine,
} from '../src/shared/dsh.ts';

describe('dsh engine', () => {
  it('is the default engine and falls back to opencode rather than fail a run', () => {
    const usable = () => undefined;
    for (const env of [{}, { JBOT_SDK_ENGINE: 'auto' }]) {
      assert.deepEqual(
        resolveSdkEngine(env, '/bin/dsh', usable, { HTTPS_PROXY: 'http://proxy:8080' }),
        {
          dshBin: '/bin/dsh',
          reason: '',
        },
      );
    }
    assert.deepEqual(resolveSdkEngine({ JBOT_SDK_ENGINE: 'opencode' }, '/bin/dsh', usable), {
      reason: '',
    });
    const broken = () => 'dsh failed its headless boot check';
    for (const [env, bin, unusable, network, reason] of [
      [{}, '', usable, {}, /no dsh binary/],
      [{}, '/bin/dsh', broken, {}, /headless boot check; using the opencode engine/],
      [{}, '/bin/dsh', usable, { HTTPS_PROXY: 'http://u:p@proxy:8080' }, /HTTPS_PROXY carries/],
      [{ JBOT_SDK_ENGINE: 'pi-please' }, '/bin/dsh', usable, {}, /unknown JBOT_SDK_ENGINE/],
    ] as const) {
      const resolved = resolveSdkEngine(env, bin, unusable, network);
      assert.equal(resolved.dshBin, undefined);
      assert.match(resolved.reason, reason);
    }
  });

  it('passes the boot probe only for a session with every entry activated', () => {
    const session = '{"type":"session","sessionId":"s"}\n';
    assert.equal(dshBootSucceeded({ stdout: session, stderr: '' }), true);
    assert.equal(
      dshBootSucceeded({ stdout: session, stderr: 'dsh: warning: 1 entry did not activate' }),
      false,
    );
    assert.equal(dshBootSucceeded({ stdout: '', stderr: '' }), false);
  });

  it('maps efforts onto DeepSeek thinking modes only', () => {
    assert.equal(dshReasoningEffort({ reasoningEffort: 'low' }), 'high');
    assert.equal(dshReasoningEffort({ reasoningEffort: 'xhigh' }), 'max');
    assert.equal(dshReasoningEffort({ reasoningEffort: 'max' }), 'max');
    assert.equal(dshReasoningEffort({ reasoningEffort: 'none' }), 'off');
    for (const reasoningEffort of [undefined, 'default', 3])
      assert.equal(dshReasoningEffort({ reasoningEffort }), undefined);
  });

  it('pins the read-only sandbox and strips write, web and customization rows', () => {
    const rowsFor = (toolLess: boolean, subagents: boolean) => {
      const rows = JSON.parse(
        buildDshPatch({
          providerID: 'opencode-go',
          modelID: 'deepseek-v4.1-flash',
          workspace: '/repo',
          systemPrompt: 'sys',
          routingSession: 's1',
          toolLess,
          subagents,
        }),
      ) as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>;
      return new Map(rows.map((row) => [row.id, row]));
    };
    const byId = rowsFor(true, false);
    assert.deepEqual(byId.get('sandbox-policy')?.config, {
      mode: 'read-only',
      workspaceRoot: '/repo',
    });
    assert.deepEqual(byId.get('approval')?.config, { policy: 'never' });
    assert.deepEqual(byId.get('fs-sandbox')?.config, { cwd: '/repo' });
    for (const id of ['tool-fs', 'tool-web', 'agent-instructions', 'skill-filesystem', 'tool-bash'])
      assert.equal(byId.get(id)?.disabled, true, id);
    // The subagent opt-in keeps only its own rows; the read-only floor stays.
    const withSubagents = rowsFor(false, true);
    for (const id of ['tool-subagent', 'tool-subagent-fork', 'tool-bash'])
      assert.equal(withSubagents.get(id), undefined, id);
    for (const id of ['tool-fs', 'tool-web', 'agent-instructions'])
      assert.equal(withSubagents.get(id)?.disabled, true, id);
    assert.deepEqual(withSubagents.get('approval')?.config, { policy: 'never' });
  });

  it('folds the event stream into text, usage, tools and errors', () => {
    const lines = [
      { type: 'session', sessionId: 'session-1' },
      { type: 'tool_call', callId: 'c1', tool: 'grep', input: { pattern: 'x' } },
      { type: 'tool_result', callId: 'c1', status: 'completed', result: 'a.ts' },
      {
        type: 'status',
        phase: 'step_end',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 90, reasoningTokens: 7 },
      },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 5, outputTokens: 3 } },
      {
        type: 'status',
        phase: 'turn_end',
        reason: { kind: 'error', error: { message: '400: bad' } },
      },
      { type: 'final', text: '{}' },
    ];
    const turn = parseDshTurn({
      stdout: `${lines.map((line) => JSON.stringify(line)).join('\n')}\nnot json\n`,
      stderr: '',
      exitCode: 1,
    });
    assert.equal(turn.sessionId, 'session-1');
    assert.equal(turn.text, '{}');
    assert.equal(turn.error, '400: bad');
    assert.equal(turn.steps, 2);
    assert.deepEqual(turn.usage, {
      input: 15,
      output: 5,
      reasoning: 7,
      cacheRead: 90,
      cacheWrite: 0,
    });
    assert.deepEqual(turn.tools, [
      { name: 'grep', input: { pattern: 'x' }, result: 'a.ts', ok: true },
    ]);
    // A failed exit with no error event still fails the turn, carrying stderr.
    assert.equal(
      parseDshTurn({ stdout: '{"type":"final","text":"{}"}', stderr: 'boom\n', exitCode: 1 }).error,
      'exit 1: boom',
    );
  });

  it('repairs malformed verification JSON in the same session', async () => {
    // A stand-in dsh: the first turn breaks its JSON, the resumed turn answers.
    const dir = mkdtempSync(join(tmpdir(), 'fake-dsh-'));
    const bin = join(dir, 'dsh');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--dump-config')) {
  require('node:fs').mkdirSync(process.env.DSH_HOME, { recursive: true });
  process.exit(0);
}
const text = args.includes('--session-id')
  ? JSON.stringify({ verdicts: [{ index: 0, verdict: 'confirmed', reason: 'ok' }] })
  : '{"verdicts": [';
process.stdin.resume();
process.stdin.on('end', () =>
  console.log([{ type: 'session', sessionId: 's1' }, { type: 'final', text }].map((e) => JSON.stringify(e)).join('\\n')),
);
`,
      { mode: 0o755 },
    );
    const { runtime, stop } = await startDsh(
      dir,
      'opencode-go',
      'deepseek-v4.1-flash',
      'key',
      () => undefined,
      bin,
    );
    try {
      const verdicts = await createDshBackend(runtime).runFindingVerification(
        'opencode-go/deepseek-v4.1-flash',
        'context',
        [{ path: 'a.ts', line: 1, severity: 'P2', title: 't', body: 'b' }],
        () => undefined,
      );
      assert.deepEqual(verdicts, [{ index: 0, verdict: 'confirmed', reason: 'ok' }]);
    } finally {
      await stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
