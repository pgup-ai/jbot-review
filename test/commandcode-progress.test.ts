import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createCommandCodeProgress } from '../src/shared/commandcode-progress.ts';

it('retains only safe observed metadata across chunk boundaries and incomplete output', () => {
  let now = 0;
  const progress = createCommandCodeProgress(() => now);
  assert.equal(progress.snapshot().lastEventAgeMs, undefined);
  const frame = JSON.stringify({
    type: 'event',
    event: {
      type: 'tool_completed',
      toolName: 'jbot_read_file',
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
  assert.equal(snapshot.lastCompletedTool, 'jbot_read_file');
  assert.deepEqual(snapshot.toolOutcomes, {
    'jbot_read_file:tool_completed': 1,
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
