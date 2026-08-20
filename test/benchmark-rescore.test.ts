import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { BenchmarkArm, BenchmarkCase } from '../src/shared/benchmark-manifest.ts';
import {
  validateAdjudicatedBenchmarkRows,
  type BenchmarkCaseRow,
} from '../src/shared/benchmark-rescore.ts';

const benchmarkCase: BenchmarkCase = {
  id: 'case-1',
  riskTier: 'low',
  cacheState: 'uncached',
  diffSize: 'small',
  expectedClean: true,
  expectedFindings: [],
  categories: ['clean'],
  subsets: ['full'],
  fixturePath: 'fixture.json',
  base: 'base',
  head: 'head',
};
const arms = {
  control: { name: 'control' } as BenchmarkArm,
  treatment: { name: 'treatment' } as BenchmarkArm,
};
const row: BenchmarkCaseRow = {
  schemaVersion: 2,
  arm: 'control',
  armName: 'control',
  repetition: 1,
  base: 'base',
  head: 'head',
  caseId: 'case-1',
  riskTier: 'low',
  cacheState: 'uncached',
  diffSize: 'small',
  expectedClean: true,
  expectedFindings: [],
  findings: [],
  latencyMs: 1,
  costUsd: 0,
  exitCode: 0,
  signal: null,
  timedOut: false,
  failureClass: null,
  program: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    sessions: 0,
  },
};

it('rejects duplicate, contradictory, and incomplete rescore execution data', () => {
  const treatment = { ...row, arm: 'treatment', armName: 'treatment' } as const;
  const baseline = [row, treatment];
  assert.throws(
    () => validateAdjudicatedBenchmarkRows([row, row], baseline, [benchmarkCase], arms, 1),
    /Duplicate adjudicated benchmark row/,
  );
  assert.throws(
    () =>
      validateAdjudicatedBenchmarkRows(
        [row, { ...row, arm: 'treatment', armName: 'treatment', exitCode: 1 }],
        baseline,
        [benchmarkCase],
        arms,
        1,
      ),
    /Contradictory execution data/,
  );
  assert.throws(
    () =>
      validateAdjudicatedBenchmarkRows(
        [row, { ...row, arm: 'treatment', armName: 'treatment', failureClass: 'runner-exit' }],
        baseline,
        [benchmarkCase],
        arms,
        1,
      ),
    /Contradictory execution data/,
  );
  const missingFailureClass = { ...row } as Partial<BenchmarkCaseRow>;
  delete missingFailureClass.failureClass;
  assert.throws(
    () =>
      validateAdjudicatedBenchmarkRows(
        [missingFailureClass, { ...row, arm: 'treatment', armName: 'treatment' }],
        baseline,
        [benchmarkCase],
        arms,
        1,
      ),
    /Invalid execution data/,
  );
});

it('permits only finding adjudication changes from the original run', () => {
  const sourceFinding = { path: 'a.ts', line: 1, severity: 'P2', title: 'Finding' } as const;
  const treatment = { ...row, arm: 'treatment', armName: 'treatment' } as const;
  const baseline = [{ ...row, findings: [sourceFinding] }, treatment];
  assert.doesNotThrow(() =>
    validateAdjudicatedBenchmarkRows(
      [
        {
          ...row,
          findings: [
            {
              ...sourceFinding,
              expectedFindingId: 'expected',
              triggerComplete: true,
              evidenceSupported: true,
            },
          ],
        },
        treatment,
      ],
      baseline,
      [benchmarkCase],
      arms,
      1,
    ),
  );
  for (const changed of [
    { ...row, findings: [{ ...sourceFinding, title: 'Edited' }] },
    { ...row, findings: [sourceFinding], latencyMs: 2 },
    { ...row, findings: [sourceFinding], exitCode: 1, failureClass: 'runner-exit' as const },
  ]) {
    assert.throws(
      () =>
        validateAdjudicatedBenchmarkRows([changed, treatment], baseline, [benchmarkCase], arms, 1),
      /changed original run data/,
    );
  }
});

it('validates every process failure execution state', () => {
  const cases = [
    {
      failureClass: 'timeout',
      valid: { exitCode: null, signal: 'SIGTERM', timedOut: true },
      invalid: { exitCode: null, signal: null, timedOut: true },
    },
    {
      failureClass: 'signal',
      valid: { exitCode: null, signal: 'SIGTERM', timedOut: false },
      invalid: { exitCode: null, signal: 'SIGTERM', timedOut: true },
    },
    {
      failureClass: 'setup',
      valid: { exitCode: null, signal: null, timedOut: false },
      invalid: { exitCode: 1, signal: null, timedOut: false },
    },
    {
      failureClass: 'spawn',
      valid: { exitCode: null, signal: null, timedOut: false },
      invalid: { exitCode: 1, signal: null, timedOut: false },
    },
  ] as const;
  for (const candidate of cases) {
    const treatment = { ...row, arm: 'treatment', armName: 'treatment' } as const;
    assert.doesNotThrow(() =>
      validateAdjudicatedBenchmarkRows(
        [{ ...row, failureClass: candidate.failureClass, ...candidate.valid }, treatment],
        [{ ...row, failureClass: candidate.failureClass, ...candidate.valid }, treatment],
        [benchmarkCase],
        arms,
        1,
      ),
    );
    assert.throws(
      () =>
        validateAdjudicatedBenchmarkRows(
          [{ ...row, failureClass: candidate.failureClass, ...candidate.invalid }, treatment],
          [{ ...row, failureClass: candidate.failureClass, ...candidate.invalid }, treatment],
          [benchmarkCase],
          arms,
          1,
        ),
      /Contradictory execution data/,
    );
  }
});
