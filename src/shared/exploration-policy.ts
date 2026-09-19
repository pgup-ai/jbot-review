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

export function explorationExperiment(env: NodeJS.ProcessEnv) {
  return {
    retrieval: env.JBOT_TARGETED_RETRIEVAL === '1',
    checkpoints: env.JBOT_EXPLORATION_CHECKPOINTS === '1',
  };
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
  return result;
}
