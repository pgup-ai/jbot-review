import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  createCommandCodeProgress,
  parseCommandCodeBenchmark,
} from '../src/shared/commandcode-progress.ts';

it('retains only safe observed metadata across chunk boundaries and incomplete output', () => {
  let now = 0;
  const progress = createCommandCodeProgress(() => now);
  assert.equal(progress.snapshot().lastEventAgeMs, undefined);
  const frame = JSON.stringify({
    type: 'event',
    event: {
      type: 'tool_completed',
      toolName: 'read_directory',
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
          stopReason: 'permission_denied',
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
  assert.equal(snapshot.stopReason, 'permission_denied');
  assert.equal(snapshot.observedEvents, 3);
  assert.equal(snapshot.droppedFrames, 2);
  assert.equal(snapshot.lastEventAgeMs, 50);
  assert.equal(snapshot.lastCompletedTool, 'read_directory');
  assert.deepEqual(snapshot.toolOutcomes, {
    'read_directory:tool_completed': 1,
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

it('counts overlapping native tools once and exposes only numeric benchmark data', () => {
  let now = 0;
  const progress = createCommandCodeProgress(() => now);
  const feed = (event: Record<string, unknown>) =>
    progress.feed(JSON.stringify({ type: 'event', event }) + '\n');
  for (const id of ['a', 'b']) {
    feed({
      type: 'tool_queued',
      toolCallId: id,
      toolName: 'read_file',
      input: { path: '/SECRET' },
    });
    feed({ type: 'tool_running', toolCallId: id });
    now += 10;
  }
  feed({ type: 'tool_completed', toolCallId: 'a', toolName: 'read_file' });
  now = 30;
  feed({ type: 'tool_errored', toolCallId: 'b', toolName: 'read_file' });
  now = 100;
  assert.equal(progress.snapshot().observedToolActiveMs, 30);
  assert.equal(progress.snapshot().maxConcurrentTools, 2);
  assert.equal(progress.snapshot().repeatedToolCalls, 1);
  assert.doesNotMatch(JSON.stringify(progress.snapshot()), /SECRET/);
  assert.deepEqual(
    parseCommandCodeBenchmark({
      wallTimeMs: 100,
      agents: [{ secret: 'SECRET' }],
      turnDetails: [{ apiDurationMs: 40, toolDurationMs: 40, toolCalls: [{ name: 'SECRET' }, {}] }],
    }),
    { wallTimeMs: 100, turns: [{ apiMs: 40, toolWorkMs: 40, toolCalls: 2 }] },
  );
  assert.equal(parseCommandCodeBenchmark({ wallTimeMs: 100, turnDetails: [{}] }), undefined);
});
