/**
 * Main-shard retry policy (TASK-150/155): a deterministic failure re-buys the
 * identical error for up to another finder window (the INC-001 waste class),
 * so only plausibly-transient classes retry. Classification is by message
 * shape — provider errors arrive as strings from a dozen backends — and
 * unknown stays retryable: a wrongly skipped retry loses a review, a wasted
 * one only loses time.
 */

export type MainShardFailureClass =
  | 'auth'
  | 'model-not-found'
  | 'context-length'
  | 'rate-limit'
  | 'timeout'
  | 'parse'
  | 'provider-transient'
  | 'unknown';

const NON_RETRYABLE: ReadonlySet<MainShardFailureClass> = new Set([
  'auth',
  'model-not-found',
  'context-length',
]);

export function classifyMainShardFailure(error: unknown): {
  failureClass: MainShardFailureClass;
  retryable: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  const matches = (pattern: RegExp) => pattern.test(message);
  const failureClass: MainShardFailureClass = matches(
    /\b401\b|\b403\b|unauthorized|invalid.{0,12}(api.?key|token)|authentication/i,
  )
    ? 'auth'
    : matches(/unknown model|model.{0,24}not (found|exist|available)|no such model/i)
      ? 'model-not-found'
      : matches(
            /context.{0,12}length|maximum context|\b413\b|too (large|long)|exceeds.{0,24}(context|token)/i,
          )
        ? 'context-length'
        : matches(/\b429\b|rate.?limit|quota/i)
          ? 'rate-limit'
          : matches(/timed?\s*out|timeout|deadline|did not finish within/i)
            ? 'timeout'
            : matches(/parse|json|schema|repair/i)
              ? 'parse'
              : matches(
                    /\b5\d\d\b|overloaded|upstream|stream|socket|econn|enotfound|fetch failed|network|unavailable|api/i,
                  )
                ? 'provider-transient'
                : 'unknown';
  return { failureClass, retryable: !NON_RETRYABLE.has(failureClass) };
}

/** A retry is pointless below this first-attempt duration — the PR state
 * cannot meaningfully have moved, and the freshness fetch is not free. */
export const STALE_CHECK_MIN_ATTEMPT_MS = 60_000;

/**
 * Thrown instead of retrying when the PR merged, closed, or moved to a new
 * head while the failed attempt ran: the retry's output could never be
 * posted against the reviewed state. Callers classify the run as skipped
 * (`stale-before-retry`), post nothing, and finish telemetry normally.
 */
export class StaleReviewError extends Error {
  constructor(public readonly reason: 'merged' | 'closed' | 'head-moved') {
    super(`stale-before-retry: PR ${reason} while the review was running`);
    this.name = 'StaleReviewError';
  }
}
