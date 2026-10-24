import { parseModelName } from '@symma/protocol';

import type { ReviewBackend } from './session-concurrency.ts';

/**
 * A permanent rejection re-buys the same refusal on every retry, so the session
 * moves to another pool model. Rate limits, outages and timeouts keep their retries.
 */
export type ProviderRejection = 'privacy-setting' | 'credits' | 'region';

export interface ModelRejection {
  model: string;
  rejection: ProviderRejection;
}

export interface ModelFallback extends ModelRejection {
  role: 'main' | 'auxiliary';
  to: string;
}

export function classifyProviderRejection(error: unknown): ProviderRejection | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/trains on request data/i.test(message)) return 'privacy-setting';
  if (/insufficient credits|credits exhausted|credit balance is too low/i.test(message))
    return 'credits';
  if (/not available in your region|geographic use policy/i.test(message)) return 'region';
  return undefined;
}

/**
 * Why `model` is out this run. Credits are the account's, so they take every
 * model on that provider; a privacy setting or regional block names one model,
 * and the account's others still serve.
 */
function rejectionFor(
  model: string,
  rejections: readonly ModelRejection[],
): ModelRejection | undefined {
  const { providerID } = parseModelName(model);
  return rejections.find(
    (rejected) =>
      rejected.model === model ||
      (rejected.rejection === 'credits' &&
        parseModelName(rejected.model).providerID === providerID),
  );
}

/** Pool order after `from`, like a workflow rerun's rotation, skipping excluded models. */
function nextPoolModel(
  pool: readonly string[],
  from: string,
  rejections: readonly ModelRejection[],
): string | undefined {
  const start = pool.indexOf(from) + 1;
  return [...pool.slice(start), ...pool.slice(0, start)].find(
    (model) => model !== from && !rejectionFor(model, rejections),
  );
}

/** The draw to rerun after a rejection, or undefined when nothing excluded has a replacement. */
export function planModelFallback(
  pool: readonly string[],
  draw: { model: string; auxModel: string },
  rejections: readonly ModelRejection[],
): { model: string; auxModel: string; fallbacks: ModelFallback[] } | undefined {
  const fallbacks: ModelFallback[] = [];
  const replace = (role: ModelFallback['role'], model: string) => {
    const rejected = rejectionFor(model, rejections);
    if (!rejected) return model;
    const to = nextPoolModel(pool, model, rejections);
    if (to) fallbacks.push({ role, model, rejection: rejected.rejection, to });
    return to;
  };
  const model = replace('main', draw.model);
  if (!model) return undefined;
  // Defined: the main pick is itself a usable pool model.
  const auxModel = replace('auxiliary', draw.auxModel)!;
  return fallbacks.length ? { model, auxModel, fallbacks } : undefined;
}

/** Main review rejected: the caller reruns the run on another pool draw. */
export class ModelRejectedError extends Error {
  constructor(
    message: string,
    readonly rejections: ModelRejection[],
  ) {
    super(message);
    this.name = 'ModelRejectedError';
  }
}

/**
 * Reroutes an auxiliary backend to an already-running model once its own model
 * is rejected; later sessions skip the rejected model. The fallback model gets
 * its own default options: the aux ones were sized for another model.
 */
export function withModelFallback(
  backend: ReviewBackend,
  model: string,
  fallback: { backend: ReviewBackend; model: string },
  onFallback: (rejection: ModelRejection) => void,
): ReviewBackend {
  let rerouted = false;
  const route = async <T>(primary: () => Promise<T>, secondary: () => Promise<T>) => {
    if (!rerouted) {
      try {
        return await primary();
      } catch (error) {
        const rejection = classifyProviderRejection(error);
        if (!rejection || rejectionFor(fallback.model, [{ model, rejection }])) throw error;
        if (!rerouted) onFallback({ model, rejection });
        rerouted = true;
      }
    }
    return secondary();
  };
  const { backend: to, model: toModel } = fallback;
  return {
    ...backend,
    runReview: (model, context, guidelines, log, options) =>
      route(
        () => backend.runReview(model, context, guidelines, log, options),
        () =>
          to.runReview(toModel, context, guidelines, log, { ...options, modelOptions: undefined }),
      ),
    runAddressedPriorCommentsCheck: (model, ...args) =>
      route(
        () => backend.runAddressedPriorCommentsCheck(model, ...args),
        () => to.runAddressedPriorCommentsCheck(toModel, ...args),
      ),
    runGuidelineComplianceCheck: (
      model,
      context,
      guidelines,
      log,
      timeoutMs,
      onUsage,
      options,
      label,
    ) =>
      route(
        () =>
          backend.runGuidelineComplianceCheck(
            model,
            context,
            guidelines,
            log,
            timeoutMs,
            onUsage,
            options,
            label,
          ),
        () =>
          to.runGuidelineComplianceCheck(
            toModel,
            context,
            guidelines,
            log,
            timeoutMs,
            onUsage,
            undefined,
            label,
          ),
      ),
    runFindingVerification: (
      model,
      context,
      findings,
      log,
      timeoutMs,
      onUsage,
      options,
      mode,
      proof,
    ) =>
      route(
        () =>
          backend.runFindingVerification(
            model,
            context,
            findings,
            log,
            timeoutMs,
            onUsage,
            options,
            mode,
            proof,
          ),
        () =>
          to.runFindingVerification(
            toModel,
            context,
            findings,
            log,
            timeoutMs,
            onUsage,
            undefined,
            mode,
            proof,
          ),
      ),
    runChangesSinceLastReview: (model, ...args) =>
      route(
        () => backend.runChangesSinceLastReview(model, ...args),
        () => to.runChangesSinceLastReview(toModel, ...args),
      ),
    // Both: pages queued on the rejected model still hold their place there.
    abortSessionsByLabel: (label, log) =>
      (backend.abortSessionsByLabel?.(label, log) ?? 0) +
      (to.abortSessionsByLabel?.(label, log) ?? 0),
    finalizeSessionsByLabel: (label, log, budgetMs) =>
      (backend.finalizeSessionsByLabel?.(label, log, budgetMs) ?? 0) +
      (to.finalizeSessionsByLabel?.(label, log, budgetMs) ?? 0),
  };
}
