import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_RATE_SAMPLE,
  aggregatePerformance,
  distribution,
  guardedRate,
  parseTelemetryJsonl,
} from '../scripts/review-performance.ts';

describe('review performance aggregation', () => {
  it('uses nearest-rank percentiles', () => {
    assert.deepEqual(distribution([5, 1, 4, 2, 3]), { count: 5, p50: 3, p90: 5, p95: 5 });
  });

  it('refuses rate claims below the documented minimum sample', () => {
    assert.deepEqual(guardedRate(3, MIN_RATE_SAMPLE - 1), {
      numerator: 3,
      denominator: MIN_RATE_SAMPLE - 1,
      rate: null,
      status: 'insufficient-sample',
    });
    assert.equal(guardedRate(5, MIN_RATE_SAMPLE).rate, 0.25);
    assert.deepEqual(guardedRate(0, 0, MIN_RATE_SAMPLE), {
      numerator: 0,
      denominator: 0,
      rate: null,
      status: 'zero-denominator',
    });
  });

  it('aggregates phases, tools, turns, cache, repairs, retained findings, and cohorts', () => {
    const report = aggregatePerformance([
      { kind: 'run', elapsedMs: 100 },
      { kind: 'phase', scope: 'run', phase: 'filtering', durationMs: 10 },
      { kind: 'phase', scope: 'run', phase: 'filtering', durationMs: 15 },
      { kind: 'phase', scope: 'run', phase: 'posting', durationMs: 75 },
      {
        kind: 'tool',
        toolClass: 'diff-recovery',
        outputBytesAfterCap: 50,
        duplicate: false,
      },
      {
        kind: 'exploration',
        backend: 'pi',
        session: 'review',
        turnCount: 2,
        toolCalls: 1,
        toolOutputBytes: 50,
        droppedToolRows: 1,
      },
      { kind: 'exploration', backend: 'opaque', session: 'review-repair' },
      { kind: 'exploration', backend: 'opaque', session: 'review-shard-1-retry' },
      { kind: 'session', session: 'review-repair', cacheReadTokens: 30 },
      { kind: 'session', session: 'review-shard-1-retry' },
      { kind: 'finding', disposition: 'posted-inline' },
    ]);

    assert.equal(report.phaseTime['run:filtering'].p50, 25);
    assert.equal(report.phaseTime['run:posting'].p50, 75);
    assert.equal(report.phaseReconciliation.gapMs.p50, 0);
    assert.equal(report.tools.outputBytes, 50);
    assert.equal(report.tools.droppedRows, 1);
    assert.equal(report.tools.diffRecoveryCallRate.status, 'truncated');
    assert.equal(report.turns.p50, 2);
    assert.equal(report.cacheReadTokens, 30);
    assert.equal(report.retryRepairRate.numerator, 2);
    assert.equal(report.retryRepairRate.rate, null);
    assert.equal(report.retainedFindings, 1);
    assert.equal(report.backendCohorts.pi.toolCalls, 1);
  });

  it('skips malformed JSONL rows without discarding valid telemetry', () => {
    const warnings: string[] = [];
    assert.deepEqual(
      parseTelemetryJsonl('{"kind":"run"}\n{"kind":', 3, (message) => warnings.push(message)),
      [{ kind: 'run', _source: 3 }],
    );
    assert.deepEqual(warnings, ['Skipped malformed telemetry row 2.']);
  });

  it('keeps auxiliary failures and findings tied to their run without requiring token rows', () => {
    const first = [
      {
        kind: 'run',
        runId: 'first',
        model: 'main/a',
        auxModel: 'aux/b',
        identity: { reviewerRevision: 'v1' },
        policy: { configurationHash: 'config-1' },
      },
      {
        kind: 'phase',
        scope: 'session',
        phase: 'auxiliary-queue',
        session: 'review-frontend',
        durationMs: 70,
        stopReason: 'completed',
      },
      {
        kind: 'phase',
        scope: 'session',
        phase: 'auxiliary-execution',
        session: 'review-frontend',
        durationMs: 120,
        stopReason: 'aborted',
      },
      { kind: 'coverage', session: 'review-frontend', state: 'failed', failureClass: 'aborted' },
      { kind: 'coverage', session: 'aux-opencode-boot', state: 'failed', failureClass: 'provider' },
      { kind: 'phase', scope: 'run', phase: 'grace-wait', durationMs: 120 },
    ];
    const second = [
      { kind: 'run', runId: 'second', model: 'main/a', auxModel: 'aux/c' },
      {
        kind: 'phase',
        scope: 'session',
        phase: 'auxiliary-execution',
        session: 'review-frontend',
        durationMs: 30,
        stopReason: 'completed',
      },
      { kind: 'finding', session: 'review-frontend', disposition: 'posted-inline' },
      { kind: 'finding', session: 'review-frontend', disposition: 'deduped' },
    ];
    const { auxiliaryRuns } = aggregatePerformance(
      [first, second, second.filter((row) => row.kind !== 'run')].flatMap((rows, source) =>
        parseTelemetryJsonl(rows.map((row) => JSON.stringify(row)).join('\n'), source),
      ),
    );

    assert.equal(auxiliaryRuns.length, 2);
    assert.equal(auxiliaryRuns[0].identity?.reviewerRevision, 'v1');
    assert.equal(auxiliaryRuns[0].policy?.configurationHash, 'config-1');
    assert.deepEqual(
      auxiliaryRuns[0].coverage.map((row) => row.failureClass),
      ['aborted', 'provider'],
    );
    assert.equal(auxiliaryRuns[0].sessions[0].phases[0].durationMs, 70);
    assert.equal(auxiliaryRuns[0].sessions[0].phases[1].stopReason, 'aborted');
    assert.equal(auxiliaryRuns[0].sessions[0].retainedFindings, 0);
    assert.equal(auxiliaryRuns[1].runId, 'second');
    assert.equal(auxiliaryRuns[1].auxModel, 'aux/c');
    assert.equal(auxiliaryRuns[1].identity, undefined);
    assert.deepEqual(auxiliaryRuns[0].runPhases, [
      { phase: 'grace-wait', durationMs: 120, stopReason: undefined },
    ]);
    assert.deepEqual(auxiliaryRuns[1].runPhases, []);
    assert.equal(auxiliaryRuns[1].sessions[0].producedFindings, 2);
    assert.equal(auxiliaryRuns[1].sessions[0].retainedFindings, 1);
  });
});
