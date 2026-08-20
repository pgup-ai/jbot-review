import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pairBenchmarkRuns, summarizePairedBenchmark } from '../src/shared/benchmark-paired.ts';
import type { BenchmarkCaseRow } from '../src/shared/benchmark-rescore.ts';

const row = (
  arm: 'control' | 'treatment',
  caseId: string,
  repetition: number,
  latencyMs: number,
  failureClass: BenchmarkCaseRow['failureClass'] = null,
): BenchmarkCaseRow => ({
  schemaVersion: 2,
  arm,
  armName: arm === 'control' ? 'CTRL' : 'TREAT',
  repetition,
  base: `${caseId}-base`,
  head: `${caseId}-head`,
  caseId,
  riskTier: 'medium',
  expectedClean: false,
  expectedFindings: [],
  findings: [],
  latencyMs,
  exitCode: failureClass === null ? 0 : 1,
  signal: null,
  timedOut: false,
  failureClass,
  program: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    sessions: 1,
  },
});

/** Control latency, then treatment latency, per (case, repetition). */
const rowsFrom = (samples: [string, number, number, number][]): BenchmarkCaseRow[] =>
  samples.flatMap(([caseId, repetition, control, treatment]) => [
    row('control', caseId, repetition, control),
    row('treatment', caseId, repetition, treatment),
  ]);

describe('pairBenchmarkRuns', () => {
  it('pairs by case and repetition, dropping failures and unmatched runs', () => {
    const pairs = pairBenchmarkRuns([
      ...rowsFrom([
        ['a', 1, 100, 80],
        ['a', 2, 200, 150],
      ]),
      row('control', 'b', 1, 100),
      row('treatment', 'b', 1, 50, 'timeout'),
      row('control', 'c', 1, 100),
    ]);

    assert.deepEqual(
      pairs.map((pair) => [pair.caseId, pair.repetition, pair.relativeDelta]),
      [
        ['a', 1, -20],
        ['a', 2, -25],
      ],
    );
  });

  it('reads latency through an override so a caller can pair on the main-session phase', () => {
    const pairs = pairBenchmarkRuns(rowsFrom([['a', 1, 100, 80]]), () => 42);
    assert.equal(pairs[0].relativeDelta, 0);
  });
});

describe('summarizePairedBenchmark', () => {
  it('recovers a consistent shift that case-to-case spread hides', () => {
    // Cases span two orders of magnitude; every one improves by roughly 15%.
    const summary = summarizePairedBenchmark(
      pairBenchmarkRuns(
        rowsFrom([
          ['tiny', 1, 1_000, 820],
          ['tiny', 2, 1_100, 968],
          ['small', 1, 5_000, 4_250],
          ['small', 2, 5_200, 4_420],
          ['big', 1, 40_000, 33_600],
          ['big', 2, 42_000, 35_280],
          ['huge', 1, 90_000, 76_500],
          ['huge', 2, 95_000, 79_800],
        ]),
      ),
    );

    assert.equal(summary.pairs, 8);
    assert.equal(summary.treatmentFaster, 8);
    assert.ok(summary.medianRelativeDelta !== null && summary.medianRelativeDelta < -14);
    assert.ok(summary.medianRelativeDelta > -17);
    assert.ok(summary.ci95 !== null && summary.ci95.high < 0, 'a consistent gain excludes zero');
    assert.ok(summary.permutationP !== null && summary.permutationP < 0.05);
  });

  it('reports no effect when the arms are indistinguishable', () => {
    const summary = summarizePairedBenchmark(
      pairBenchmarkRuns(
        rowsFrom([
          ['a', 1, 1_000, 1_120],
          ['a', 2, 1_100, 980],
          ['b', 1, 5_000, 5_400],
          ['b', 2, 5_200, 4_800],
          ['c', 1, 40_000, 44_000],
          ['c', 2, 42_000, 38_000],
        ]),
      ),
    );

    assert.ok(Math.abs(summary.medianRelativeDelta ?? 0) < 5);
    assert.ok(summary.permutationP !== null && summary.permutationP > 0.2);
  });

  it('reports the smallest effect the sample could have detected', () => {
    const tight = summarizePairedBenchmark(
      pairBenchmarkRuns(
        rowsFrom([
          ['a', 1, 1_000, 900],
          ['a', 2, 1_000, 890],
          ['b', 1, 1_000, 910],
          ['b', 2, 1_000, 905],
          ['c', 1, 1_000, 895],
          ['c', 2, 1_000, 900],
          ['d', 1, 1_000, 908],
          ['d', 2, 1_000, 892],
        ]),
      ),
    );
    const noisy = summarizePairedBenchmark(
      pairBenchmarkRuns(
        rowsFrom([
          ['a', 1, 1_000, 400],
          ['a', 2, 1_000, 1_900],
          ['b', 1, 1_000, 500],
          ['b', 2, 1_000, 1_700],
          ['c', 1, 1_000, 300],
          ['c', 2, 1_000, 2_100],
          ['d', 1, 1_000, 600],
          ['d', 2, 1_000, 1_600],
        ]),
      ),
    );

    assert.ok(tight.minimumDetectableEffect !== null);
    assert.ok(
      noisy.minimumDetectableEffect === null ||
        noisy.minimumDetectableEffect > tight.minimumDetectableEffect,
      'a noisier sample cannot detect as small an effect',
    );
  });

  it('stays silent rather than guessing below two pairs', () => {
    const summary = summarizePairedBenchmark(pairBenchmarkRuns(rowsFrom([['a', 1, 100, 80]])));
    assert.equal(summary.pairs, 1);
    assert.equal(summary.medianRelativeDelta, -20);
    assert.equal(summary.permutationP, null);
    assert.equal(summary.minimumDetectableEffect, null);
  });
});
