export type Severity = 'P0' | 'P1' | 'P2' | 'P3' | 'nit';
export type FindingKind =
  | 'bug'
  | 'security'
  | 'performance'
  | 'maintainability'
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
}

export interface AddressedPriorComment {
  id: string;
  addressedByCommit?: string;
  note?: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  addressedPriorComments: AddressedPriorComment[];
}
