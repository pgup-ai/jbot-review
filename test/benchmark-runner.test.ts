import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyBenchmarkProcessFailure,
  isBenchmarkRunnerOutput,
  parseBenchmarkTelemetry,
} from '../src/shared/benchmark-runner.ts';

describe('benchmark runner decisions', () => {
  it('classifies timeout, signal, runner-exit, and spawn failures', () => {
    assert.equal(classifyBenchmarkProcessFailure({ killed: true }).failureClass, 'timeout');
    assert.equal(classifyBenchmarkProcessFailure({ signal: 'SIGTERM' }).failureClass, 'signal');
    assert.equal(classifyBenchmarkProcessFailure({ code: 7 }).failureClass, 'runner-exit');
    assert.equal(classifyBenchmarkProcessFailure({ code: 'ENOENT' }).failureClass, 'spawn');
  });

  it('aggregates valid session telemetry and ignores malformed rows', () => {
    const metrics = parseBenchmarkTelemetry(
      [
        '{',
        'null',
        '[]',
        JSON.stringify({ kind: 'finding', inputTokens: 100 }),
        JSON.stringify({
          kind: 'session',
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 2,
          cacheReadTokens: 3,
          estimatedCostUsd: 0.25,
        }),
        JSON.stringify({
          kind: 'exploration',
          session: 'review-shard-1',
          turnCount: 4,
          suppliedRereads: 2,
          suppliedSearches: 1,
        }),
        JSON.stringify({
          kind: 'exploration',
          session: 'review-shard-2',
          turnCount: 3,
          suppliedRereads: -1,
        }),
        JSON.stringify({ kind: 'exploration', session: 'review-shard-2-retry', turnCount: 2 }),
        JSON.stringify({
          kind: 'exploration',
          session: 'review-interactions',
          turnCount: 9,
          suppliedRereads: 5,
          suppliedSearches: 5,
        }),
        JSON.stringify({ kind: 'exploration', session: 'review', turnCount: -1 }),
        JSON.stringify({ kind: 'phase', phase: 'main-execution', scope: 'run', durationMs: 1200 }),
        JSON.stringify({
          kind: 'phase',
          phase: 'main-execution',
          scope: 'session',
          session: 'review-shard-1',
          durationMs: 900,
        }),
        JSON.stringify({ kind: 'context-pack', session: 'review-interactions', state: 'complete' }),
        JSON.stringify({ kind: 'context-pack', session: 'review-shard-1', state: 'fallback' }),
        JSON.stringify({ kind: 'tool', session: 'review-shard-1', toolClass: 'file-read' }),
        JSON.stringify({ kind: 'tool', session: 'review-interactions', toolClass: 'file-read' }),
      ].join('\n'),
    );
    assert.deepEqual(metrics, {
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      cacheReadTokens: 3,
      costUsd: 0.25,
      sessions: 1,
      mainTurns: 9,
      mainExecutionMs: 1200,
      packsServed: 1,
      mainReads: 1,
      mainSuppliedRereads: 2,
      mainSuppliedSearches: 1,
    });
  });

  it('validates runner output at the process boundary', () => {
    const output = {
      findings: [{ path: 'src/example.ts', line: 0, severity: 'P2', title: 'Example' }],
      telemetry: '',
      costUsd: 0,
    };
    assert.equal(isBenchmarkRunnerOutput(output), true);
    assert.equal(
      isBenchmarkRunnerOutput({ ...output, findings: [{ ...output.findings[0], line: -1 }] }),
      false,
    );
    assert.equal(isBenchmarkRunnerOutput({ ...output, findings: [null] }), false);
    assert.equal(isBenchmarkRunnerOutput({ ...output, telemetry: [] }), false);
  });
});
