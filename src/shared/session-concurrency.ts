import type { ExplorationPlan } from './exploration-policy.ts';
import type { SemaphorePriority, TokenUsageRecorder } from './opencode.ts';
import {
  classifyTelemetryStopReason,
  type BackendTelemetryCapability,
  type PhaseTelemetryTracker,
} from './telemetry.ts';
import type { ToolTelemetryAccumulator } from './tool-telemetry.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

export interface ReviewBackend {
  name: string;
  observability?: BackendTelemetryCapability;
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
      embeddedFirstPrompt?: boolean;
      /** Enforced only by backends whose capability is `enforceable`. */
      exploration?: ExplorationPlan;
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
    /**
     * TASK-157: the verifier's own model options (effort floored at the main
     * pass). Passed only when the aux entry does not already deliver them;
     * backends without per-session option support ignore it.
     */
    modelOptions?: Record<string, unknown>,
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
  telemetry?: { phases: PhaseTelemetryTracker; tools: ToolTelemetryAccumulator },
): ReviewBackend {
  if (!globalSlots && !providerSlots && !telemetry) return backend;
  const rolePriority = role === 'main' ? 'high' : 'normal';
  const withSlots = async <T>(
    session: string,
    run: () => Promise<T>,
    priority: SemaphorePriority = rolePriority,
    budgetTier: 'single-shot' | 'observe-only' = 'observe-only',
  ): Promise<T> => {
    let providerRelease: (() => void) | undefined;
    let globalRelease: (() => void) | undefined;
    const queueDone = telemetry?.phases.start({
      phase: role === 'main' ? 'main-queue' : 'auxiliary-queue',
      scope: 'session',
      session,
      backend: backend.name,
    });
    try {
      providerRelease = providerSlots ? await providerSlots.acquire(priority) : undefined;
      globalRelease = globalSlots ? await globalSlots.acquire(priority) : undefined;
      queueDone?.();
      const executionDone = telemetry?.phases.start({
        phase: role === 'main' ? 'main-execution' : 'auxiliary-execution',
        scope: 'session',
        session,
        backend: backend.name,
      });
      try {
        const result = await run();
        executionDone?.();
        telemetry?.tools.finishSession({
          session,
          backend: backend.name,
          capability: backend.observability ?? 'opaque',
          budgetTier,
          stopReason: 'completed',
          ...((backend.observability ?? 'opaque') === 'opaque'
            ? { explorationMode: 'unavailable' as const }
            : {}),
        });
        return result;
      } catch (error) {
        const stopReason = classifyTelemetryStopReason(error);
        executionDone?.(stopReason);
        telemetry?.tools.finishSession({
          session,
          backend: backend.name,
          capability: backend.observability ?? 'opaque',
          budgetTier,
          stopReason,
          ...((backend.observability ?? 'opaque') === 'opaque'
            ? { explorationMode: 'unavailable' as const }
            : {}),
        });
        throw error;
      }
    } catch (error) {
      queueDone?.(classifyTelemetryStopReason(error));
      throw error;
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
    observability: backend.observability,
    runReview: (...args) => withSlots(args[4]?.label ?? 'review', () => backend.runReview(...args)),
    runAddressedPriorCommentsCheck: (...args) =>
      withSlots('addressed-prior-comments', () => backend.runAddressedPriorCommentsCheck(...args)),
    runGuidelineComplianceCheck: (...args) =>
      withSlots('guideline-compliance', () => backend.runGuidelineComplianceCheck(...args)),
    // The one auxiliary call the posting path awaits: never queue it behind
    // recall sessions still holding slots past the settle grace.
    runFindingVerification: (...args) =>
      withSlots(
        'finding-verification',
        () => backend.runFindingVerification(...args),
        'high',
        'single-shot',
      ),
    runChangesSinceLastReview: (...args) =>
      withSlots('changes-since-last-review', () => backend.runChangesSinceLastReview(...args)),
  };
}
