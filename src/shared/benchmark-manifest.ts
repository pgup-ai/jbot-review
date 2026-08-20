import {
  BENCHMARK_SCHEMA_VERSION,
  assertBenchmarkComparable,
  type BenchmarkCacheState,
  type BenchmarkConfiguration,
  type BenchmarkDiffSize,
  type BenchmarkExpectedFinding,
  type BenchmarkRiskTier,
  severityWithinRange,
} from './benchmark-score.ts';
import {
  assertBenchmarkCategoryCoverage,
  validateBenchmarkCorpusMetadata,
  validateBenchmarkCounterfactuals,
  type BenchmarkCategory,
  type BenchmarkReleaseSubset,
} from './benchmark-corpus.ts';
import { isNonArrayRecord as isRecord } from './text.ts';
import { VALID_SEVERITIES, type Severity } from './types.ts';

const GITHUB_TOKEN_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'JBOT_GITHUB_TOKEN',
  'INPUT_GITHUB_TOKEN',
]);

interface BenchmarkRunner {
  command: string[];
  cwd: 'project' | 'workspace';
  fixtureMode: 'replay' | 'git';
}

export interface BenchmarkArm {
  name: string;
  configuration: BenchmarkConfiguration;
  env?: Record<string, string>;
}

export interface BenchmarkCase {
  id: string;
  riskTier: BenchmarkRiskTier;
  cacheState: BenchmarkCacheState;
  diffSize: BenchmarkDiffSize;
  expectedClean: boolean;
  expectedFindings: BenchmarkExpectedFinding[];
  categories: BenchmarkCategory[];
  subsets: BenchmarkReleaseSubset[];
  counterfactualCaseId?: string;
  counterfactualOf?: string;
  fixturePath?: string;
  repository?: string;
  privateCaseHash?: string;
  base: string;
  head: string;
}

export interface BenchmarkManifest {
  schemaVersion: number;
  name: string;
  repetitions: number;
  timeoutMs: number;
  corpusHash: string;
  qualityCorpus: boolean;
  runner: BenchmarkRunner;
  declaredTreatmentVariables: string[];
  control: BenchmarkArm;
  treatment: BenchmarkArm;
  cases: BenchmarkCase[];
}

export function parseBenchmarkPositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function isBenchmarkGitHubCredential(key: string): boolean {
  return GITHUB_TOKEN_KEYS.has(key.toUpperCase());
}

function validateArm(value: unknown, label: string): BenchmarkArm {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error(`Manifest ${label} arm requires a name.`);
  }
  if (!isRecord(value.configuration)) {
    throw new Error(`Manifest ${label} arm requires a configuration.`);
  }
  if (value.env !== undefined && !isRecord(value.env)) {
    throw new Error(`Manifest ${label} arm env must be a string map.`);
  }
  for (const [key, entry] of Object.entries(value.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string') {
      throw new Error(`Manifest ${label} arm env must be a string map.`);
    }
    if (isBenchmarkGitHubCredential(key)) {
      throw new Error(`Benchmark arm ${value.name} may not set GitHub credential ${key}.`);
    }
  }
  const configuration = value.configuration as Partial<BenchmarkConfiguration>;
  if (!isRecord(configuration.sampling) || !isRecord(configuration.config)) {
    throw new Error(`Manifest ${label} arm requires sampling and config objects.`);
  }
  return value as unknown as BenchmarkArm;
}

export function validateBenchmarkManifest(value: unknown): BenchmarkManifest {
  if (!isRecord(value)) throw new Error('Benchmark manifest must be an object.');
  if (value.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported benchmark manifest schema ${String(value.schemaVersion)}; expected ${BENCHMARK_SCHEMA_VERSION}.`,
    );
  }
  if (
    typeof value.name !== 'string' ||
    !value.name.trim() ||
    typeof value.corpusHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/i.test(value.corpusHash)
  ) {
    throw new Error('Manifest requires a name and sha256 corpusHash.');
  }
  const repetitions = parseBenchmarkPositiveInteger(value.repetitions, 'repetitions');
  const timeoutMs = parseBenchmarkPositiveInteger(value.timeoutMs, 'timeoutMs');
  if (
    !isRecord(value.runner) ||
    !Array.isArray(value.runner.command) ||
    value.runner.command.length === 0 ||
    value.runner.command.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw new Error('Manifest runner.command must be a non-empty argv array.');
  }
  if (value.runner.cwd !== 'project' && value.runner.cwd !== 'workspace') {
    throw new Error('Manifest runner.cwd must be project or workspace.');
  }
  if (value.runner.fixtureMode !== 'replay' && value.runner.fixtureMode !== 'git') {
    throw new Error('Manifest runner.fixtureMode must be replay or git.');
  }
  if (
    !Array.isArray(value.declaredTreatmentVariables) ||
    value.declaredTreatmentVariables.length === 0 ||
    value.declaredTreatmentVariables.some((entry) => typeof entry !== 'string' || !entry.trim()) ||
    new Set(value.declaredTreatmentVariables).size !== value.declaredTreatmentVariables.length
  ) {
    throw new Error('Manifest requires unique declaredTreatmentVariables.');
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('Manifest must contain at least one case.');
  }

  const ids = new Set<string>();
  for (const candidate of value.cases) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id.trim()) {
      throw new Error('Benchmark case ids must be non-empty and unique.');
    }
    if (ids.has(candidate.id)) {
      throw new Error(`Benchmark case ids must be non-empty and unique: ${candidate.id}.`);
    }
    ids.add(candidate.id);
    const hasFixture =
      typeof candidate.fixturePath === 'string' && Boolean(candidate.fixturePath.trim());
    const hasRepository =
      typeof candidate.repository === 'string' && Boolean(candidate.repository.trim());
    const hasPrivateHash =
      typeof candidate.privateCaseHash === 'string' &&
      /^sha256:[a-f0-9]{64}$/i.test(candidate.privateCaseHash);
    if ([hasFixture, hasRepository, hasPrivateHash].filter(Boolean).length !== 1) {
      throw new Error(
        `Case ${candidate.id} requires exactly one fixturePath, repository, or privateCaseHash.`,
      );
    }
    if (
      typeof candidate.base !== 'string' ||
      !candidate.base.trim() ||
      typeof candidate.head !== 'string' ||
      !candidate.head.trim()
    ) {
      throw new Error(`Case ${candidate.id} requires base and head identifiers.`);
    }
    if (
      (hasRepository || hasPrivateHash) &&
      (!/^[a-f0-9]{40}$/i.test(candidate.base) || !/^[a-f0-9]{40}$/i.test(candidate.head))
    ) {
      throw new Error(`Repository case ${candidate.id} requires immutable base/head SHAs.`);
    }
    if (!['low', 'medium', 'high', 'critical'].includes(String(candidate.riskTier))) {
      throw new Error(`Case ${candidate.id} has an invalid riskTier.`);
    }
    if (
      !['uncached', 'cached-same-head', 'cached-cross-run'].includes(String(candidate.cacheState))
    ) {
      throw new Error(`Case ${candidate.id} has an invalid cacheState.`);
    }
    if (!['small', 'medium', 'large', 'very-large'].includes(String(candidate.diffSize))) {
      throw new Error(`Case ${candidate.id} has an invalid diffSize.`);
    }
    if (
      typeof candidate.expectedClean !== 'boolean' ||
      !Array.isArray(candidate.expectedFindings)
    ) {
      throw new Error(`Case ${candidate.id} requires expectedClean and expectedFindings.`);
    }
    validateBenchmarkCorpusMetadata(candidate);
    if (candidate.expectedClean && candidate.expectedFindings.length > 0) {
      throw new Error(`Clean case ${candidate.id} cannot declare expected findings.`);
    }
    if (!candidate.expectedClean && candidate.expectedFindings.length === 0) {
      throw new Error(`Non-clean case ${candidate.id} must declare an expected finding.`);
    }
    const expectedIds = new Set<string>();
    for (const finding of candidate.expectedFindings) {
      if (
        !isRecord(finding) ||
        typeof finding.id !== 'string' ||
        !finding.id.trim() ||
        expectedIds.has(finding.id) ||
        typeof finding.severity !== 'string' ||
        !VALID_SEVERITIES.has(finding.severity as Severity) ||
        !isRecord(finding.severityRange) ||
        typeof finding.severityRange.highest !== 'string' ||
        !VALID_SEVERITIES.has(finding.severityRange.highest as Severity) ||
        typeof finding.severityRange.lowest !== 'string' ||
        !VALID_SEVERITIES.has(finding.severityRange.lowest as Severity) ||
        !severityWithinRange(finding.severity as Severity, {
          highest: finding.severityRange.highest as Severity,
          lowest: finding.severityRange.lowest as Severity,
        }) ||
        typeof finding.trigger !== 'string' ||
        !finding.trigger.trim() ||
        !Array.isArray(finding.acceptableFindings) ||
        finding.acceptableFindings.length === 0 ||
        finding.acceptableFindings.some(
          (interpretation) => typeof interpretation !== 'string' || !interpretation.trim(),
        ) ||
        !Array.isArray(finding.requiredEvidence) ||
        finding.requiredEvidence.length === 0 ||
        finding.requiredEvidence.some(
          (evidence) =>
            !isRecord(evidence) ||
            typeof evidence.path !== 'string' ||
            !evidence.path.trim() ||
            typeof evidence.relation !== 'string' ||
            !evidence.relation.trim(),
        ) ||
        !Array.isArray(finding.disallowedInterpretations) ||
        finding.disallowedInterpretations.length === 0 ||
        finding.disallowedInterpretations.some(
          (interpretation) => typeof interpretation !== 'string' || !interpretation.trim(),
        ) ||
        !Array.isArray(finding.anchors) ||
        finding.anchors.length === 0 ||
        finding.anchors.some(
          (anchor) =>
            !isRecord(anchor) ||
            typeof anchor.path !== 'string' ||
            !anchor.path.trim() ||
            !Number.isInteger(anchor.line) ||
            (anchor.line as number) < 0,
        )
      ) {
        throw new Error(`Case ${candidate.id} has an invalid expected finding.`);
      }
      const anchors = finding.anchors as Array<{ path: string; line: number }>;
      const requiredEvidence = finding.requiredEvidence as Array<{
        path: string;
        relation: string;
      }>;
      if (
        value.qualityCorpus === true &&
        (finding.acceptableFindings.length < 2 ||
          !requiredEvidence.some((evidence) => evidence.path !== anchors[0].path))
      ) {
        throw new Error(
          `Case ${candidate.id} expected findings require alternatives and cross-file evidence.`,
        );
      }
      expectedIds.add(finding.id);
    }
  }

  if (typeof value.qualityCorpus !== 'boolean') {
    throw new Error('Manifest requires qualityCorpus.');
  }
  if (value.qualityCorpus) {
    const cases = value.cases as unknown as BenchmarkCase[];
    if (cases.length < 100) throw new Error('Quality corpus requires at least 100 cases.');
    assertBenchmarkCategoryCoverage(cases);
    validateBenchmarkCounterfactuals(cases);
  }

  const control = validateArm(value.control, 'control');
  const treatment = validateArm(value.treatment, 'treatment');
  assertBenchmarkComparable(
    control.configuration,
    treatment.configuration,
    value.declaredTreatmentVariables,
    control.env,
    treatment.env,
  );
  if (
    control.configuration.corpusHash !== value.corpusHash ||
    treatment.configuration.corpusHash !== value.corpusHash
  ) {
    throw new Error('Both benchmark arms must use the manifest corpusHash.');
  }

  return {
    ...(value as unknown as BenchmarkManifest),
    repetitions,
    timeoutMs,
    control,
    treatment,
  };
}
