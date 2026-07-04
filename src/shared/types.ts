export type Severity = 'P0' | 'P1' | 'P2' | 'P3' | 'nit';
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
