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
  | 'rescued';

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
}

export interface FindingRouting {
  inline: Finding[];
  fileLevel: Finding[];
  orphaned: Finding[];
  rescued: Finding[];
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
  findingRows(): FindingTelemetryRow[];
  toJsonl(): string;
}

const DISABLED: TelemetryRecorder = {
  enabled: false,
  produced: (_session, findings) => findings,
  snapshot: () => undefined,
  route: () => undefined,
  recordSession: () => undefined,
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
  };
  // Final posted line for findings re-routed after produced(); keeps `meta`
  // honest as the model's original output rather than mutating it.
  const routedLine = new Map<string, number>();
  const sessions: SessionTelemetryRow[] = [];

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
      for (const id of idsOf(routes.inline)) routing.inline.add(id);
      for (const f of routes.fileLevel) {
        if (!f.id) continue;
        routing.fileLevel.add(f.id);
        routedLine.set(f.id, f.line);
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
    findingRows() {
      return order.map((id) => {
        const row = deriveRow(id, meta.get(id)!, stageSeverity, routing);
        const posted = routedLine.get(id);
        return posted === undefined ? row : { ...row, line: posted };
      });
    },
    toJsonl() {
      const lines = [...this.findingRows(), ...sessions];
      return lines.map((l) => JSON.stringify(l)).join('\n');
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
    disposition = routing.rescued.has(id)
      ? 'rescued'
      : routing.inline.has(id)
        ? 'posted-inline'
        : routing.fileLevel.has(id)
          ? 'posted-file-level'
          : 'orphaned';
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
