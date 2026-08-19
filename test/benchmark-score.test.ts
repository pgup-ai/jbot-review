import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertBenchmarkComparable,
  benchmarkConfigurationDifferences,
  scoreBenchmark,
  type BenchmarkCaseRun,
  type BenchmarkConfiguration,
} from '../src/shared/benchmark-score.ts';

const expected = (id: string, severity: 'P0' | 'P1' | 'P2' | 'P3', line: number) => ({
  id,
  severity,
  anchors: [{ path: 'src/a.ts', line }],
});

describe('scoreBenchmark', () => {
  const runs: BenchmarkCaseRun[] = [
    {
      caseId: 'defect',
      riskTier: 'critical',
      expectedClean: false,
      expectedFindings: [expected('p1', 'P1', 10), expected('p3', 'P3', 20)],
      findings: [
        {
          path: 'src/a.ts',
          line: 10,
          severity: 'P1',
          title: 'Suppressed duplicate',
          fingerprint: 'bug',
          retained: false,
        },
        { path: 'src/a.ts', line: 10, severity: 'P1', title: 'Same bug', fingerprint: 'bug' },
        { path: 'src/a.ts', line: 99, severity: 'P2', title: 'Noise', anchored: false },
      ],
      latencyMs: 100,
      costUsd: 0.3,
    },
    {
      caseId: 'clean',
      riskTier: 'low',
      expectedClean: true,
      expectedFindings: [],
      findings: [],
      latencyMs: 300,
      costUsd: 0.1,
    },
  ];

  it('computes the fixed quality, latency, duplicate, and cost formulas', () => {
    const score = scoreBenchmark(runs, { bootstrapSamples: 20, seed: 7 });
    assert.equal(score.severityWeightedRecall.value, 8 / 9);
    assert.equal(score.precision.value, 1 / 2);
    assert.equal(score.cleanFalsePositiveRate.value, 0);
    assert.equal(score.anchorRate.value, 1 / 2);
    assert.equal(score.duplicateRate.value, 1 / 3);
    assert.equal(score.latencyMs.median.value, 200);
    assert.equal(score.latencyMs.p90.value, 280);
    assert.equal(score.latencyMs.p95.value, 290);
    assert.equal(score.costPerRetainedFindingUsd.value, 0.2);
  });

  it('uses an explicit adjudicated id for an allowed alternative anchor', () => {
    const score = scoreBenchmark(
      [
        {
          ...runs[0],
          expectedFindings: [
            {
              ...expected('p1', 'P1', 10),
              anchors: [
                { path: 'src/a.ts', line: 10 },
                { path: 'src/alternative.ts', line: 4 },
              ],
            },
          ],
          findings: [
            {
              path: 'src/alternative.ts',
              line: 4,
              severity: 'P1',
              title: 'Contract break',
              expectedFindingId: 'p1',
            },
          ],
        },
      ],
      { bootstrapSamples: 0 },
    );
    assert.equal(score.severityWeightedRecall.value, 1);
    assert.equal(score.precision.value, 1);
  });

  it('does not let an adjudicated id bypass the allowed anchors', () => {
    const score = scoreBenchmark(
      [
        {
          ...runs[0],
          expectedFindings: [expected('p1', 'P1', 10)],
          findings: [
            {
              path: 'src/alternative.ts',
              line: 4,
              severity: 'P1',
              title: 'Wrong location',
              expectedFindingId: 'p1',
            },
          ],
        },
      ],
      { bootstrapSamples: 0 },
    );
    assert.equal(score.severityWeightedRecall.value, 0);
    assert.equal(score.precision.value, 0);
  });

  it('does not reassign a duplicate explicit match to another expectation', () => {
    const score = scoreBenchmark(
      [
        {
          ...runs[0],
          expectedFindings: [expected('first', 'P1', 10), expected('second', 'P2', 10)],
          findings: [
            {
              path: 'src/a.ts',
              line: 10,
              severity: 'P1',
              title: 'First report',
              fingerprint: 'first-report',
              expectedFindingId: 'first',
            },
            {
              path: 'src/a.ts',
              line: 10,
              severity: 'P1',
              title: 'Duplicate report',
              fingerprint: 'duplicate-report',
              expectedFindingId: 'first',
            },
          ],
        },
      ],
      { bootstrapSamples: 0 },
    );
    assert.equal(score.matchedFindings, 1);
    assert.equal(score.severityWeightedRecall.value, 2 / 3);
    assert.equal(score.precision.value, 1 / 2);
  });

  it('returns null for metrics whose denominators do not exist', () => {
    const score = scoreBenchmark([], { bootstrapSamples: 0 });
    assert.equal(score.severityWeightedRecall.value, null);
    assert.equal(score.precision.value, null);
    assert.equal(score.cleanFalsePositiveRate.value, null);
    assert.equal(score.latencyMs.median.value, null);
  });

  it('produces deterministic bootstrap intervals with a fixed seed', () => {
    const first = scoreBenchmark(runs, { bootstrapSamples: 100, seed: 123 });
    const second = scoreBenchmark(runs, { bootstrapSamples: 100, seed: 123 });
    assert.deepEqual(first, second);
    assert.ok(first.latencyMs.median.ci95);
  });
});

describe('assertBenchmarkComparable', () => {
  const control: BenchmarkConfiguration = {
    model: 'provider/model',
    modelRevision: '2026-08-01',
    engine: 'pi',
    engineVersion: '0.84.0',
    reasoningEffort: 'medium',
    sampling: { temperature: 0 },
    promptVersion: 'abc123',
    corpusHash: 'sha256:corpus',
    config: { reviewShards: 1, contextTrim: false },
  };

  it('permits only the exact declared treatment variable', () => {
    const treatment = { ...control, config: { ...control.config, reviewShards: 2 } };
    assert.deepEqual(benchmarkConfigurationDifferences(control, treatment), [
      'config.reviewShards',
    ]);
    assert.doesNotThrow(() =>
      assertBenchmarkComparable(control, treatment, ['config.reviewShards']),
    );
    assert.doesNotThrow(() =>
      assertBenchmarkComparable(
        control,
        treatment,
        ['config.reviewShards', 'env.JBOT_REVIEW_SHARDS'],
        { JBOT_REVIEW_SHARDS: '1' },
        { JBOT_REVIEW_SHARDS: '2' },
      ),
    );
  });

  it('rejects an undeclared model or reasoning mismatch', () => {
    assert.throws(
      () =>
        assertBenchmarkComparable(
          control,
          { ...control, reasoningEffort: 'low', config: { ...control.config, reviewShards: 2 } },
          ['config.reviewShards'],
        ),
      /reasoningEffort/,
    );
    assert.throws(
      () =>
        assertBenchmarkComparable(control, { ...control, model: 'provider/other' }, [
          'config.reviewShards',
        ]),
      /model/,
    );
  });

  it('rejects a declared variable that did not actually change', () => {
    assert.throws(
      () => assertBenchmarkComparable(control, control, ['config.reviewShards']),
      /did not change/,
    );
  });
});
