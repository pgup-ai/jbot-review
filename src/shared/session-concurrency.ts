import type { GuidelineSweep } from './guideline-sweep.ts';
import {
  Semaphore,
  withTimeout,
  type SemaphorePriority,
  type TokenUsageRecorder,
} from './opencode.ts';
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
  canReadWorkspace?: boolean;
  supportsGuidelineSweep?: boolean;
  runReview(
    model: string,
    prContext: string,
    guidelines: string,
    log: (msg: string) => void,
    options?: {
      guidelineSweep?: GuidelineSweep;
      deadlineAt?: number;
      lensAddendum?: string;
      contextFirst?: boolean;
      label?: string;
      timeoutMs?: number;
      onTokenUsage?: TokenUsageRecorder;
      evidenceQuotes?: boolean;
      embeddedFirstPrompt?: boolean;
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
    deltaContext: string,
    log: (msg: string) => void,
    timeoutMs?: number,
    onTokenUsage?: TokenUsageRecorder,
  ): Promise<string>;
  /**
   * TASK-076: best-effort abort of this backend's in-flight sessions for a
   * prompt label, called when the settle grace abandons an auxiliary result.
   * Absent on backends without abort support; callers feature-test. Returns
   * the number of sessions signalled: 0 means everything under the label had
   * already settled.
   */
  abortSessionsByLabel?(label: string, log: (msg: string) => void): number;
}

export interface SessionSlots {
  acquire(priority?: SemaphorePriority, signal?: AbortSignal): Promise<() => void>;
}

export function createProviderSessionLimiters(
  providerIDs: string[],
  concurrencyFor: (providerID: string) => number | undefined,
): {
  configured: Array<{ providerID: string; limit: number }>;
  forProvider: (providerID: string) => SessionSlots | undefined;
} {
  const limiters = new Map<string, { limit: number; slots: SessionSlots }>();
  for (const providerID of new Set(providerIDs)) {
    const limit = concurrencyFor(providerID);
    if (limit !== undefined) limiters.set(providerID, { limit, slots: new Semaphore(limit) });
  }
  return {
    configured: [...limiters].map(([providerID, { limit }]) => ({ providerID, limit })),
    forProvider: (providerID) => limiters.get(providerID)?.slots,
  };
}

export function limitReviewBackendSessions(
  backend: ReviewBackend,
  role: 'main' | 'aux',
  globalSlots: SessionSlots | undefined,
  providerSlots?: SessionSlots,
  telemetry?: { phases: PhaseTelemetryTracker; tools: ToolTelemetryAccumulator },
): ReviewBackend {
  const pending = new Map<AbortController, string>();
  const rolePriority = role === 'main' ? 'high' : 'normal';
  const withSlots = async <T>(
    session: string,
    run: () => Promise<T>,
    priority: SemaphorePriority = rolePriority,
    budget?: { timeoutMs: number; deadlineAt?: number; log: (message: string) => void },
  ): Promise<T> => {
    const controller = new AbortController();
    pending.set(controller, session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<T> | undefined;
    let timedOut = false;
    if (budget?.deadlineAt !== undefined)
      timer = setTimeout(
        () => controller.abort(new Error(`${session} deadline expired while queued`)),
        Math.max(0, budget.deadlineAt - Date.now()),
      );
    let providerRelease: (() => void) | undefined;
    let globalRelease: (() => void) | undefined;
    const queueDone = telemetry?.phases.start({
      phase: role === 'main' ? 'main-queue' : 'auxiliary-queue',
      scope: 'session',
      session,
      backend: backend.name,
    });
    try {
      providerRelease = providerSlots
        ? await providerSlots.acquire(priority, controller.signal)
        : undefined;
      controller.signal.throwIfAborted();
      globalRelease = globalSlots
        ? await globalSlots.acquire(priority, controller.signal)
        : undefined;
      controller.signal.throwIfAborted();
      pending.delete(controller);
      clearTimeout(timer);
      if (budget?.deadlineAt !== undefined && budget.deadlineAt <= Date.now())
        throw new Error(`${session} deadline expired while queued`);
      queueDone?.();
      const executionDone = telemetry?.phases.start({
        phase: role === 'main' ? 'main-execution' : 'auxiliary-execution',
        scope: 'session',
        session,
        backend: backend.name,
      });
      try {
        running = run();
        const result = budget
          ? await withTimeout(
              running,
              Math.max(0, Math.min(budget.timeoutMs, (budget.deadlineAt ?? Infinity) - Date.now())),
              `${session} timed out`,
              () => {
                timedOut = true;
                backend.abortSessionsByLabel?.(session, budget.log);
              },
            )
          : await running;
        executionDone?.();
        telemetry?.tools.finishSession({
          session,
          backend: backend.name,
          capability: backend.observability ?? 'opaque',
          budgetTier: 'observe-only',
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
          budgetTier: 'observe-only',
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
      clearTimeout(timer);
      pending.delete(controller);
      const release = async () => {
        providerRelease?.();
        // Let the next provider waiter enter the global queue before releasing its slot.
        if (providerRelease && globalRelease)
          await new Promise<void>((resolve) => queueMicrotask(resolve));
        globalRelease?.();
      };
      // Timeout ends the caller's wait, not ownership of the still-running provider work.
      if (timedOut && running) void running.then(release, release);
      else await release();
    }
  };
  return {
    name: backend.name,
    observability: backend.observability,
    canReadWorkspace: backend.canReadWorkspace,
    supportsGuidelineSweep: backend.supportsGuidelineSweep,
    abortSessionsByLabel: (label, log) => {
      let queued = 0;
      for (const [controller, session] of pending) {
        if (session !== label || controller.signal.aborted) continue;
        controller.abort(new Error(`${label} aborted while queued`));
        queued++;
      }
      return queued + (backend.abortSessionsByLabel?.(label, log) ?? 0);
    },
    runReview: (model, context, guidelines, log, options) => {
      const budget =
        options?.label === 'review-interactions' || options?.deadlineAt !== undefined
          ? {
              timeoutMs: Math.min(
                options.label === 'review-interactions' ? 600_000 : Infinity,
                options.timeoutMs ?? Infinity,
              ),
              deadlineAt: options.deadlineAt,
              log,
            }
          : undefined;
      return withSlots(
        options?.label ?? 'review',
        () =>
          backend.runReview(
            model,
            context,
            guidelines,
            log,
            budget
              ? {
                  ...options,
                  timeoutMs: Math.max(
                    0,
                    Math.min(budget.timeoutMs, (budget.deadlineAt ?? Infinity) - Date.now()),
                  ),
                }
              : options,
          ),
        rolePriority,
        budget,
      );
    },
    runAddressedPriorCommentsCheck: (...args) =>
      withSlots('addressed-prior-comments', () => backend.runAddressedPriorCommentsCheck(...args)),
    runGuidelineComplianceCheck: (...args) =>
      withSlots('guideline-compliance', () => backend.runGuidelineComplianceCheck(...args)),
    // The one auxiliary call the posting path awaits: never queue it behind
    // recall sessions still holding slots past the settle grace.
    runFindingVerification: (...args) =>
      withSlots('finding-verification', () => backend.runFindingVerification(...args), 'high'),
    runChangesSinceLastReview: (...args) =>
      withSlots('changes-since-last-review', () => backend.runChangesSinceLastReview(...args)),
  };
}
