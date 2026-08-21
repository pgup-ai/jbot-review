import type { Finding, FindingConfidence, Severity } from './types.ts';

/**
 * Per-finding telemetry (F3): trace every finding the model produced through
 * the pipeline so recall/precision leaks become measurable instead of guessed.
 * The recorder is a no-op when disabled — off means literally zero new work.
 */
export type FindingDisposition =
  | 'deduped'
  | 'suppressed'
  | 'refuted'
  | 'severity-filtered'
  | 'posted-inline'
  | 'posted-file-level'
  | 'orphaned'
  | 'rescued'
  | 'anchor-missed';

export interface FindingTelemetryRow {
  kind: 'finding';
  id: string;
  /** Origin session label (e.g. review-shard-1, review-interactions, guideline-compliance). */
  session: string;
  path: string;
  line: number;
  /** Severity as produced (before the low-confidence gate). */
  severity: Severity;
  confidence?: FindingConfidence;
  hasEvidence: boolean;
  /** The low-confidence gate lowered this finding's severity. */
  demoted: boolean;
  /** Verification downgraded this finding to advisory (uncertain verdict). */
  verifyUncertain: boolean;
  disposition: FindingDisposition;
}

export interface SessionTelemetryRow {
  kind?: 'session';
  session: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  estimatedCostUsd?: number;
}

export type BackendTelemetryCapability = 'enforceable' | 'observable' | 'opaque';
export type ExplorationMode =
  'embedded-only' | 'diff-recovery' | 'adjacent-context' | 'mixed' | 'unavailable';
export type ExplorationBudgetTier =
  'single-shot' | 'observe-only' | 'minimal' | 'standard' | 'elevated';
export type TelemetryStopReason = 'completed' | 'failed' | 'timeout' | 'aborted';
export type ToolTelemetryClass =
  'diff-recovery' | 'file-read' | 'search' | 'list' | 'external-docs' | 'other-readonly';

export interface PhaseTelemetryRow {
  kind: 'phase';
  phase:
    | 'context-assembly'
    | 'main-queue'
    | 'main-execution'
    | 'auxiliary-queue'
    | 'auxiliary-execution'
    | 'grace-wait'
    | 'filtering'
    | 'verification'
    | 'posting'
    | 'teardown';
  scope: 'run' | 'session';
  durationMs: number;
  stopReason: TelemetryStopReason;
  session?: string;
  backend?: string;
  inputBytes?: number;
  outputBytes?: number;
}

export interface ToolTelemetryRow {
  kind: 'tool';
  session: string;
  backend: string;
  toolClass: ToolTelemetryClass;
  capability: BackendTelemetryCapability;
  durationMs?: number;
  inputBytes: number;
  outputBytesBeforeCap: number;
  outputBytesAfterCap: number;
  duplicate: boolean;
  success: boolean;
  failureClass?: 'denied' | 'budget' | 'timeout' | 'execution' | 'invalid-input' | 'unknown';
  diffScope?: 'whole' | 'path';
}

export interface ExplorationTelemetryRow {
  kind: 'exploration';
  session: string;
  backend: string;
  capability: BackendTelemetryCapability;
  explorationMode: ExplorationMode;
  budgetTier: ExplorationBudgetTier;
  stopReason: TelemetryStopReason;
  turnCountAvailable: boolean;
  turnCount?: number;
  toolCalls: number;
  toolInputBytes: number;
  toolOutputBytes: number;
  uniquePathHashes: number;
  uniqueQueryHashes: number;
  duplicateReads: number;
  repeatedSearches: number;
  droppedToolRows: number;
}

export interface PhaseTelemetryStart {
  phase: PhaseTelemetryRow['phase'];
  scope: PhaseTelemetryRow['scope'];
  session?: string;
  backend?: string;
  inputBytes?: number;
}

export interface PhaseTelemetryTracker {
  start(
    input: PhaseTelemetryStart,
  ): (stopReason?: TelemetryStopReason, outputBytes?: number) => void;
  finishOpen(stopReason: TelemetryStopReason): void;
}

/**
 * Observed state of one PRIOR run's posted finding thread, captured at run
 * start from the thread fetch the suppression pass already pays for. These are
 * the human-outcome labels (fixed / endorsed / pushed back / ignored) the eval
 * flywheel needs. Booleans and counters only — reply text never persists, the
 * same floor as coverage errors.
 */
export interface PriorThreadOutcome {
  threadId: string;
  path: string;
  line?: number;
  resolved: boolean;
  /** A bot addressed-reply or addressed marker exists on the thread. */
  addressed: boolean;
  /** Replies not authored by the bot (or another [bot] account). */
  humanReplies: number;
  /** Tallies from a capped reactor sample (bots excluded) — signal, not an exact census. */
  thumbsUp: number;
  thumbsDown: number;
  confused: number;
}

export interface OutcomeTelemetryRow extends PriorThreadOutcome {
  kind: 'outcome';
  /**
   * The thread's file is part of the current PR diff. Informational only:
   * prior findings anchor to PR files, so this is usually true — false means
   * the area was reverted or dropped, NOT "unchanged since the thread".
   */
  fileInDiff: boolean;
}

export interface FindingRouting {
  inline: Finding[];
  fileLevel: Finding[];
  orphaned: Finding[];
  rescued: Finding[];
  anchorMissed: Finding[];
}

/**
 * Run-level accounting: one header row per run so coverage and failures are
 * queryable across runs — a fail-open aux session must leave a machine-readable
 * trace, not just a log line.
 */
export interface RunTelemetryMeta {
  runId: string;
  baseSha?: string;
  headSha?: string;
  model: string;
  auxModel?: string;
}

/** 'skipped' = the run exited before any session (doc-only PR, empty diff). */
export type RunTerminalState = 'completed' | 'failed' | 'skipped';

export type SessionFailureClass = 'timeout' | 'provider' | 'parse' | 'aborted' | 'unknown';

export interface SessionCoverage {
  session: string;
  state: 'completed' | 'failed' | 'skipped' | 'reused';
  /** Classified into a failureClass; the error's own text is never persisted. */
  error?: unknown;
  durationMs?: number;
  promptBytes?: number;
}

export type SessionCoverageRecorder = (coverage: SessionCoverage) => void;

/**
 * Generic failure classes only — raw provider/error text can carry URLs,
 * tokens, or key material and must never reach the persisted JSONL.
 */
function classifySessionError(error: unknown): SessionFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort/i.test(message)) return 'aborted';
  if (/timed?\s*out|timeout|deadline/i.test(message)) return 'timeout';
  if (/parse|json|schema|repair/i.test(message)) return 'parse';
  if (
    /\b[45]\d\d\b|http|rate limit|overloaded|econn|enotfound|fetch failed|socket|stream|upstream|network|api/i.test(
      message,
    )
  ) {
    return 'provider';
  }
  return 'unknown';
}

export function classifyTelemetryStopReason(error: unknown): TelemetryStopReason {
  const failure = classifySessionError(error);
  return failure === 'timeout' ? 'timeout' : failure === 'aborted' ? 'aborted' : 'failed';
}

/**
 * Soft byte gate for one session's assembled context (PR context + guidelines).
 * Log-only: every fragment already has a hard budget, but the 149KB dilution
 * incident was an assembled TOTAL nobody was watching. Warning, not a failure.
 */
export const ASSEMBLED_CONTEXT_WARN_BYTES = 80 * 1024;

export function assembledContextWarning(label: string, bytes: number): string | undefined {
  if (bytes <= ASSEMBLED_CONTEXT_WARN_BYTES) return undefined;
  return `${label}: assembled context is ${bytes} bytes (soft cap ${ASSEMBLED_CONTEXT_WARN_BYTES}); large contexts dilute finder attention`;
}

/** Snapshot points, in pipeline order. */
export type TelemetryStage = 'gated' | 'deduped' | 'suppressed' | 'verified' | 'filtered';
const STAGE_ORDER: TelemetryStage[] = ['gated', 'deduped', 'suppressed', 'verified', 'filtered'];
const BLOCKING: ReadonlySet<Severity> = new Set<Severity>(['P0', 'P1', 'P2']);

export interface TelemetryRecorder {
  readonly enabled: boolean;
  /** Tag findings with a stable id + origin session; returns the tagged copies. */
  produced(session: string, findings: Finding[]): Finding[];
  /** Record which findings (by id) are present after a pipeline stage. */
  snapshot(stage: TelemetryStage, findings: Finding[]): void;
  /** Record the terminal routing of the surviving findings. */
  route(routing: FindingRouting): void;
  recordSession(row: SessionTelemetryRow): void;
  recordPhase(row: PhaseTelemetryRow): void;
  recordTool(row: ToolTelemetryRow): void;
  recordExploration(row: ExplorationTelemetryRow): void;
  /** Record a prior finding thread's observed human outcome (one row per thread). */
  recordOutcome(row: Omit<OutcomeTelemetryRow, 'kind'>): void;
  /** Open the run header row; identity fields only, sealed at start. */
  beginRun(meta: RunTelemetryMeta): void;
  /** Close the run header with its terminal state and wall clock. */
  finishRun(state: RunTerminalState, elapsedMs: number): void;
  recordCoverage(coverage: SessionCoverage): void;
  findingRows(): FindingTelemetryRow[];
  toJsonl(): string;
}

const DISABLED: TelemetryRecorder = {
  enabled: false,
  produced: (_session, findings) => findings,
  snapshot: () => undefined,
  route: () => undefined,
  recordSession: () => undefined,
  recordPhase: () => undefined,
  recordTool: () => undefined,
  recordExploration: () => undefined,
  recordOutcome: () => undefined,
  beginRun: () => undefined,
  finishRun: () => undefined,
  recordCoverage: () => undefined,
  findingRows: () => [],
  toJsonl: () => '',
};

interface ProducedMeta {
  session: string;
  path: string;
  line: number;
  severity: Severity;
  confidence?: FindingConfidence;
  hasEvidence: boolean;
}

export function createTelemetryRecorder(enabled: boolean): TelemetryRecorder {
  if (!enabled) return DISABLED;

  let counter = 0;
  const meta = new Map<string, ProducedMeta>();
  const order: string[] = [];
  const stageSeverity = new Map<TelemetryStage, Map<string, Severity>>();
  const routing = {
    inline: new Set<string>(),
    fileLevel: new Set<string>(),
    orphaned: new Set<string>(),
    rescued: new Set<string>(),
    anchorMissed: new Set<string>(),
  };
  // Final posted line for findings re-routed after produced(); keeps `meta`
  // honest as the model's original output rather than mutating it.
  const routedLine = new Map<string, number>();
  const sessions: SessionTelemetryRow[] = [];
  const phases: PhaseTelemetryRow[] = [];
  const tools: ToolTelemetryRow[] = [];
  const exploration = new Map<string, ExplorationTelemetryRow>();
  const outcomes: OutcomeTelemetryRow[] = [];
  let run:
    (RunTelemetryMeta & { terminalState?: RunTerminalState; elapsedMs?: number }) | undefined;
  const coverage: Record<string, unknown>[] = [];

  const idsOf = (findings: Finding[]): Set<string> =>
    new Set(findings.map((f) => f.id).filter((id): id is string => Boolean(id)));

  return {
    enabled: true,
    produced(session, findings) {
      return findings.map((f) => {
        const id = `f${++counter}`;
        meta.set(id, {
          session,
          path: f.path,
          line: f.line,
          severity: f.severity,
          confidence: f.confidence,
          hasEvidence: Boolean(f.evidence),
        });
        order.push(id);
        return { ...f, id };
      });
    },
    snapshot(stage, findings) {
      const byId = new Map<string, Severity>();
      for (const f of findings) if (f.id) byId.set(f.id, f.severity);
      stageSeverity.set(stage, byId);
    },
    route(routes) {
      const missed = idsOf(routes.anchorMissed);
      for (const id of idsOf(routes.inline)) routing.inline.add(id);
      for (const id of missed) routing.anchorMissed.add(id);
      for (const f of routes.fileLevel) {
        if (!f.id) continue;
        routing.fileLevel.add(f.id);
        // An anchor miss keeps the line the model claimed; the 0 it was demoted to says nothing.
        if (!missed.has(f.id)) routedLine.set(f.id, f.line);
      }
      for (const id of idsOf(routes.orphaned)) routing.orphaned.add(id);
      for (const f of routes.rescued) {
        if (!f.id) continue;
        routing.rescued.add(f.id);
        routedLine.set(f.id, f.line);
      }
    },
    recordSession(row) {
      sessions.push({ kind: 'session', ...row });
    },
    recordPhase(row) {
      phases.push(row);
    },
    recordTool(row) {
      tools.push(row);
    },
    recordExploration(row) {
      const key = `${row.backend}\0${row.session}`;
      const current = exploration.get(key);
      // The concurrency wrapper finalizes after the backend and defaults to
      // observe-only, so a later row must not erase what the backend recorded.
      exploration.set(
        key,
        current
          ? {
              ...row,
              ...(current.turnCountAvailable && !row.turnCountAvailable
                ? { turnCountAvailable: true, turnCount: current.turnCount }
                : {}),
              ...(row.budgetTier === 'observe-only' && current.budgetTier !== 'observe-only'
                ? { budgetTier: current.budgetTier }
                : {}),
            }
          : row,
      );
    },
    recordOutcome(row) {
      outcomes.push({ kind: 'outcome', ...row });
    },
    beginRun(meta) {
      run = { ...meta };
    },
    finishRun(state, elapsedMs) {
      if (run) Object.assign(run, { terminalState: state, elapsedMs });
    },
    recordCoverage(cov) {
      coverage.push({
        kind: 'coverage',
        session: cov.session,
        state: cov.state,
        // Every failed row carries a class — an error-less failure (unusable
        // output) classifies as unknown rather than omitting the field.
        ...(cov.state === 'failed' ? { failureClass: classifySessionError(cov.error) } : {}),
        ...(cov.durationMs !== undefined ? { durationMs: cov.durationMs } : {}),
        ...(cov.promptBytes !== undefined ? { promptBytes: cov.promptBytes } : {}),
      });
    },
    findingRows() {
      return order.map((id) => {
        const row = deriveRow(id, meta.get(id)!, stageSeverity, routing);
        const posted = routedLine.get(id);
        return posted === undefined ? row : { ...row, line: posted };
      });
    },
    toJsonl() {
      const header = run ? [{ kind: 'run', schemaVersion: 2, ...run }] : [];
      const lines = [
        ...header,
        ...phases,
        ...coverage,
        ...outcomes,
        ...this.findingRows(),
        ...sessions,
        ...tools,
        ...exploration.values(),
      ];
      return lines.map((l) => JSON.stringify(l)).join('\n');
    },
  };
}

export function createPhaseTelemetryTracker(
  recorder: TelemetryRecorder,
  now: () => number = Date.now,
): PhaseTelemetryTracker {
  if (!recorder.enabled) {
    return { start: () => () => undefined, finishOpen: () => undefined };
  }
  const active = new Map<symbol, { input: PhaseTelemetryStart; startedAt: number }>();
  const finish = (key: symbol, stopReason: TelemetryStopReason, outputBytes?: number): void => {
    const phase = active.get(key);
    if (!phase) return;
    active.delete(key);
    recorder.recordPhase({
      kind: 'phase',
      ...phase.input,
      durationMs: Math.max(now() - phase.startedAt, 0),
      stopReason,
      ...(outputBytes !== undefined ? { outputBytes } : {}),
    });
  };
  return {
    start(input) {
      const key = Symbol(input.phase);
      active.set(key, { input, startedAt: now() });
      return (stopReason = 'completed', outputBytes) => finish(key, stopReason, outputBytes);
    },
    finishOpen(stopReason) {
      for (const key of active.keys()) finish(key, stopReason);
    },
  };
}

function deriveRow(
  id: string,
  m: ProducedMeta,
  stageSeverity: Map<TelemetryStage, Map<string, Severity>>,
  routing: {
    inline: Set<string>;
    fileLevel: Set<string>;
    orphaned: Set<string>;
    rescued: Set<string>;
    anchorMissed: Set<string>;
  },
): FindingTelemetryRow {
  const severityAt = (stage: TelemetryStage): Severity | undefined =>
    stageSeverity.get(stage)?.get(id);

  const gated = severityAt('gated');
  const demoted = gated !== undefined && gated !== m.severity;
  // A finding present at 'verified' was necessarily present at 'suppressed'
  // (stages only drop, never re-add), so that is the pre-verify severity.
  const preVerify = severityAt('suppressed');
  const verifyUncertain =
    severityAt('verified') === 'P3' && preVerify !== undefined && BLOCKING.has(preVerify);

  // Stages only drop findings, so presence is a prefix of STAGE_ORDER: the
  // finding was dropped entering the stage after the last one it appears in.
  // This assumes every stage is snapshotted (the runner always does); with a
  // stage omitted, a *dropped* finding's stage is inherently ambiguous —
  // survivors still classify by routing.
  const present = STAGE_ORDER.filter((stage) => stageSeverity.get(stage)?.has(id));
  const last = present[present.length - 1];
  let disposition: FindingDisposition;
  if (last === 'filtered') {
    if (routing.rescued.has(id)) disposition = 'rescued';
    else if (routing.inline.has(id)) disposition = 'posted-inline';
    else if (routing.anchorMissed.has(id)) disposition = 'anchor-missed';
    else if (routing.fileLevel.has(id)) disposition = 'posted-file-level';
    else disposition = 'orphaned';
  } else {
    const droppedEntering = last ? STAGE_ORDER[STAGE_ORDER.indexOf(last) + 1] : 'deduped';
    disposition =
      droppedEntering === 'suppressed'
        ? 'suppressed'
        : droppedEntering === 'verified'
          ? 'refuted'
          : droppedEntering === 'filtered'
            ? 'severity-filtered'
            : 'deduped';
  }

  return {
    kind: 'finding',
    id,
    session: m.session,
    path: m.path,
    line: m.line,
    severity: m.severity,
    confidence: m.confidence,
    hasEvidence: m.hasEvidence,
    demoted,
    verifyUncertain,
    disposition,
  };
}

/** Per-area rollup of thread outcomes — the guideline-candidates report rows. */
export interface GuidelineCandidateArea {
  /** Top-level path segment ('src', 'docs', …) or the filename for root files. */
  area: string;
  threads: number;
  /** Explicit negative reaction: 👎 or 😕. */
  pushback: number;
  /** A human replied. Valence unknown — agreement and rebuttal look identical here. */
  discussed: number;
  /** Explicit agreement: addressed, or a 👍. */
  endorsed: number;
  /** No human signal at all, never addressed or resolved — likely noise. */
  ignored: number;
  addressed: number;
  resolved: number;
}

/**
 * Rows are per-run observations of the same threads; only the LAST observation
 * of each threadId counts (pass rows in run order). Signal classes overlap
 * deliberately — a thread can collect both a 👍 and a 👎.
 *
 * Reply TEXT is never read, so replies stay their own neutral class: treating
 * an unaddressed reply as disagreement mislabels "good catch, will fix" the
 * moment the next run observes the thread before the fix lands.
 */
export function aggregateOutcomeRows(rows: OutcomeTelemetryRow[]): GuidelineCandidateArea[] {
  const latest = new Map<string, OutcomeTelemetryRow>();
  for (const row of rows) latest.set(row.threadId, row);

  const areas = new Map<string, GuidelineCandidateArea>();
  for (const row of latest.values()) {
    const area = row.path.includes('/') ? row.path.split('/')[0] : row.path;
    const entry = areas.get(area) ?? {
      area,
      threads: 0,
      pushback: 0,
      discussed: 0,
      endorsed: 0,
      ignored: 0,
      addressed: 0,
      resolved: 0,
    };
    entry.threads += 1;
    const reactions = row.thumbsUp + row.thumbsDown + row.confused;
    if (row.thumbsDown > 0 || row.confused > 0) entry.pushback += 1;
    if (row.humanReplies > 0) entry.discussed += 1;
    if (row.addressed || row.thumbsUp > 0) entry.endorsed += 1;
    if (row.humanReplies === 0 && reactions === 0 && !row.addressed && !row.resolved) {
      entry.ignored += 1;
    }
    if (row.addressed) entry.addressed += 1;
    if (row.resolved) entry.resolved += 1;
    areas.set(area, entry);
  }

  return [...areas.values()].sort(
    (a, b) =>
      b.pushback - a.pushback ||
      b.discussed - a.discussed ||
      b.threads - a.threads ||
      a.area.localeCompare(b.area),
  );
}
