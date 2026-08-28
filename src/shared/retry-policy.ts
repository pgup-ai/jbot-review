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
  | 'unsupported-effort'
  | 'rate-limit'
  | 'timeout'
  | 'parse'
  | 'provider-transient'
  | 'unknown';

const NON_RETRYABLE: ReadonlySet<MainShardFailureClass> = new Set([
  'auth',
  'model-not-found',
  'context-length',
  'unsupported-effort',
]);

export function classifyMainShardFailure(error: unknown): {
  failureClass: MainShardFailureClass;
  retryable: boolean;
} {
  const message = error instanceof Error ? error.message : String(error);
  const matches = (pattern: RegExp) => pattern.test(message);
  const failureClass: MainShardFailureClass = matches(
    /\b401\b|\b403\b|unauthorized|(invalid|incorrect).{0,12}(api.?key|token)|authentication/i,
  )
    ? 'auth'
    : matches(/unknown model|model.{0,24}not (found|exist|available)|no such model/i)
      ? 'model-not-found'
      : matches(
            // `too large|long` needs context/size wording nearby: bare "took
            // too long" is a timeout, and misreading it here skips the retry.
            /context.{0,12}length|maximum context|\b413\b|(context|prompt|input|message|tokens?).{0,24}too (large|long)|too (large|long).{0,32}(context|window|tokens?|limit)|exceeds.{0,24}(context|token)/i,
          )
        ? 'context-length'
        : matches(
              // Anchored on the refusal and on the tier NAMES the provider
              // enumerates ("[1210] ... please use low, high, or max"): a generic
              // verb like "please use" would swallow timeouts, which keep retrying.
              /\b(?:reasoning|thinking)\b[\s\S]{0,80}?(?:cannot be disabled|\b(?:minimal|low|medium|high|xhigh|max)\b[\s\S]{0,16}?\b(?:minimal|low|medium|high|xhigh|max)\b)/i,
            )
          ? 'unsupported-effort'
          : matches(/\b429\b|rate.?limit|quota/i)
            ? 'rate-limit'
            : matches(/timed?\s*out|timeout|deadline|did not finish within|took too long/i)
              ? 'timeout'
              : matches(/parse|json|schema|repair/i)
                ? 'parse'
                : matches(
                      // No bare `api` token: it labeled any stray mention as
                      // provider-transient when `unknown` (equally retryable)
                      // is the honest class for unrecognized shapes.
                      /\b5\d\d\b|overloaded|upstream|stream|socket|econn|enotfound|fetch failed|network|unavailable/i,
                    )
                  ? 'provider-transient'
                  : 'unknown';
  return { failureClass, retryable: !NON_RETRYABLE.has(failureClass) };
}

/** A retry is pointless below this first-attempt duration — the PR state
 * cannot meaningfully have moved, and the freshness fetch is not free. */
export const STALE_CHECK_MIN_ATTEMPT_MS = 60_000;

type StaleReviewReason = 'merged' | 'closed' | 'head-moved';

export function classifyReviewStaleness(
  fresh: { state: 'open' | 'closed'; merged: boolean; headSha: string },
  reviewedHeadSha: string,
): StaleReviewReason | undefined {
  if (fresh.merged) return 'merged';
  if (fresh.state === 'closed') return 'closed';
  if (fresh.headSha && fresh.headSha !== reviewedHeadSha) return 'head-moved';
  return undefined;
}

/**
 * Thrown instead of retrying when the PR merged, closed, or moved to a new
 * head while the failed attempt ran: the retry's output could never be
 * posted against the reviewed state. Callers classify the run as skipped
 * (`stale-before-retry`), post nothing, and finish telemetry normally.
 */
export class StaleReviewError extends Error {
  constructor(public readonly reason: StaleReviewReason) {
    super(`stale-before-retry: PR ${reason} while the review was running`);
    this.name = 'StaleReviewError';
  }
}
