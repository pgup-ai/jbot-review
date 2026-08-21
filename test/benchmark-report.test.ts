import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkBenchmarkMergeGate } from '../src/shared/benchmark-report.ts';

const arm = () => ({
  configuration: {
    model: 'zai-coding-plan/glm-5.2',
    modelRevision: 'glm-5.2-2026-08-20',
    engine: 'opencode',
  },
  successfulRuns: 24,
});

const summary = (over: Record<string, unknown> = {}) => ({
  treatmentCommit: 'dfdea5e',
  corpusHash: 'sha256:0922596007e29b4a93ce114fd170aeaa5685d12650b921bb595d44eb65ef7197',
  rollback: 'unset JBOT_EMBEDDED_FIRST_PROMPT',
  control: arm(),
  treatment: arm(),
  qualityGate: { status: 'passed', passed: true },
  pairedLatency: { medianRelativeDelta: -12.4, minimumDetectableEffect: 10 },
  ...over,
});

describe('checkBenchmarkMergeGate', () => {
  it('passes a report that says what ran, how it scored, and how to undo it', () => {
    assert.deepEqual(checkBenchmarkMergeGate(summary()), { satisfied: true, missing: [] });
  });

  it('names each element the report still owes', () => {
    const missing = (over: Record<string, unknown>) =>
      checkBenchmarkMergeGate(summary(over)).missing;

    assert.deepEqual(missing({ treatmentCommit: '  ' }), ['treatment commit']);
    assert.deepEqual(missing({ corpusHash: undefined }), ['corpus hash']);
    assert.deepEqual(missing({ rollback: undefined }), ['rollback instruction']);
    assert.deepEqual(missing({ treatment: { configuration: {}, successfulRuns: 24 } }), [
      'model/config tuple for both arms',
    ]);
    // A run population of zero is not a sample size.
    assert.deepEqual(missing({ control: { ...arm(), successfulRuns: 0 } }), [
      'sample size for both arms',
    ]);
  });

  it('rejects an unadjudicated quality gate as no quality result', () => {
    assert.deepEqual(
      checkBenchmarkMergeGate(
        summary({ qualityGate: { status: 'adjudication-required', passed: null } }),
      ).missing,
      ['quality result'],
    );
  });

  it('rejects a latency claim its sample cannot resolve', () => {
    // A point estimate with no detectable effect is the Phase 3 trap: the
    // number reads as a result while the design could never produce one.
    assert.deepEqual(
      checkBenchmarkMergeGate(
        summary({ pairedLatency: { medianRelativeDelta: -28.2, minimumDetectableEffect: null } }),
      ).missing,
      ['a sample that can resolve any latency effect'],
    );
    assert.deepEqual(
      checkBenchmarkMergeGate(summary({ pairedLatency: { medianRelativeDelta: null } })).missing,
      ['latency result'],
    );
  });

  it('reports everything missing at once rather than the first failure', () => {
    const gate = checkBenchmarkMergeGate({});
    assert.equal(gate.satisfied, false);
    assert.ok(gate.missing.length >= 5, `only reported ${gate.missing.join(', ')}`);
  });
});
