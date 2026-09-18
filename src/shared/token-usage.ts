import { isFiniteNumber } from './text.ts';

export interface TokenUsageInfo {
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface PromptTokenUsage {
  /** Attempted prompt text; excludes backend system prompts, tools, and history. */
  promptBytes?: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  creditCost?: number;
  acuCost?: number;
}

export type TokenUsageRecorder = (
  usage: PromptTokenUsage | { promptBytes: number },
  model: string,
  label?: string,
) => void;

export function extractPromptTokenUsage(info: TokenUsageInfo): PromptTokenUsage | undefined {
  const tokens = info.tokens;
  if (!tokens) return undefined;
  const cache = tokens.cache ?? {};
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: cache.read ?? 0,
    cacheWrite: cache.write ?? 0,
    ...(isFiniteNumber(info.cost) ? { costUsd: info.cost } : {}),
  };
}

/** One-line token/cost summary. cache.read > 0 on a later shard or re-review means prompt caching hit. */
export function formatTokenUsage(info: TokenUsageInfo): string {
  const tokens = info.tokens ?? {};
  const cache = tokens.cache ?? {};
  const parts = [
    `input=${tokens.input ?? 0}`,
    `output=${tokens.output ?? 0}`,
    `reasoning=${tokens.reasoning ?? 0}`,
    `cache(read=${cache.read ?? 0} write=${cache.write ?? 0})`,
  ];
  if (isFiniteNumber(info.cost)) parts.push(`cost=$${info.cost.toFixed(4)}`);
  return `tokens: ${parts.join(' ')}`;
}
