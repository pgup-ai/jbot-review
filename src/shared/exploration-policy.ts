import {
  EXPLORATION_NO_TOOLS_MESSAGE,
  EXPLORATION_SOFT_STOP_MESSAGE,
  explorationUnrelatedRecoveryMessage,
} from './prompt.ts';
import type { BackendTelemetryCapability } from './telemetry.ts';

/**
 * Exploration budgets for model-driven repository reads.
 *
 * A blunt turn cap cannot tell a session recovering coverage it was denied
 * from one wandering the repo, so the budget counts ordinary calls, the bytes
 * they return, and how far they stray, while exempting recovery of hunks the
 * prompt admits it omitted. Every decision here is pure; backends apply it at
 * their own tool boundary.
 */

/** What a session is permitted to do, chosen before it starts. */
export type ExplorationMode = 'embedded' | 'coverage-recovery' | 'single-shot';

/** How much ordinary exploration the change's risk earns. */
export type ExplorationTier = 'minimal' | 'standard' | 'elevated';

export interface ExplorationLimits {
  /** Calls that are not exempt coverage recovery. */
  ordinaryCalls: number;
  toolOutputBytes: number;
  /** Distinct files reachable beyond the diff. */
  adjacentFiles: number;
  /** Re-reads of a path, or repeats of a query, already served. */
  repeats: number;
}

/**
 * Phase 4 A/B constants, not public configuration. Calls, bytes, and adjacent
 * files come from TASK-037; the repeat allowance is set here because a budget
 * counting only volume still lets a session re-read one file forever.
 *
 * TASK-036 also lists dependency depth. A tool call arrives with no provenance
 * tying it back to the diff, so depth is not knowable at this boundary and
 * stays a prompt rule ("one dependency hop by default") rather than a counter
 * that would always read zero.
 */
export const EXPLORATION_LIMITS: Readonly<Record<ExplorationTier, ExplorationLimits>> = {
  minimal: {
    ordinaryCalls: 4,
    toolOutputBytes: 64 * 1024,
    adjacentFiles: 3,
    repeats: 0,
  },
  standard: {
    ordinaryCalls: 8,
    toolOutputBytes: 128 * 1024,
    adjacentFiles: 6,
    repeats: 1,
  },
  elevated: {
    ordinaryCalls: 16,
    toolOutputBytes: 256 * 1024,
    adjacentFiles: 12,
    repeats: 2,
  },
};

/**
 * Exempt recovery attempts allowed per gap. A capped diff leaves the gap open,
 * so without a bound the same path could be re-requested forever outside the
 * ordinary budget.
 */
const RECOVERY_ATTEMPTS_PER_GAP = 2;

/** A single-shot session has no tools at all, so no budget can apply. */
const SINGLE_SHOT_LIMITS: ExplorationLimits = {
  ordinaryCalls: 0,
  toolOutputBytes: 0,
  adjacentFiles: 0,
  repeats: 0,
};

/**
 * Risk decides how much ordinary exploration a change earns. Takes plain
 * signals rather than importing the diff taxonomy, so the policy stays pure
 * and the caller owns what counts as risky.
 */
export function selectExplorationTier(params: {
  changedFiles: number;
  touchesRiskyPath: boolean;
  testOnly: boolean;
}): ExplorationTier {
  if (params.testOnly) return 'minimal';
  if (params.touchesRiskyPath || params.changedFiles > 10) return 'elevated';
  return 'standard';
}

/**
 * Only an `enforceable` backend can refuse a call at its own tool boundary.
 * Handing a budget to any other route would read as enforcement in the plan
 * while changing nothing, so the caller checks here first (TASK-041 to 044).
 */
export function enforcesExplorationBudget(
  capability: BackendTelemetryCapability | undefined,
): boolean {
  return capability === 'enforceable';
}

export interface ExplorationPlan {
  mode: ExplorationMode;
  tier: ExplorationTier;
  /** Files the prompt could not embed in full, eligible for exempt recovery. */
  coverageGaps: readonly string[];
}

/**
 * `coverage-recovery` whenever the prompt admits a gap, so the exemption
 * exists before the session can ask for it. Everything else reviews from
 * embedded context.
 */
export function planExploration(params: {
  tier: ExplorationTier;
  truncatedFiles: readonly string[];
  omittedFiles: readonly string[];
  singleShot?: boolean;
}): ExplorationPlan {
  if (params.singleShot) return { mode: 'single-shot', tier: params.tier, coverageGaps: [] };
  const coverageGaps = [...new Set([...params.truncatedFiles, ...params.omittedFiles])].sort();
  return {
    mode: coverageGaps.length > 0 ? 'coverage-recovery' : 'embedded',
    tier: params.tier,
    coverageGaps,
  };
}

/**
 * Every file the prompt could not embed must be recoverable, or the review
 * silently loses full-diff coverage (invariant 1). Throws rather than warns:
 * a gap with no way back is a build-time mistake, not a runtime condition.
 */
export function assertRecoverableCoverage(plan: ExplorationPlan): void {
  if (plan.coverageGaps.length === 0) return;
  if (plan.mode !== 'coverage-recovery') {
    throw new Error(
      `Exploration plan has ${plan.coverageGaps.length} coverage gap(s) but mode is "${plan.mode}".`,
    );
  }
}

export type ExplorationRequest =
  | { kind: 'diff'; path?: string }
  | { kind: 'read'; path: string }
  | { kind: 'search'; query: string };

export type ExplorationRefusal =
  'soft-stop' | 'budget-exhausted' | 'unrelated-recovery' | 'no-tools';

export interface ExplorationVerdict {
  allow: boolean;
  /** True when the call is exempt coverage recovery and spends no ordinary budget. */
  exempt: boolean;
  refusal?: ExplorationRefusal;
  /** Bounded text the backend returns in place of the tool result. */
  message?: string;
}

/**
 * Mutable per-session counters. Kept beside the pure decision rather than
 * inside a backend so every route enforces the same arithmetic.
 */
export class ExplorationBudget {
  private ordinaryCalls = 0;
  private outputBytes = 0;
  private readonly adjacent = new Set<string>();
  private readonly served = new Set<string>();
  private readonly repeated = new Map<string, number>();
  private readonly recovered = new Set<string>();
  private readonly recoveryAttempts = new Map<string, number>();
  private softStopped = false;

  private readonly limits: ExplorationLimits;

  constructor(private readonly plan: ExplorationPlan) {
    this.limits = plan.mode === 'single-shot' ? SINGLE_SHOT_LIMITS : EXPLORATION_LIMITS[plan.tier];
  }

  /** Coverage gaps still unread; recovery stays exempt until this empties. */
  get pendingGaps(): string[] {
    return this.plan.coverageGaps.filter((path) => !this.recovered.has(path));
  }

  get exhausted(): boolean {
    return this.softStopped;
  }

  /** Reported in telemetry as the tier this session actually enforced. */
  get tier(): ExplorationTier {
    return this.plan.tier;
  }

  /** Reported as the session's budget tier once every gap has been served. */
  get mode(): ExplorationMode {
    if (this.plan.mode !== 'coverage-recovery') return this.plan.mode;
    return this.pendingGaps.length === 0 ? 'embedded' : 'coverage-recovery';
  }

  request(request: ExplorationRequest): ExplorationVerdict {
    if (this.plan.mode === 'single-shot') {
      return {
        allow: false,
        exempt: false,
        refusal: 'no-tools',
        message: EXPLORATION_NO_TOOLS_MESSAGE,
      };
    }
    // Ahead of the soft stop on purpose: ordinary work running out must never
    // starve a coverage gap the prompt admitted it could not embed.
    if (request.kind === 'diff' && request.path && this.isExemptRecovery(request)) {
      // Counted on the request rather than the result, so a call that fails
      // downstream cannot retry forever outside the ordinary budget.
      const { path } = request;
      this.recoveryAttempts.set(path, (this.recoveryAttempts.get(path) ?? 0) + 1);
      return { allow: true, exempt: true };
    }
    // A refusal after the soft stop must not read as a fresh warning.
    if (this.softStopped) {
      return {
        allow: false,
        exempt: false,
        refusal: 'budget-exhausted',
        message: EXPLORATION_SOFT_STOP_MESSAGE,
      };
    }
    const unrelated = this.rejectsUnrelatedRecovery(request);
    if (unrelated) return unrelated;

    const identity = requestIdentity(request);
    const repeats = this.repeated.get(identity) ?? 0;
    if (this.served.has(identity) && repeats >= this.limits.repeats) {
      return this.softStop();
    }
    if (this.ordinaryCalls >= this.limits.ordinaryCalls) return this.softStop();
    if (this.outputBytes >= this.limits.toolOutputBytes) return this.softStop();
    // Only a read names a file, so only a read widens the adjacent set.
    if (
      request.kind === 'read' &&
      !this.adjacent.has(request.path) &&
      this.adjacent.size >= this.limits.adjacentFiles
    ) {
      return this.softStop();
    }
    return { allow: true, exempt: false };
  }

  /** Called once a permitted request has run, with what it actually returned. */
  record(request: ExplorationRequest, outputBytes: number, truncated = false): void {
    if (this.isExemptRecovery(request) && request.kind === 'diff' && request.path) {
      // A capped response delivered only part of the file, so the gap stays
      // open. RECOVERY_ATTEMPTS_PER_GAP bounds the retries, after which the
      // path stops being exempt and falls to the ordinary budget.
      if (!truncated) this.recovered.add(request.path);
      return;
    }
    const identity = requestIdentity(request);
    if (this.served.has(identity)) {
      this.repeated.set(identity, (this.repeated.get(identity) ?? 0) + 1);
    }
    this.served.add(identity);
    if (request.kind === 'read') this.adjacent.add(request.path);
    this.ordinaryCalls += 1;
    this.outputBytes += outputBytes;
  }

  /**
   * A path-scoped diff for a gap the prompt named. Recovery for anything else
   * is refused outright so the exemption cannot become a second budget.
   */
  private isExemptRecovery(request: ExplorationRequest): boolean {
    if (this.plan.mode !== 'coverage-recovery' || request.kind !== 'diff' || !request.path) {
      return false;
    }
    if ((this.recoveryAttempts.get(request.path) ?? 0) >= RECOVERY_ATTEMPTS_PER_GAP) return false;
    return this.pendingGaps.includes(request.path);
  }

  /**
   * While gaps are outstanding a path-scoped diff means recovery, so one
   * naming a file the prompt never flagged is refused instead of quietly
   * becoming a second budget. Once every gap is served the mode leaves
   * recovery and such a diff is ordinary exploration again.
   */
  private rejectsUnrelatedRecovery(request: ExplorationRequest): ExplorationVerdict | undefined {
    const pending = this.pendingGaps;
    if (request.kind !== 'diff' || !request.path || pending.length === 0) return undefined;
    // A gap already served is not unrelated: re-reading it spends ordinary
    // budget like any other diff, rather than being refused while its siblings
    // are still outstanding.
    if (this.plan.coverageGaps.includes(request.path)) return undefined;
    return {
      allow: false,
      exempt: false,
      refusal: 'unrelated-recovery',
      message: explorationUnrelatedRecoveryMessage(pending),
    };
  }

  private softStop(): ExplorationVerdict {
    this.softStopped = true;
    return {
      allow: false,
      exempt: false,
      refusal: 'soft-stop',
      message: EXPLORATION_SOFT_STOP_MESSAGE,
    };
  }
}

function requestIdentity(request: ExplorationRequest): string {
  if (request.kind === 'search') return `search:${request.query}`;
  if (request.kind === 'diff') return `diff:${request.path ?? '*'}`;
  return `read:${request.path}`;
}

/** TASK-045 refuses to set a threshold on fewer sessions than this. */
export const SOFT_FINISH_MIN_SESSIONS = 30;

export interface UsefulTurnSample {
  backend: string;
  tier: ExplorationTier;
  /** Turns before the last one that produced a retained finding or closed a coverage gap. */
  usefulTurns: number;
}

export interface SoftFinishThreshold {
  sessions: number;
  /** Where a session should be told to finish. */
  p90: number;
  /** Runaway guard only; the wall-clock timeout still owns the hard stop. */
  p99: number;
}

/**
 * Useful-turn percentiles per backend and tier. A cohort under
 * `SOFT_FINISH_MIN_SESSIONS` is omitted rather than given a threshold its
 * sample cannot support — the Phase 3 latency work showed how readily a thin
 * sample produces a confident-looking number that means nothing.
 */
export function softFinishThresholds(
  samples: readonly UsefulTurnSample[],
): Map<string, SoftFinishThreshold> {
  const cohorts = new Map<string, number[]>();
  for (const sample of samples) {
    const key = `${sample.backend}:${sample.tier}`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), sample.usefulTurns]);
  }
  const thresholds = new Map<string, SoftFinishThreshold>();
  for (const [key, turns] of cohorts) {
    if (turns.length < SOFT_FINISH_MIN_SESSIONS) continue;
    const sorted = [...turns].sort((a, b) => a - b);
    const at = (quantile: number) =>
      sorted[Math.min(Math.ceil(quantile * sorted.length) - 1, sorted.length - 1)];
    thresholds.set(key, { sessions: sorted.length, p90: at(0.9), p99: at(0.99) });
  }
  return thresholds;
}
