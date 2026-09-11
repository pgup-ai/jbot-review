const MAX_SESSION_TIMEOUT_MS = 30 * 60_000;
const POSTING_RESERVE_MS = 30_000;
const MIN_VERIFICATION_MS = 45_000;
const MAX_VERIFICATION_MS = 5 * 60_000;

export function computeFinderTimeoutMs(
  timeBudgetMinutes: number,
  verificationEnabled = true,
): number | undefined {
  const deadline = computeRunDeadline(timeBudgetMinutes, 0, verificationEnabled);
  return deadline === undefined ? undefined : Math.min(deadline, MAX_SESSION_TIMEOUT_MS);
}

export function computeRunDeadline(
  timeBudgetMinutes: number,
  runStartedAt: number,
  verificationEnabled = true,
): number | undefined {
  if (timeBudgetMinutes <= 0) return undefined;
  const available = Math.max(0, timeBudgetMinutes * 60_000 - POSTING_RESERVE_MS);
  const verificationReserve = verificationEnabled
    ? Math.min(MAX_VERIFICATION_MS, available / 2)
    : 0;
  return runStartedAt + available - verificationReserve;
}

const MIN_RETRY_TIMEOUT_MS = 60_000;

export function computeRetryTimeoutMs(
  deadlineAt: number | undefined,
  now: number,
  finderTimeoutMs: number | undefined,
): number | undefined {
  if (deadlineAt === undefined) return finderTimeoutMs;
  const remaining = deadlineAt - now;
  if (remaining < MIN_RETRY_TIMEOUT_MS) return 0;
  return finderTimeoutMs === undefined ? remaining : Math.min(remaining, finderTimeoutMs);
}

export function computeVerificationTimeoutMs(
  timeBudgetMinutes: number,
  elapsedMs: number,
): number | undefined {
  if (timeBudgetMinutes <= 0) return undefined;
  const remaining = timeBudgetMinutes * 60_000 - elapsedMs - POSTING_RESERVE_MS;
  if (remaining < MIN_VERIFICATION_MS) return 0;
  return Math.min(remaining, MAX_VERIFICATION_MS);
}

export const AUXILIARY_SETTLE_GRACE_MS = 5 * 60_000;
/**
 * Minimum life of an auxiliary session measured from its own launch. The
 * grace is anchored to the main pass finishing, so a 10 s main would otherwise
 * leave a lens 310 s; the floor stretches the grace to cover this runway.
 */
const AUXILIARY_RUNWAY_MS = 10 * 60_000;

export function computeAuxiliaryGraceMs(
  timeBudgetMinutes: number,
  elapsedMs: number,
  verificationEnabled = true,
  auxElapsedMs?: number,
): number {
  const grace =
    auxElapsedMs === undefined
      ? AUXILIARY_SETTLE_GRACE_MS
      : Math.max(AUXILIARY_SETTLE_GRACE_MS, AUXILIARY_RUNWAY_MS - auxElapsedMs);
  if (timeBudgetMinutes <= 0) return grace;
  return Math.max(
    0,
    Math.min(
      grace,
      timeBudgetMinutes * 60_000 -
        elapsedMs -
        POSTING_RESERVE_MS -
        (verificationEnabled ? MAX_VERIFICATION_MS : 0),
    ),
  );
}

/**
 * Provider prefix caches (DeepSeek, z.ai) serve a request only after the
 * request that built the prefix has been processed, so sessions meant to share
 * a prefix launch this far apart. A KV prefix is model-specific: only an
 * auxiliary session on the exact main model waits for main's prefill.
 */
export const SHARED_PREFIX_STAGGER_MS = 8_000;

export function sharedPrefixLaunchDelayMs(index: number, sharesMainModel: boolean): number {
  return (index + (sharesMainModel ? 1 : 0)) * SHARED_PREFIX_STAGGER_MS;
}

/** Staggered lenses launch later, so their runway is measured from the last scheduled launch. */
export function computeLensGraceMs(
  timeBudgetMinutes: number,
  elapsedMs: number,
  verificationEnabled: boolean,
  auxElapsedMs: number,
  lensCount: number,
  sharesMainModel: boolean,
): number {
  const lastLaunchDelayMs =
    lensCount > 0 ? sharedPrefixLaunchDelayMs(lensCount - 1, sharesMainModel) : 0;
  return computeAuxiliaryGraceMs(
    timeBudgetMinutes,
    elapsedMs,
    verificationEnabled,
    auxElapsedMs - lastLaunchDelayMs,
  );
}
