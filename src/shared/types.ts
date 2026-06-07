export type Severity = 'P0' | 'P1' | 'P2' | 'P3' | 'nit';

export interface Finding {
  path: string;
  /** Line number on the new (RIGHT) side of the diff. */
  line: number;
  severity: Severity;
  title: string;
  body: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
}
