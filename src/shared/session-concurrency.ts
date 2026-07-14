import type { SemaphorePriority, TokenUsageRecorder } from './opencode.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

export interface ReviewBackend {
  name: string;
  runReview(
    model: string,
    prContext: string,
    guidelines: string,
    log: (msg: string) => void,
    options?: {
      lensAddendum?: string;
      label?: string;
      timeoutMs?: number;
      onTokenUsage?: TokenUsageRecorder;
      evidenceQuotes?: boolean;
    },
  ): Promise<ReviewResult>;
  runAddressedPriorCommentsCheck(
    model: string,
    prContext: string,
    log: (msg: string) => void,
    timeoutMs?: number,
    onTokenUsage?: TokenUsageRecorder,
  ): Promise<AddressedPriorComment[]>;
  runGuidelineComplianceCheck(
    model: string,
    prContext: string,
    guidelines: string,
    log: (msg: string) => void,
    timeoutMs?: number,
    onTokenUsage?: TokenUsageRecorder,
  ): Promise<Finding[]>;
  runFindingVerification(
    model: string,
    prContext: string,
    findings: Finding[],
    log: (msg: string) => void,
    timeoutMs?: number,
    onTokenUsage?: TokenUsageRecorder,
  ): Promise<FindingVerdict[] | undefined>;
  runChangesSinceLastReview(
    model: string,
    prContext: string,
    deltaContext: string,
    log: (msg: string) => void,
    timeoutMs?: number,
    onTokenUsage?: TokenUsageRecorder,
  ): Promise<string>;
}

export interface SessionSlots {
  acquire(priority?: SemaphorePriority): Promise<() => void>;
}

function limitBackend(
  backend: ReviewBackend,
  slots: SessionSlots | undefined,
  priority: SemaphorePriority,
): ReviewBackend {
  if (!slots) return backend;
  const withSlot = async <T>(run: () => Promise<T>): Promise<T> => {
    const release = await slots.acquire(priority);
    try {
      return await run();
    } finally {
      release();
    }
  };
  return {
    name: backend.name,
    runReview: (...args) => withSlot(() => backend.runReview(...args)),
    runAddressedPriorCommentsCheck: (...args) =>
      withSlot(() => backend.runAddressedPriorCommentsCheck(...args)),
    runGuidelineComplianceCheck: (...args) =>
      withSlot(() => backend.runGuidelineComplianceCheck(...args)),
    runFindingVerification: (...args) => withSlot(() => backend.runFindingVerification(...args)),
    runChangesSinceLastReview: (...args) =>
      withSlot(() => backend.runChangesSinceLastReview(...args)),
  };
}

export function limitReviewBackendSessions(
  backend: ReviewBackend,
  role: 'main' | 'aux',
  globalSlots: SessionSlots | undefined,
  providerSlots?: SessionSlots,
): ReviewBackend {
  const priority = role === 'main' ? 'high' : 'normal';
  const globallyLimited = limitBackend(backend, globalSlots, priority);
  // Provider-local queues stay outside the global limiter so their waiters do not consume it.
  return limitBackend(globallyLimited, providerSlots, priority);
}
