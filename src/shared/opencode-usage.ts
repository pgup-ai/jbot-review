import { formatShortDuration, isFiniteNumber, isNonArrayRecord, percentLabel } from './text.ts';

// Undocumented console route (referenced by neither the console bundle nor the
// CLI), and the only place the Go plan's caps are exposed — so treat any drift
// as "no usage" rather than as a failure.
const OPENCODE_GO_STATUS_URL = 'https://opencode.ai/console/api/go/status';
const OPENCODE_USAGE_TIMEOUT_MS = 4_000;

/** Providers whose key is an opencode.ai account credential. */
export function isOpencodeAccountProvider(providerID: string): boolean {
  return providerID === 'opencode' || providerID === 'opencode-go';
}

export interface OpencodeUsageWindow {
  /** Microcents: the plan meters allowance in money, not tokens. */
  used: number;
  limit: number;
  /** Absent on the monthly meter, which rolls with the billing period. */
  resetAtMs?: number;
}

export interface OpencodeGoUsage {
  fiveHour?: OpencodeUsageWindow;
  week?: OpencodeUsageWindow;
  month?: OpencodeUsageWindow;
  /** Overage draws on the credit balance instead of failing the request. */
  useBalance: boolean;
}

/** The meters carry microcents as decimal strings. */
function microCents(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseOpencodeGoStatus(payload: unknown): OpencodeGoUsage | undefined {
  if (!isNonArrayRecord(payload) || !isNonArrayRecord(payload.access)) return undefined;
  const { meters } = payload.access;
  if (meters != null && !isNonArrayRecord(meters)) return undefined;
  const windows = isNonArrayRecord(meters) ? meters : undefined;
  // null = present but malformed, undefined = absent. Malformed poisons the
  // whole payload so a partial line cannot hide a real cap.
  const windowOf = (value: unknown): OpencodeUsageWindow | null | undefined => {
    if (value == null) return undefined;
    if (!isNonArrayRecord(value)) return null;
    const used = microCents(value.usedMicroCents);
    const limit = microCents(value.limitMicroCents);
    if (used === undefined || used < 0 || limit === undefined || limit <= 0) return null;
    if (value.resetsAt != null && typeof value.resetsAt !== 'string') return null;
    const resetAtMs = typeof value.resetsAt === 'string' ? Date.parse(value.resetsAt) : undefined;
    if (resetAtMs !== undefined && !Number.isFinite(resetAtMs)) return null;
    return { used, limit, ...(resetAtMs === undefined ? {} : { resetAtMs }) };
  };
  const fiveHour = windowOf(windows?.fiveHour);
  const week = windowOf(windows?.week);
  const month = windowOf(windows?.month);
  if (fiveHour === null || week === null || month === null) return undefined;
  return { fiveHour, week, month, useBalance: payload.useBalance === true };
}

function usd(value: number): string {
  return `$${(value / 1e8).toFixed(2)}`;
}

function meterLabel(
  label: string,
  window: OpencodeUsageWindow | undefined,
  now: number,
): string | undefined {
  if (!window) return undefined;
  const resets =
    window.resetAtMs === undefined
      ? ''
      : `, resets in ${formatShortDuration(Math.max(window.resetAtMs - now, 0))}`;
  const exceeded = window.used >= window.limit ? ', EXCEEDED' : '';
  return `${label} ${usd(window.used)}/${usd(window.limit)} (${percentLabel(
    window.used,
    window.limit,
  )}${exceeded}${resets})`;
}

function formatOpencodeGoUsageBody(usage: OpencodeGoUsage, now: number): string {
  const meters = [
    meterLabel('5h', usage.fiveHour, now),
    meterLabel('weekly', usage.week, now),
    meterLabel('monthly', usage.month, now),
  ]
    .filter(Boolean)
    .join(', ');
  if (!meters) return 'plan reports no meters.';
  return `${meters}; overage ${usage.useBalance ? 'draws on the credit balance' : 'is blocked'}.`;
}

/**
 * Share of the weekly cap still open; no weekly meter means nothing throttles,
 * so full headroom. A spent window floors at zero rather than ranking by how
 * far past the cap it is.
 */
function weeklyHeadroom(usage: OpencodeGoUsage): number {
  return usage.week ? Math.max(0, 1 - usage.week.used / usage.week.limit) : 1;
}

function monthlyHeadroom(usage: OpencodeGoUsage): number {
  return usage.month ? Math.max(0, 1 - usage.month.used / usage.month.limit) : 1;
}

function spent(window?: OpencodeUsageWindow): boolean {
  return window !== undefined && window.used >= window.limit;
}

interface OpencodeKeyProbe {
  key: string;
  usage?: OpencodeGoUsage;
}

/**
 * Most weekly allowance left wins; monthly breaks ties. Unlike CommandCode a
 * spent plan is never fatal here — overage bills the credit balance rather than
 * refusing the request — so an exhausted key stays selectable as a last resort.
 */
export function pickOpencodeApiKey(probes: readonly OpencodeKeyProbe[]): {
  key: string;
  reason: string;
} {
  const reachable = probes.filter(
    (probe): probe is { key: string; usage: OpencodeGoUsage } => probe.usage !== undefined,
  );
  if (reachable.length === 0) {
    return { key: probes[0].key, reason: `probes unavailable; using first of ${probes.length}` };
  }
  const windowOpen = reachable.filter(
    (probe) => !spent(probe.usage.fiveHour) && !spent(probe.usage.week),
  );
  const pool = windowOpen.length > 0 ? windowOpen : reachable;
  const best = pool.reduce((a, b) => {
    const headroomA = weeklyHeadroom(a.usage);
    const headroomB = weeklyHeadroom(b.usage);
    if (headroomB > headroomA) return b;
    if (headroomB === headroomA && monthlyHeadroom(b.usage) > monthlyHeadroom(a.usage)) return b;
    return a;
  });
  const prefix = windowOpen.length === 0 ? `all ${reachable.length} window-limited; ` : '';
  // The full-headroom sentinel for an unmetered account must not read as a real meter.
  const standing = best.usage.week
    ? `${Math.round(weeklyHeadroom(best.usage) * 100)}% of weekly limit left`
    : 'no weekly limit';
  return {
    key: best.key,
    reason:
      `${prefix}picked ${probes.indexOf(best) + 1}/${probes.length} ` +
      `(…${best.key.slice(-4)}, ${standing})`,
  };
}

/** One per-key meter line logged BEFORE the pick, so the decision's inputs are visible. */
export function formatOpencodeKeyProbeLine(
  probe: OpencodeKeyProbe,
  index: number,
  total: number,
  now: number,
): string {
  const label = `Opencode key ${index + 1}/${total} (…${probe.key.slice(-4)})`;
  return probe.usage
    ? `${label}: ${formatOpencodeGoUsageBody(probe.usage, now)}`
    : `${label}: plan usage unavailable.`;
}

function splitOpencodeApiKeys(value: string): string[] {
  return value
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

/** Plan meters for one key, or undefined on ANY failure. Never throws. */
async function fetchOpencodeGoUsage(key: string): Promise<OpencodeGoUsage | undefined> {
  try {
    const response = await fetch(OPENCODE_GO_STATUS_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(OPENCODE_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return parseOpencodeGoStatus(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Resolves a comma-separated opencode key list to the account with the most
 * weekly allowance left, probing once per run so both roles share that account.
 * A single key — or any non-opencode provider — is returned untouched, so the
 * common case costs no request.
 */
export async function selectOpencodeApiKey(
  providerID: string,
  rawValue: string,
  log: (msg: string) => void,
): Promise<string> {
  if (!isOpencodeAccountProvider(providerID) || !rawValue.includes(',')) return rawValue;
  const keys = splitOpencodeApiKeys(rawValue);
  // Nothing parseable keeps the raw value: legacy garbage-in behavior.
  if (keys.length < 2) return keys[0] ?? rawValue;
  const probes = await Promise.all(
    keys.map(async (key) => ({ key, usage: await fetchOpencodeGoUsage(key) })),
  );
  const now = Date.now();
  probes.forEach((probe, index) =>
    log(formatOpencodeKeyProbeLine(probe, index, probes.length, now)),
  );
  const picked = pickOpencodeApiKey(probes);
  log(`Opencode key: ${picked.reason}`);
  return picked.key;
}
