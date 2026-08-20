import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MIN_RATE_SAMPLE,
  aggregatePerformance,
  distribution,
  guardedRate,
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
        turnCount: 2,
        toolCalls: 1,
        toolOutputBytes: 50,
      },
      { kind: 'session', session: 'review-repair', cacheReadTokens: 30 },
      { kind: 'finding', disposition: 'posted-inline' },
    ]) as {
      phaseTime: Record<string, { p50: number }>;
      phaseReconciliation: { gapMs: { p50: number } };
      tools: { outputBytes: number };
      turns: { p50: number };
      cacheReadTokens: number;
      retryRepairRate: { numerator: number; rate: number | null };
      retainedFindings: number;
      backendCohorts: Record<string, { toolCalls: number }>;
    };

    assert.equal(report.phaseTime['run:filtering'].p50, 25);
    assert.equal(report.phaseTime['run:posting'].p50, 75);
    assert.equal(report.phaseReconciliation.gapMs.p50, 0);
    assert.equal(report.tools.outputBytes, 50);
    assert.equal(report.turns.p50, 2);
    assert.equal(report.cacheReadTokens, 30);
    assert.equal(report.retryRepairRate.numerator, 1);
    assert.equal(report.retryRepairRate.rate, null);
    assert.equal(report.retainedFindings, 1);
    assert.equal(report.backendCohorts.pi.toolCalls, 1);
  });
});
