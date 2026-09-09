import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  createCommandCodeProgress,
  type CommandCodeTiming,
} from '../src/shared/commandcode-progress.ts';

it('times concurrent native tools separately from model requests and retains unfinished calls', () => {
  let now = 0;
  const timings: CommandCodeTiming[] = [];
  const progress = createCommandCodeProgress(
    () => now,
    (timing) => timings.push(timing),
  );
  const event = (type: string, data = {}) =>
    progress.feed(JSON.stringify({ type: 'event', event: { type, ...data } }) + '\n');
  event('model_request_start');
  now = 1000;
  event('model_request_end', {
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  event('tool_running', { toolCallId: 'secret-id-1', toolName: 'read_file', input: 'SECRET' });
  now = 1010;
  event('tool_running', { toolCallId: 'secret-id-2', toolName: 'web_fetch' });
  now = 1020;
  event('tool_completed', { toolCallId: 'secret-id-1', toolName: 'read_file', result: 'SECRET' });
  now = 1210;
  event('tool_errored', { toolCallId: 'secret-id-2', toolName: 'web_fetch' });
  event('tool_denied', { toolCallId: 'missing-start', toolName: 'SECRET_TOOL' });
  assert.deepEqual(timings, [
    {
      phase: 'model',
      sequence: 1,
      outcome: 'completed',
      durationMs: 1000,
      inputTokens: 100,
      outputTokens: 20,
    },
    { phase: 'tool', sequence: 1, tool: 'read_file', outcome: 'tool_completed', durationMs: 20 },
    { phase: 'tool', sequence: 2, tool: 'web_fetch', outcome: 'tool_errored', durationMs: 200 },
    { phase: 'tool', sequence: 3, tool: 'other', outcome: 'tool_denied' },
  ]);
  now = 2000;
  event('model_request_start');
  event('tool_running', { toolCallId: 'secret-id-3', toolName: 'SECRET_TOOL' });
  now = 2500;
  const pending = progress.snapshot();
  assert.equal(pending.modelRequests, 2);
  assert.equal(pending.modelDurationMs, 1000);
  assert.equal(pending.toolDurationMs, 220);
  assert.equal(pending.activeTimings?.length, 2);
  progress.finish();
  assert.deepEqual(timings.slice(-2), [
    { phase: 'tool', sequence: 4, tool: 'other', outcome: 'incomplete', durationMs: 500 },
    { phase: 'model', sequence: 2, outcome: 'incomplete', durationMs: 500 },
  ]);
  assert.doesNotMatch(JSON.stringify({ timings, pending }), /SECRET|secret-id|missing-start/);
});

it('retains only safe observed metadata across chunk boundaries and incomplete output', () => {
  let now = 0;
  const progress = createCommandCodeProgress(() => now);
  assert.equal(progress.snapshot().lastEventAgeMs, undefined);
  const frame = JSON.stringify({
    type: 'event',
    event: {
      type: 'tool_completed',
      toolName: 'read_file',
      result: 'SECRET_CONTENT',
      input: '/secret/path',
    },
  });
  progress.feed(frame.slice(0, 20));
  assert.equal(progress.snapshot().observedEvents, 0);
  now = 100;
  progress.feed(frame.slice(20) + '\n');
  progress.feed(
    JSON.stringify({ type: 'event', event: { type: 'tool_errored', toolName: 'SECRET_TOOL' } }) +
      '\n',
  );
  assert.equal(progress.snapshot(true).complete, true);
  progress.feed('x'.repeat(1_048_577));
  progress.feed('ignored\nnot json\n');
  progress.feed(
    JSON.stringify({
      type: 'event',
      event: {
        type: 'run_end',
        result: {
          usage: {
            inputTokens: 12,
            outputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 0,
          },
        },
      },
    }),
  );
  progress.finish();
  now = 150;
  const snapshot = progress.snapshot();
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.observedEvents, 3);
  assert.equal(snapshot.droppedFrames, 2);
  assert.equal(snapshot.lastEventAgeMs, 50);
  assert.equal(snapshot.lastCompletedTool, 'read_file');
  assert.deepEqual(snapshot.toolOutcomes, {
    'read_file:tool_completed': 1,
    'other:tool_errored': 1,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|\/secret/);
  assert.deepEqual(progress.usage(), {
    input: 12,
    output: 3,
    cacheRead: 4,
    cacheWrite: 0,
    reasoning: 0,
  });
  assert.equal(progress.snapshot(true).complete, false);
  const empty = createCommandCodeProgress();
  assert.equal(empty.usage(), undefined);
  empty.feed('{"type":"result","usage":{"inputTokens":-1}}\n');
  assert.equal(empty.usage(), undefined);
  assert.equal(empty.snapshot(true).complete, true);
  assert.equal(empty.snapshot().complete, false);
});
