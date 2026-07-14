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

export function limitReviewBackendSessions(
  backend: ReviewBackend,
  role: 'main' | 'aux',
  globalSlots: SessionSlots | undefined,
  providerSlots?: SessionSlots,
): ReviewBackend {
  if (!globalSlots && !providerSlots) return backend;
  const priority = role === 'main' ? 'high' : 'normal';
  const withSlots = async <T>(run: () => Promise<T>): Promise<T> => {
    let providerRelease: (() => void) | undefined;
    let globalRelease: (() => void) | undefined;
    try {
      providerRelease = providerSlots ? await providerSlots.acquire(priority) : undefined;
      globalRelease = globalSlots ? await globalSlots.acquire(priority) : undefined;
      return await run();
    } finally {
      providerRelease?.();
      // Let the next provider waiter enter the global priority queue before releasing the global slot.
      if (providerRelease && globalRelease) {
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
      globalRelease?.();
    }
  };
  return {
    name: backend.name,
    runReview: (...args) => withSlots(() => backend.runReview(...args)),
    runAddressedPriorCommentsCheck: (...args) =>
      withSlots(() => backend.runAddressedPriorCommentsCheck(...args)),
    runGuidelineComplianceCheck: (...args) =>
      withSlots(() => backend.runGuidelineComplianceCheck(...args)),
    runFindingVerification: (...args) => withSlots(() => backend.runFindingVerification(...args)),
    runChangesSinceLastReview: (...args) =>
      withSlots(() => backend.runChangesSinceLastReview(...args)),
  };
}
