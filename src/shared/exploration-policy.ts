import type { JevCandidate } from './prompt.ts';

export interface ExplorationProgress {
  requests: number;
  outputBytes: number;
  repeatedResults: number;
}

export function explorationCheckpoint(
  current: ExplorationProgress,
  previous: ExplorationProgress,
): 'turns' | 'bytes' | 'repetition' | undefined {
  if (current.requests - previous.requests < 2) return undefined;
  if (current.repeatedResults - previous.repeatedResults >= 2) return 'repetition';
  if (current.outputBytes - previous.outputBytes >= 32 * 1024) return 'bytes';
  if (current.requests - previous.requests >= 8) return 'turns';
  return undefined;
}

export function readEvidenceSession(phase: 'all' | 'review' | 'verification', label?: string) {
  if (phase === 'all') return true;
  if (phase === 'verification') return label === 'finding-verification';
  return /^review(?:-shard-\d+)?(?:-retry)?$/.test(label ?? '');
}

export function selectReadEvidence(
  candidates: JevCandidate[],
  path: string,
  knownPaths: ReadonlySet<string>,
) {
  const selected: JevCandidate[] = [];
  const paths = new Set(knownPaths);
  for (const c of candidates) {
    if (c.relatedTo !== path || c.path === path || paths.has(c.path)) continue;
    selected.push(c);
    paths.add(c.path);
    if (selected.length === 2) break;
  }
  return selected;
}

export function readExplorationStats(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, number> = {};
  for (const key of [
    'checkpoints',
    'turnCheckpoints',
    'byteCheckpoints',
    'repetitionCheckpoints',
    'retrievalCalls',
    'retrievalFallbacks',
    'selectedCandidates',
    'candidates',
    'preparationMs',
  ]) {
    const n = (value as Record<string, unknown>)[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
    result[key] = n;
  }
  for (const key of [
    'readEvidenceAttempts',
    'readEvidencePackets',
    'readEvidenceBytes',
    'readEvidenceFallbacks',
    'readEvidencePreparationMs',
    'readEvidenceDeliveredFiles',
    'readEvidenceObservedReads',
    'readEvidenceSubsequentReads',
    'readEvidenceUnclassifiedShellCalls',
    'readEvidenceExcludedCandidates',
    'readEvidenceEmptyPackets',
  ]) {
    const n = (value as Record<string, unknown>)[key];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
    result[key] = n;
  }
  return result;
}
