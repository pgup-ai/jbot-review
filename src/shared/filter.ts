import type { Finding, FindingConfidence, Severity } from './types.ts';

/** Drops noise files (lockfiles, generated, minified) before the agent sees them. */
const NOISE_FILENAMES = new Set<string>([
  'bun.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
]);
const NOISE_EXTENSIONS = ['.min.js', '.min.css', '.bundle.js', '.map'];
const NOISE_PATH_SEGMENTS = ['node_modules/', 'dist/', 'vendor/', '/generated/'];

export function isNoiseFile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;
  if (NOISE_FILENAMES.has(base)) return true;
  if (NOISE_EXTENSIONS.some((ext) => filename.endsWith(ext))) return true;
  if (NOISE_PATH_SEGMENTS.some((seg) => filename.includes(seg))) return true;
  return false;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  nit: 4,
};

const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2']);

const CONFIDENCE_RANK: Record<FindingConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Strength of a finding for collision resolution: lower is stronger. Compares
 * by severity first, then confidence (an absent confidence ranks as medium).
 */
function findingStrength(finding: Finding): [number, number] {
  const confidence = finding.confidence
    ? CONFIDENCE_RANK[finding.confidence]
    : CONFIDENCE_RANK.medium;
  return [SEVERITY_RANK[finding.severity], confidence];
}

/**
 * Merges findings from multiple review sessions, keeping one finding per
 * path:line. On a collision the STRONGEST finding wins — more severe first,
 * then higher confidence — with ties broken by input order, so passing the
 * main review first keeps its richer context. Apply the confidence gate
 * (demoteLowConfidenceBlockingFindings) BEFORE this so each finding's
 * effective severity is settled and a low-confidence finding cannot out-rank
 * a stronger one at the same location.
 */
export function dedupeFindings(...findingLists: Finding[][]): Finding[] {
  const byKey = new Map<string, Finding>();
  const order: string[] = [];
  for (const findings of findingLists) {
    for (const finding of findings) {
      const key = `${finding.path}:${finding.line}`;
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, finding);
        order.push(key);
        continue;
      }
      const [existingSeverity, existingConfidence] = findingStrength(existing);
      const [nextSeverity, nextConfidence] = findingStrength(finding);
      // Replace only when strictly stronger; equal strength keeps the earlier
      // (main-review-first) finding.
      if (
        nextSeverity < existingSeverity ||
        (nextSeverity === existingSeverity && nextConfidence < existingConfidence)
      ) {
        byKey.set(key, finding);
      }
    }
  }
  const merged: Finding[] = [];
  for (const key of order) {
    const finding = byKey.get(key);
    if (finding) merged.push(finding);
  }
  return merged;
}

/**
 * Enforces "do not emit low-confidence P0/P1/P2 findings" in code rather than
 * trusting the prompt: a low-confidence blocking finding from a weak model
 * would otherwise flip the review to "Needs changes". Demotes to P3 (advisory)
 * instead of dropping, so the signal stays visible without blocking.
 */
export function demoteLowConfidenceBlockingFindings(findings: Finding[]): {
  findings: Finding[];
  demotedCount: number;
} {
  let demotedCount = 0;
  const result = findings.map((finding) => {
    if (finding.confidence === 'low' && BLOCKING_SEVERITIES.has(finding.severity)) {
      demotedCount += 1;
      return { ...finding, severity: 'P3' as const };
    }
    return finding;
  });
  return { findings: result, demotedCount };
}
