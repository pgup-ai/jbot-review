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
  assert.throws(
    () => validateAdjudicatedBenchmarkRows([row, row], [benchmarkCase], arms, 1),
    /Duplicate adjudicated benchmark row/,
  );
  assert.throws(
    () =>
      validateAdjudicatedBenchmarkRows(
        [row, { ...row, arm: 'treatment', armName: 'treatment', exitCode: 1 }],
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
        [benchmarkCase],
        arms,
        1,
      ),
    /Invalid execution data/,
  );
});
