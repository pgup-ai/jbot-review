import { isAbsolute, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

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

interface CompetitorAdapterOptions {
  repositoryRoot?: string;
}

const SEVERITY_ALIASES: Record<string, Severity> = {
  p0: 'P0',
  blocker: 'P0',
  critical: 'P0',
  p1: 'P1',
  error: 'P1',
  high: 'P1',
  p2: 'P2',
  medium: 'P2',
  warning: 'P2',
  p3: 'P3',
  low: 'P3',
  note: 'P3',
  none: 'P3',
  info: 'P3',
  informational: 'P3',
  nit: 'nit',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSeverity(value: unknown): Severity | undefined {
  return typeof value === 'string' ? SEVERITY_ALIASES[value.trim().toLowerCase()] : undefined;
}

function githubBodyFinding(body: unknown): { severity: Severity; title: string } | undefined {
  if (typeof body !== 'string') return undefined;
  const match =
    /^\s*\*\*(P[0-3]|nit|critical|high|medium|low|error|warning|note|info)(?:\s*[·:][^*]+)?\*\*(?:\s+\([^)]*\))?\s*(?:—|-|:)\s*([^\n]+)/i.exec(
      body,
    ) ??
    /^\s*(?:#+\s*)?\[?(P[0-3]|nit|critical|high|medium|low|error|warning|note|info)\]?\s*(?:—|-|:)\s*([^\n]+)/im.exec(
      body,
    );
  const severity = normalizeSeverity(match?.[1]);
  const title = match?.[2]?.trim();
  return severity && title ? { severity, title } : undefined;
}

function messageString(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.text === 'string'
    ? value.text
    : typeof value.markdown === 'string'
      ? value.markdown
      : undefined;
}

function sarifRule(
  run: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const tool = isRecord(run.tool) ? run.tool : undefined;
  const driver = tool && isRecord(tool.driver) ? tool.driver : undefined;
  const rules = driver && Array.isArray(driver.rules) ? driver.rules : [];
  const rule = Number.isInteger(result.ruleIndex)
    ? rules[result.ruleIndex as number]
    : rules.find(
        (candidate) =>
          isRecord(candidate) &&
          typeof result.ruleId === 'string' &&
          candidate.id === result.ruleId,
      );
  return isRecord(rule) ? rule : undefined;
}

function sarifMessage(
  run: Record<string, unknown>,
  result: Record<string, unknown>,
): string | undefined {
  if (!isRecord(result.message)) return undefined;
  if (typeof result.message.text === 'string') return result.message.text;
  const id = typeof result.message.id === 'string' ? result.message.id : undefined;
  if (!id) return undefined;
  const tool = isRecord(run.tool) ? run.tool : undefined;
  const driver = tool && isRecord(tool.driver) ? tool.driver : undefined;
  const rule = sarifRule(run, result);
  const ruleStrings =
    isRecord(rule) && isRecord(rule.messageStrings) ? rule.messageStrings : undefined;
  const globalStrings =
    driver && isRecord(driver.globalMessageStrings) ? driver.globalMessageStrings : undefined;
  return messageString(ruleStrings?.[id]) ?? messageString(globalStrings?.[id]) ?? id;
}

function sarifBaseUri(
  run: Record<string, unknown>,
  id: string,
  seen = new Set<string>(),
): string | undefined {
  if (seen.has(id) || !isRecord(run.originalUriBaseIds)) return undefined;
  seen.add(id);
  const entry = run.originalUriBaseIds[id];
  if (!isRecord(entry) || typeof entry.uri !== 'string') return undefined;
  if (typeof entry.uriBaseId !== 'string') return entry.uri;
  const base = sarifBaseUri(run, entry.uriBaseId, seen);
  if (!base) return undefined;
  try {
    return new URL(entry.uri, base).href;
  } catch {
    return undefined;
  }
}

function repositoryPath(path: string, repositoryRoot?: string): string {
  const windowsPath = win32.isAbsolute(path);
  const windowsRoot = repositoryRoot ? win32.isAbsolute(repositoryRoot) : false;
  const absolute = windowsPath || isAbsolute(path);
  if (absolute && repositoryRoot && windowsPath !== windowsRoot) return '';
  const pathApi = windowsPath ? win32 : { isAbsolute, relative, resolve };
  const local =
    absolute && repositoryRoot ? pathApi.relative(pathApi.resolve(repositoryRoot), path) : path;
  const portable = local.replaceAll('\\', '/').replace(/^\.\//, '');
  return !portable ||
    (absolute && !repositoryRoot) ||
    pathApi.isAbsolute(local) ||
    portable.startsWith('/') ||
    portable.split('/').includes('..')
    ? ''
    : portable;
}

function sarifArtifactPath(
  run: Record<string, unknown>,
  artifact: Record<string, unknown> | undefined,
  repositoryRoot?: string,
): string {
  if (!artifact || typeof artifact.uri !== 'string') return '';
  let uri = artifact.uri;
  if (win32.isAbsolute(uri)) return repositoryPath(uri, repositoryRoot);
  if (typeof artifact.uriBaseId === 'string') {
    const base = sarifBaseUri(run, artifact.uriBaseId);
    if (!base) return '';
    try {
      uri = new URL(uri, base).href;
    } catch {
      return '';
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    try {
      return repositoryPath(decodeURIComponent(uri.split(/[?#]/, 1)[0]), repositoryRoot);
    } catch {
      return '';
    }
  }
  if (parsed.protocol !== 'file:') return '';
  try {
    const filePath = fileURLToPath(parsed);
    return repositoryPath(
      repositoryRoot && win32.isAbsolute(repositoryRoot) && /^\/[a-z]:\//i.test(filePath)
        ? filePath.slice(1)
        : filePath,
      repositoryRoot,
    );
  } catch {
    return '';
  }
}

function observedFinding(value: unknown): BenchmarkObservedFinding | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    !Number.isInteger(value.line) ||
    (value.line as number) < 0 ||
    typeof value.title !== 'string' ||
    typeof value.severity !== 'string' ||
    !VALID_SEVERITIES.has(value.severity as Severity) ||
    (value.fingerprint !== undefined && typeof value.fingerprint !== 'string') ||
    (value.expectedFindingId !== undefined && typeof value.expectedFindingId !== 'string') ||
    (value.retained !== undefined && typeof value.retained !== 'boolean') ||
    (value.anchored !== undefined && typeof value.anchored !== 'boolean') ||
    (value.triggerComplete !== undefined && typeof value.triggerComplete !== 'boolean') ||
    (value.evidenceSupported !== undefined && typeof value.evidenceSupported !== 'boolean')
  ) {
    return undefined;
  }
  return {
    path: value.path,
    line: value.line as number,
    title: value.title,
    severity: value.severity as Severity,
    ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}),
    ...(typeof value.expectedFindingId === 'string'
      ? { expectedFindingId: value.expectedFindingId }
      : {}),
    ...(typeof value.retained === 'boolean' ? { retained: value.retained } : {}),
    ...(typeof value.anchored === 'boolean' ? { anchored: value.anchored } : {}),
    ...(typeof value.triggerComplete === 'boolean'
      ? { triggerComplete: value.triggerComplete }
      : {}),
    ...(typeof value.evidenceSupported === 'boolean'
      ? { evidenceSupported: value.evidenceSupported }
      : {}),
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
    const bodyFinding = githubBodyFinding(entry.body);
    const finding = observedFinding({
      path: entry.path,
      line: entry.line ?? entry.original_line,
      severity: normalizeSeverity(entry.severity) ?? bodyFinding?.severity,
      title:
        typeof entry.title === 'string' && entry.title.trim() ? entry.title : bodyFinding?.title,
      fingerprint:
        typeof entry.id === 'string' || typeof entry.id === 'number' ? String(entry.id) : undefined,
    });
    if (!finding) {
      throw new Error('github-review comments require path, line, severity, and title.');
    }
    return finding;
  });
}

function normalizeSarif(
  input: unknown,
  options: CompetitorAdapterOptions,
): BenchmarkObservedFinding[] {
  if (!isRecord(input) || !Array.isArray(input.runs)) throw new Error('sarif input requires runs.');
  const findings: BenchmarkObservedFinding[] = [];
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
      const message = sarifMessage(run, result);
      const artifactIndex = isRecord(artifact) ? artifact.index : undefined;
      const indexedArtifact =
        Number.isInteger(artifactIndex) && Array.isArray(run.artifacts)
          ? run.artifacts[artifactIndex as number]
          : undefined;
      const indexedLocation = isRecord(indexedArtifact) ? indexedArtifact.location : undefined;
      const resolvedArtifact = isRecord(artifact)
        ? { ...(isRecord(indexedLocation) ? indexedLocation : {}), ...artifact }
        : undefined;
      const path = sarifArtifactPath(run, resolvedArtifact, options.repositoryRoot);
      const line =
        isRecord(region) && Number.isInteger(region.startLine) ? (region.startLine as number) : 0;
      const title = message ?? result.ruleId;
      const rule = sarifRule(run, result);
      const defaultConfiguration =
        rule && isRecord(rule.defaultConfiguration) ? rule.defaultConfiguration : undefined;
      const level =
        typeof result.level === 'string'
          ? result.level
          : typeof result.kind === 'string' && result.kind !== 'fail'
            ? 'none'
            : typeof defaultConfiguration?.level === 'string'
              ? defaultConfiguration.level
              : 'warning';
      const resultFingerprints = isRecord(result.partialFingerprints)
        ? result.partialFingerprints
        : isRecord(result.fingerprints)
          ? result.fingerprints
          : undefined;
      const finding = observedFinding({
        path,
        line,
        severity: normalizeSeverity(level),
        title,
        anchored: Boolean(path) && line > 0,
        fingerprint:
          resultFingerprints && Object.keys(resultFingerprints).length > 0
            ? `sarif:${benchmarkCanonicalJson(resultFingerprints)}`
            : `${String(result.ruleId ?? 'result')}:${path}:${line}:${String(title)}`,
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
  options: CompetitorAdapterOptions = {},
): BenchmarkObservedFinding[] {
  if (adapter === 'benchmark-json') return normalizeBenchmarkJson(input);
  if (adapter === 'github-review') return normalizeGitHubReview(input);
  if (adapter === 'sarif') return normalizeSarif(input, options);
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
  const mismatches: string[] = (
    ['model', 'modelRevision', 'endpoint', 'reasoningEffort'] as const
  ).filter((field) => control[field] !== competitor[field]);
  if (benchmarkCanonicalJson(control.sampling) !== benchmarkCanonicalJson(competitor.sampling)) {
    mismatches.push('sampling');
  }
  return { sameModelComparable: mismatches.length === 0, mismatches };
}
