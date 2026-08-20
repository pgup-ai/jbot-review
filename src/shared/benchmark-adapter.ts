import { benchmarkCanonicalJson, type BenchmarkObservedFinding } from './benchmark-score.ts';
import { VALID_SEVERITIES, type Severity } from './types.ts';

export type CompetitorAdapter = 'benchmark-json' | 'github-review' | 'sarif';

export interface CompetitorModelConfiguration {
  model: string;
  modelRevision: string;
  endpoint: string;
  reasoningEffort: string;
  sampling: Record<string, unknown>;
}

interface CompetitorComparability {
  sameModelComparable: boolean;
  mismatches: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function observedFinding(value: unknown): BenchmarkObservedFinding | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !Number.isInteger(value.line) ||
    (value.line as number) < 0 ||
    typeof value.title !== 'string' ||
    typeof value.severity !== 'string' ||
    !VALID_SEVERITIES.has(value.severity as Severity)
  ) {
    return undefined;
  }
  return {
    path: value.path,
    line: value.line as number,
    title: value.title,
    severity: value.severity as Severity,
    ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}),
  };
}

function normalizeBenchmarkJson(input: unknown): BenchmarkObservedFinding[] {
  const values = Array.isArray(input) ? input : isRecord(input) ? input.findings : undefined;
  if (!Array.isArray(values)) throw new Error('benchmark-json input requires findings.');
  const findings = values.map(observedFinding);
  if (findings.some((finding) => !finding)) {
    throw new Error('benchmark-json input contains an invalid finding.');
  }
  return findings as BenchmarkObservedFinding[];
}

function normalizeGitHubReview(input: unknown): BenchmarkObservedFinding[] {
  if (!Array.isArray(input)) throw new Error('github-review input must be an array.');
  return input.map((entry) => {
    if (!isRecord(entry)) throw new Error('github-review input contains an invalid comment.');
    const finding = observedFinding({
      path: entry.path,
      line: entry.line,
      severity: entry.severity,
      title: entry.title,
      fingerprint: entry.id,
    });
    if (!finding) {
      throw new Error('github-review comments require path, line, severity, and title.');
    }
    return finding;
  });
}

function normalizeSarif(input: unknown): BenchmarkObservedFinding[] {
  if (!isRecord(input) || !Array.isArray(input.runs)) throw new Error('sarif input requires runs.');
  const findings: BenchmarkObservedFinding[] = [];
  const severity: Record<string, Severity> = { error: 'P1', warning: 'P2', note: 'P3', none: 'P3' };
  for (const run of input.runs) {
    if (!isRecord(run) || (run.results !== undefined && !Array.isArray(run.results))) {
      throw new Error('sarif input contains an invalid run.');
    }
    if (!Array.isArray(run.results)) continue;
    for (const result of run.results) {
      if (
        !isRecord(result) ||
        (result.locations !== undefined && !Array.isArray(result.locations))
      ) {
        throw new Error('sarif input contains an invalid result.');
      }
      const location = Array.isArray(result.locations) ? result.locations[0] : undefined;
      const physical = isRecord(location) ? location.physicalLocation : undefined;
      const artifact = isRecord(physical) ? physical.artifactLocation : undefined;
      const region = isRecord(physical) ? physical.region : undefined;
      const message = isRecord(result.message) ? result.message.text : undefined;
      const finding = observedFinding({
        path: isRecord(artifact) && typeof artifact.uri === 'string' ? artifact.uri : '',
        line: isRecord(region) && Number.isInteger(region.startLine) ? region.startLine : 0,
        severity: severity[typeof result.level === 'string' ? result.level : 'warning'],
        title: typeof message === 'string' ? message : result.ruleId,
        fingerprint: result.ruleId,
      });
      if (!finding) throw new Error('sarif result is missing a supported location or severity.');
      findings.push(finding);
    }
  }
  return findings;
}

export function normalizeCompetitorFindings(
  adapter: CompetitorAdapter,
  input: unknown,
): BenchmarkObservedFinding[] {
  if (adapter === 'benchmark-json') return normalizeBenchmarkJson(input);
  if (adapter === 'github-review') return normalizeGitHubReview(input);
  if (adapter === 'sarif') return normalizeSarif(input);
  throw new Error(`Unsupported competitor adapter: ${String(adapter)}.`);
}

export function assessCompetitorComparability(
  control: CompetitorModelConfiguration,
  competitor: CompetitorModelConfiguration,
): CompetitorComparability {
  for (const configuration of [control, competitor]) {
    for (const field of ['model', 'modelRevision', 'endpoint', 'reasoningEffort'] as const) {
      if (typeof configuration[field] !== 'string' || !configuration[field].trim()) {
        throw new Error(`Competitor configuration requires ${field}.`);
      }
    }
    if (!isRecord(configuration.sampling)) {
      throw new Error('Competitor configuration requires sampling.');
    }
  }
  const mismatches = (['model', 'modelRevision', 'endpoint', 'reasoningEffort'] as const)
    .filter((field) => control[field] !== competitor[field])
    .map(String);
  if (benchmarkCanonicalJson(control.sampling) !== benchmarkCanonicalJson(competitor.sampling)) {
    mismatches.push('sampling');
  }
  return { sameModelComparable: mismatches.length === 0, mismatches };
}
