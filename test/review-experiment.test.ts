import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewExperiment } from '../src/shared/review-experiment.ts';
import { normalizeOptions } from '../src/shared/runner.ts';
import { runConfiguration } from '../src/shared/run-telemetry.ts';

test('one preset isolates measured treatments and stale flags cannot reactivate them', () => {
  const stale = {
    JBOT_JEV_PREFETCH: 'on',
    JBOT_EXPLORATION_EVIDENCE: 'on',
    JBOT_VERIFICATION_EVIDENCE: 'on',
    JBOT_EVIDENCE_SHARED: '1',
    JBOT_EVIDENCE_HANDOFF: '1',
    JBOT_EVIDENCE_PREFETCH: '1',
    JBOT_EVIDENCE_CACHE_DIR: '/operator/cache',
    JBOT_EVIDENCE_DOCS: '/operator/docs.json',
    JBOT_TARGETED_RETRIEVAL: '1',
    JBOT_EXPLORATION_CHECKPOINTS: '1',
    JBOT_READ_EVIDENCE: 'linked',
    JBOT_READ_EVIDENCE_PHASE: 'verification',
    JBOT_BATCH_DIFF_RECOVERY: '1',
  };
  const off = reviewExperiment({});
  assert.deepEqual(off, {
    preset: 'off',
    jevPrefetch: 'off',
    explorationEvidence: 'off',
    verificationEvidence: 'off',
    reuse: { shared: false, handoff: false, prefetch: false },
    exploration: {
      retrieval: false,
      checkpoints: false,
      readEvidence: false,
      readEvidencePhase: 'all',
      batchDiffRecovery: false,
    },
  });
  for (const value of [undefined, 'off', 'on', 'custom', 'linked,jev', 'secret'])
    assert.deepEqual(reviewExperiment({ ...stale, JBOT_REVIEW_EXPERIMENT: value }), off);
  const expected = [
    { ...off, preset: 'jev', jevPrefetch: 'on' },
    {
      ...off,
      preset: 'diff-batches',
      exploration: { ...off.exploration, batchDiffRecovery: true },
    },
    {
      ...off,
      preset: 'linked',
      exploration: { ...off.exploration, readEvidence: 'linked', readEvidencePhase: 'review' },
    },
  ];
  const hashes = new Set<string>();
  for (const preset of expected) {
    const experiment = reviewExperiment({ ...stale, JBOT_REVIEW_EXPERIMENT: preset.preset });
    assert.deepEqual(experiment, preset);
    const options = normalizeOptions({ experiment });
    assert.deepEqual(options.experiment, preset);
    const { configuration, configurationHash } = runConfiguration(options, 'opencode/a', stale);
    assert.equal(configuration.reviewExperiment, preset.preset);
    assert.equal(configuration.jevPrefetch, preset.jevPrefetch);
    assert.deepEqual(configuration.explorationExperiment, preset.exploration);
    hashes.add(configurationHash);
  }
  assert.equal(hashes.size, 3);
  off.reuse.shared = true;
  off.exploration.readEvidence = 'linked';
  assert.equal(reviewExperiment({}).reuse.shared, false);
  assert.equal(reviewExperiment({}).exploration.readEvidence, false);
});
