export type Severity = 'P0' | 'P1' | 'P2' | 'P3' | 'nit';

/** The one severity allowlist — parsers and entries validate against this. */
export const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2', 'P3', 'nit']);

export const VALID_FINDING_KINDS: ReadonlySet<FindingKind> = new Set<FindingKind>([
  'bug',
  'security',
  'performance',
  'maintainability',
  'architecture',
  'test',
  'docs',
  'investigate',
]);
export const VALID_CONFIDENCES: ReadonlySet<FindingConfidence> = new Set<FindingConfidence>([
  'high',
  'medium',
  'low',
]);
export const EVIDENCE_MAX_CHARS = 400;

/**
 * The one Finding-shape gate: required fields validate or the value is
 * rejected; optionals normalize with the live parse path's tolerance
 * (unknown kind/confidence dropped, evidence trimmed and capped). Both the
 * model-response parser and the shard cache go through here, so the two
 * cannot drift.
 */
export function sanitizeFinding(value: unknown): Finding | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const f = value as Record<string, unknown>;
  if (
    typeof f.path !== 'string' ||
    typeof f.line !== 'number' ||
    // Line 0 is a deliberate file-level anchor; negative or fractional
    // lines are noise.
    !Number.isInteger(f.line) ||
    f.line < 0 ||
    typeof f.title !== 'string' ||
    typeof f.body !== 'string' ||
    typeof f.severity !== 'string' ||
    !VALID_SEVERITIES.has(f.severity as Severity)
  ) {
    return undefined;
  }
  return {
    path: f.path,
    line: f.line,
    severity: f.severity as Severity,
    kind:
      typeof f.kind === 'string' && VALID_FINDING_KINDS.has(f.kind as FindingKind)
        ? (f.kind as FindingKind)
        : undefined,
    confidence:
      typeof f.confidence === 'string' && VALID_CONFIDENCES.has(f.confidence as FindingConfidence)
        ? (f.confidence as FindingConfidence)
        : undefined,
    title: f.title,
    body: f.body,
    ...(typeof f.evidence === 'string' && f.evidence.trim()
      ? { evidence: f.evidence.trim().slice(0, EVIDENCE_MAX_CHARS) }
      : {}),
  };
}
export type FindingKind =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
  | 'architecture'
  | 'test'
  | 'docs'
  | 'investigate';
export type FindingConfidence = 'high' | 'medium' | 'low';

export interface Finding {
  path: string;
  /** Line number on the new (RIGHT) side of the diff. */
  line: number;
  severity: Severity;
  kind?: FindingKind;
  confidence?: FindingConfidence;
  title: string;
  body: string;
  /** Verbatim quote of the changed line the finding hangs on (evidenceQuotes); grounds the verifier and enables orphan re-anchoring. Models may omit it. */
  evidence?: string;
  /** Stable per-run id for disposition tracing (reviewTelemetry); absent when telemetry is off, never posted. */
  id?: string;
}

export interface AddressedPriorComment {
  id: string;
  addressedByCommit?: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  addressedPriorComments: AddressedPriorComment[];
}

export type VerificationVerdict = 'confirmed' | 'refuted' | 'uncertain';

/** One adversarial-verifier judgement, keyed by finding index. */
export interface FindingVerdict {
  index: number;
  verdict: VerificationVerdict;
  reason?: string;
}
