import type { Finding, Severity } from './types.ts';

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

const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2']);

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
