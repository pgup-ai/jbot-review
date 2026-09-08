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

export const AUXILIARY_SETTLE_GRACE_MS = 10 * 60_000;

export function computeAuxiliaryGraceMs(
  timeBudgetMinutes: number,
  elapsedMs: number,
  verificationEnabled = true,
): number {
  if (timeBudgetMinutes <= 0) return AUXILIARY_SETTLE_GRACE_MS;
  return Math.max(
    0,
    Math.min(
      AUXILIARY_SETTLE_GRACE_MS,
      timeBudgetMinutes * 60_000 -
        elapsedMs -
        POSTING_RESERVE_MS -
        (verificationEnabled ? MAX_VERIFICATION_MS : 0),
    ),
  );
}
