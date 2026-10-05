import type { EvidenceReuseOptions } from './evidence.ts';
import type { JevPrefetchMode } from './jev-prefetch.ts';

export interface ReviewExperiment {
  preset:
    | 'off'
    | 'diff-batches'
    | 'linked'
    | 'jev'
    | 'adaptive'
    | 'context-pack'
    | 'state-evidence'
    | 'state-proof'
    | 'verified-support'
    | 'custom';
  contextPack: boolean;
  verificationRetrieval: boolean;
  verificationProof: boolean;
  generateVerificationSupport: boolean;
  jevPrefetch: JevPrefetchMode;
  explorationEvidence: JevPrefetchMode;
  verificationEvidence: JevPrefetchMode;
  reuse: EvidenceReuseOptions;
  docsPath?: string;
  exploration: {
    checkpoints: boolean;
    readEvidence: boolean | 'linked';
    readEvidencePhase: 'all' | 'review' | 'verification';
    batchDiffRecovery: boolean;
  };
}

/** Only opencode has tool-less lens and verification modes; a single-shot model is tool-less already. */
export function toolLessAuxiliary(
  experiment: Pick<ReviewExperiment, 'contextPack'>,
  backend: string,
  agenticModel: boolean,
): boolean {
  return experiment.contextPack && backend === 'opencode' && agenticModel;
}

export function reviewExperiment(env: NodeJS.ProcessEnv = process.env): ReviewExperiment {
  // An unset repository variable arrives as '' and must keep the default.
  const value = env.JBOT_REVIEW_EXPERIMENT || 'context-pack';
  const preset =
    value === 'diff-batches' ||
    value === 'linked' ||
    value === 'jev' ||
    value === 'adaptive' ||
    value === 'context-pack' ||
    value === 'state-evidence' ||
    value === 'state-proof' ||
    value === 'verified-support'
      ? value
      : 'off';
  const contextPack = [
    'context-pack',
    'state-evidence',
    'state-proof',
    'verified-support',
  ].includes(preset);
  return {
    preset,
    contextPack,
    verificationRetrieval: ['state-evidence', 'state-proof', 'verified-support'].includes(preset),
    verificationProof: preset === 'state-proof',
    generateVerificationSupport: preset === 'verified-support',
    jevPrefetch: preset === 'jev' ? 'on' : 'off',
    explorationEvidence: 'off',
    verificationEvidence: 'off',
    reuse: { shared: false, handoff: false, prefetch: false },
    exploration: {
      checkpoints: false,
      readEvidence: preset === 'linked' ? 'linked' : false,
      readEvidencePhase: preset === 'linked' ? 'review' : 'all',
      batchDiffRecovery: preset === 'diff-batches' || preset === 'adaptive' || contextPack,
    },
  };
}
