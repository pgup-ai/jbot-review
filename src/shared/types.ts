export type Severity = "critical" | "warning" | "suggestion";

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
