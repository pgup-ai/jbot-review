import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  benchmarkArmOrder,
  pairBenchmarkRuns,
  summarizePairedBenchmark,
} from '../src/shared/benchmark-paired.ts';
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
});

describe('benchmarkArmOrder', () => {
  it('assigns a stable leader per case without tracking position', () => {
    const ids = Array.from({ length: 200 }, (_, index) => `case-${index}`);
    const leaders = ids.map((id) => benchmarkArmOrder(id, 1)[0]);

    for (const order of ids.map((id) => benchmarkArmOrder(id, 1))) {
      assert.deepEqual([...order].sort(), ['control', 'treatment']);
    }
    // Deterministic: the same case and repetition always lead with the same arm.
    assert.deepEqual(benchmarkArmOrder('case-7', 2), benchmarkArmOrder('case-7', 2));
    // A repetition is its own draw, so a case is not pinned to one arm.
    const perCase = [1, 2, 3, 4].map((rep) => benchmarkArmOrder('case-7', rep)[0]);
    assert.ok(new Set(perCase).size > 1);
    // Roughly balanced, and not the index parity a positional rule would give.
    const controlFirst = leaders.filter((arm) => arm === 'control').length;
    assert.ok(controlFirst > 70 && controlFirst < 130, `control led ${controlFirst}/200`);
    const parity = ids.map((_, index) => (index % 2 === 0 ? 'control' : 'treatment'));
    assert.notDeepEqual(leaders, parity);
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

  it('treats an arm swap the way its permutation test does', () => {
    // Swapping arms maps (T-C)/C to -d/(1+d), not -d, so a sign-flipped
    // relative delta simulates no real relabelling; log ratios negate exactly.
    const samples: [string, number, number, number][] = [
      ['a', 1, 1_000, 700],
      ['b', 1, 5_000, 4_000],
      ['c', 1, 40_000, 52_000],
    ];
    const forward = pairBenchmarkRuns(rowsFrom(samples));
    const swapped = pairBenchmarkRuns(
      rowsFrom(samples.map(([c, r, control, treatment]) => [c, r, treatment, control])),
    );
    for (const [index, pair] of forward.entries()) {
      const mirrored = swapped[index];
      assert.ok(
        Math.abs(
          Math.log(pair.treatmentMs / pair.controlMs) +
            Math.log(mirrored.treatmentMs / mirrored.controlMs),
        ) < 1e-12,
      );
      // The naive sign flip the test must not use.
      assert.ok(Math.abs(pair.relativeDelta + mirrored.relativeDelta) > 1e-6);
    }

    const p = summarizePairedBenchmark(forward).permutationP;
    assert.equal(p, summarizePairedBenchmark(swapped).permutationP);
  });

  it('drops a pair with a zero latency on either arm', () => {
    const pairs = pairBenchmarkRuns([
      ...rowsFrom([['a', 1, 1_000, 800]]),
      ...rowsFrom([['b', 1, 1_000, 0]]),
      ...rowsFrom([['c', 1, 0, 800]]),
    ]);
    assert.deepEqual(
      pairs.map((pair) => pair.caseId),
      ['a'],
    );
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
