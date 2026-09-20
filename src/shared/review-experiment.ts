import type { EvidenceReuseOptions } from './evidence.ts';
import type { JevPrefetchMode } from './jev-prefetch.ts';

export interface ReviewExperiment {
  preset: 'off' | 'diff-batches' | 'linked' | 'jev' | 'custom';
  jevPrefetch: JevPrefetchMode;
  explorationEvidence: JevPrefetchMode;
  verificationEvidence: JevPrefetchMode;
  reuse: EvidenceReuseOptions;
  docsPath?: string;
  exploration: {
    retrieval: boolean;
    checkpoints: boolean;
    readEvidence: boolean | 'linked';
    readEvidencePhase: 'all' | 'review' | 'verification';
    batchDiffRecovery: boolean;
  };
}

export function reviewExperiment(env: NodeJS.ProcessEnv = process.env): ReviewExperiment {
  const value = env.JBOT_REVIEW_EXPERIMENT ?? 'diff-batches';
  const preset = value === 'diff-batches' || value === 'linked' || value === 'jev' ? value : 'off';
  return {
    preset,
    jevPrefetch: preset === 'jev' ? 'on' : 'off',
    explorationEvidence: 'off',
    verificationEvidence: 'deterministic',
    reuse: { shared: false, handoff: false, prefetch: false },
    exploration: {
      retrieval: false,
      checkpoints: false,
      readEvidence: preset === 'linked' ? 'linked' : false,
      readEvidencePhase: preset === 'linked' ? 'review' : 'all',
      batchDiffRecovery: preset === 'diff-batches',
    },
  };
}
