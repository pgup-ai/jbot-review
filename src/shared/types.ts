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
  /**
   * F12 (opt-in `evidenceQuotes`): a short verbatim quote of the changed line
   * the finding hangs on. Grounds the verifier and lets a would-be-orphaned
   * finding be re-anchored. Optional at parse — a model may omit it.
   */
  evidence?: string;
  /**
   * F3 (opt-in `reviewTelemetry`): stable per-run id used to trace the finding's
   * disposition through the pipeline. Absent when telemetry is off; never posted.
   */
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
