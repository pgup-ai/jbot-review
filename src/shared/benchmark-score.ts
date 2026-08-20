import type { Severity } from './types.ts';

export const BENCHMARK_SCHEMA_VERSION = 2;
const BENCHMARK_BOOTSTRAP_SEED = 0x4a424f54;
const BENCHMARK_BOOTSTRAP_SAMPLES = 2_000;

export type BenchmarkRiskTier = 'low' | 'medium' | 'high' | 'critical';
export type BenchmarkCacheState = 'uncached' | 'cached-same-head' | 'cached-cross-run';
export type BenchmarkDiffSize = 'small' | 'medium' | 'large' | 'very-large';

export interface BenchmarkAnchor {
  path: string;
  line: number;
}

export interface BenchmarkExpectedFinding {
  id: string;
  severity: Severity;
  severityRange: {
    highest: Severity;
    lowest: Severity;
  };
  anchors: BenchmarkAnchor[];
  trigger: string;
  acceptableFindings: string[];
  requiredEvidence: Array<{
    path: string;
    relation: string;
  }>;
  disallowedInterpretations: string[];
}

export interface BenchmarkObservedFinding extends BenchmarkAnchor {
  severity: Severity;
  title: string;
  /** Stable semantic identity supplied by an adapter; falls back to path/line/title. */
  fingerprint?: string;
  /** Adjudicated semantic match required before recall credit is awarded. */
  expectedFindingId?: string;
  /** Whether the posting pipeline retained this finding. Defaults to true. */
  retained?: boolean;
  /** Whether the claimed location is a valid diff anchor. Defaults to line > 0. */
  anchored?: boolean;
  /** Both adjudicated checks must be true before recall credit is awarded. */
  triggerComplete?: boolean;
  evidenceSupported?: boolean;
}

export interface BenchmarkCaseRun {
  caseId: string;
  riskTier: BenchmarkRiskTier;
  cacheState?: BenchmarkCacheState;
  diffSize?: BenchmarkDiffSize;
  expectedClean: boolean;
  expectedFindings: BenchmarkExpectedFinding[];
  findings: BenchmarkObservedFinding[];
  latencyMs: number;
  costUsd?: number;
}

export interface BenchmarkInterval {
  low: number;
  high: number;
}

export interface BenchmarkMetric {
  value: number | null;
  ci95: BenchmarkInterval | null;
}

export interface BenchmarkScore {
  cases: number;
  expectedFindings: number;
  retainedFindings: number;
  matchedFindings: number;
  severityWeightedRecall: BenchmarkMetric;
  precision: BenchmarkMetric;
  cleanFalsePositiveRate: BenchmarkMetric;
  anchorRate: BenchmarkMetric;
  duplicateRate: BenchmarkMetric;
  triggerCompleteness: BenchmarkMetric;
  evidenceSupportRate: BenchmarkMetric;
  semanticAdjudication: {
    complete: boolean;
    adjudicatedFindings: number;
    retainedFindings: number;
  };
  missedBySeverity: Record<Severity, number>;
  latencyMs: {
    median: BenchmarkMetric;
    p90: BenchmarkMetric;
    p95: BenchmarkMetric;
  };
  costPerRetainedFindingUsd: BenchmarkMetric;
}

export interface BenchmarkConfiguration {
  model: string;
  modelRevision: string;
  engine: string;
  engineVersion: string;
  reasoningEffort: string;
  sampling: Record<string, unknown>;
  promptVersion: string;
  corpusHash: string;
  config: Record<string, unknown>;
}

const SEVERITY_WEIGHT: Record<Severity, number> = {
  P0: 16,
  P1: 8,
  P2: 4,
  P3: 1,
  nit: 0,
};

interface CaseContribution {
  expectedWeight: number;
  matchedWeight: number;
  retained: number;
  matched: number;
  clean: number;
  cleanWithFinding: number;
  anchored: number;
  observed: number;
  duplicates: number;
  triggerComplete: number;
  triggerObserved: number;
  evidenceSupported: number;
  evidenceObserved: number;
  semanticallyAdjudicated: number;
  missedBySeverity: Record<Severity, number>;
  latencyMs: number;
  costUsd: number;
}

const SEVERITY_ORDER: Severity[] = ['P0', 'P1', 'P2', 'P3', 'nit'];

export function severityWithinRange(
  severity: Severity,
  range: BenchmarkExpectedFinding['severityRange'],
): boolean {
  const observed = SEVERITY_ORDER.indexOf(severity);
  return (
    observed >= SEVERITY_ORDER.indexOf(range.highest) &&
    observed <= SEVERITY_ORDER.indexOf(range.lowest)
  );
}

function findingKey(finding: BenchmarkObservedFinding): string {
  return (
    finding.fingerprint ??
    `${finding.path}:${finding.line}:${finding.title.trim().toLocaleLowerCase('en-US')}`
  );
}

function varianceFindingKey(finding: BenchmarkObservedFinding): string {
  return finding.expectedFindingId ?? finding.fingerprint ?? `${finding.path}:${finding.line}`;
}

interface BenchmarkVariance {
  status: 'reportable' | 'insufficient-repetitions';
  cases: number;
  minRepetitions: number;
  maxRepetitions: number;
  findingAgreement: number | null;
  latencyRelativeMad: number | null;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

export function characterizeBenchmarkVariance(runs: BenchmarkCaseRun[]): BenchmarkVariance {
  const grouped = new Map<string, BenchmarkCaseRun[]>();
  for (const run of runs) {
    const group = grouped.get(run.caseId);
    if (group) group.push(run);
    else grouped.set(run.caseId, [run]);
  }
  const repetitions = [...grouped.values()].map((group) => group.length);
  const agreements: number[] = [];
  const relativeDeviations: number[] = [];
  for (const group of grouped.values()) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        agreements.push(
          jaccard(
            new Set(
              group[left].findings
                .filter((finding) => finding.retained !== false)
                .map(varianceFindingKey),
            ),
            new Set(
              group[right].findings
                .filter((finding) => finding.retained !== false)
                .map(varianceFindingKey),
            ),
          ),
        );
      }
    }
    const median = percentile(
      group.map((run) => run.latencyMs),
      0.5,
    );
    if (median && median > 0) {
      for (const run of group) relativeDeviations.push(Math.abs(run.latencyMs - median) / median);
    }
  }
  const minRepetitions = repetitions.length > 0 ? Math.min(...repetitions) : 0;
  const maxRepetitions = repetitions.length > 0 ? Math.max(...repetitions) : 0;
  return {
    status: minRepetitions >= 3 && maxRepetitions <= 5 ? 'reportable' : 'insufficient-repetitions',
    cases: grouped.size,
    minRepetitions,
    maxRepetitions,
    findingAgreement: percentile(agreements, 0.5),
    latencyRelativeMad: percentile(relativeDeviations, 0.5),
  };
}

function scoreCase(run: BenchmarkCaseRun): CaseContribution {
  const expectedById = new Map(run.expectedFindings.map((finding) => [finding.id, finding]));
  const matchedExpected = new Set<string>();
  const groups = new Map<string, BenchmarkObservedFinding[]>();
  for (const finding of run.findings) {
    const key = findingKey(finding);
    const group = groups.get(key);
    if (group) group.push(finding);
    else groups.set(key, [finding]);
  }
  let retained = 0;
  let matched = 0;
  let matchedWeight = 0;
  let anchored = 0;
  let triggerComplete = 0;
  let triggerObserved = 0;
  let evidenceSupported = 0;
  let evidenceObserved = 0;
  let semanticallyAdjudicated = 0;
  const duplicates = run.findings.length - groups.size;

  for (const group of groups.values()) {
    const finding = group.find((candidate) => candidate.retained !== false);
    if (!finding) continue;
    retained += 1;
    if (finding.anchored ?? finding.line > 0) anchored += 1;
    if (finding.triggerComplete !== undefined && finding.evidenceSupported !== undefined) {
      semanticallyAdjudicated += 1;
    }
    if (finding.triggerComplete !== undefined) triggerObserved += 1;
    if (finding.evidenceSupported !== undefined) evidenceObserved += 1;

    const anchorMatches = (expected: BenchmarkExpectedFinding): boolean =>
      expected.anchors.some(
        (anchor) => anchor.path === finding.path && anchor.line === finding.line,
      );
    const expected = finding.expectedFindingId
      ? expectedById.get(finding.expectedFindingId)
      : undefined;
    if (!expected || matchedExpected.has(expected.id) || !anchorMatches(expected)) continue;
    if (!severityWithinRange(finding.severity, expected.severityRange)) continue;
    if (finding.triggerComplete) triggerComplete += 1;
    if (finding.evidenceSupported) evidenceSupported += 1;
    if (finding.triggerComplete !== true || finding.evidenceSupported !== true) continue;
    matchedExpected.add(expected.id);
    matched += 1;
    matchedWeight += SEVERITY_WEIGHT[expected.severity];
  }

  const missedBySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((severity) => [
      severity,
      run.expectedFindings.filter(
        (finding) => finding.severity === severity && !matchedExpected.has(finding.id),
      ).length,
    ]),
  ) as Record<Severity, number>;

  return {
    expectedWeight: run.expectedFindings.reduce(
      (sum, finding) => sum + SEVERITY_WEIGHT[finding.severity],
      0,
    ),
    matchedWeight,
    retained,
    matched,
    clean: run.expectedClean ? 1 : 0,
    cleanWithFinding: run.expectedClean && retained > 0 ? 1 : 0,
    anchored,
    observed: run.findings.length,
    duplicates,
    triggerComplete,
    triggerObserved,
    evidenceSupported,
    evidenceObserved,
    semanticallyAdjudicated,
    missedBySeverity,
    latencyMs: run.latencyMs,
    costUsd: run.costUsd ?? 0,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function aggregate(contributions: CaseContribution[]) {
  const sum = (pick: (value: CaseContribution) => number): number =>
    contributions.reduce((total, value) => total + pick(value), 0);
  const retained = sum((value) => value.retained);
  return {
    severityWeightedRecall: ratio(
      sum((value) => value.matchedWeight),
      sum((value) => value.expectedWeight),
    ),
    precision: ratio(
      sum((value) => value.matched),
      retained,
    ),
    cleanFalsePositiveRate: ratio(
      sum((value) => value.cleanWithFinding),
      sum((value) => value.clean),
    ),
    anchorRate: ratio(
      sum((value) => value.anchored),
      retained,
    ),
    duplicateRate: ratio(
      sum((value) => value.duplicates),
      sum((value) => value.observed),
    ),
    triggerCompleteness: ratio(
      sum((value) => value.triggerComplete),
      sum((value) => value.triggerObserved),
    ),
    evidenceSupportRate: ratio(
      sum((value) => value.evidenceSupported),
      sum((value) => value.evidenceObserved),
    ),
    medianLatencyMs: percentile(
      contributions.map((value) => value.latencyMs),
      0.5,
    ),
    p90LatencyMs: percentile(
      contributions.map((value) => value.latencyMs),
      0.9,
    ),
    p95LatencyMs: percentile(
      contributions.map((value) => value.latencyMs),
      0.95,
    ),
    costPerRetainedFindingUsd: ratio(
      sum((value) => value.costUsd),
      retained,
    ),
  };
}

type Aggregate = ReturnType<typeof aggregate>;
type MetricName = keyof Aggregate;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bootstrapIntervals(
  contributions: CaseContribution[],
  samples: number,
  seed: number,
): Record<MetricName, BenchmarkInterval | null> {
  const names = Object.keys(aggregate(contributions)) as MetricName[];
  const values = Object.fromEntries(names.map((name) => [name, [] as number[]])) as Record<
    MetricName,
    number[]
  >;
  if (contributions.length === 0 || samples <= 0) {
    return Object.fromEntries(names.map((name) => [name, null])) as Record<
      MetricName,
      BenchmarkInterval | null
    >;
  }

  const next = random(seed);
  for (let sample = 0; sample < samples; sample += 1) {
    const resampled = Array.from(
      { length: contributions.length },
      () => contributions[Math.floor(next() * contributions.length)],
    );
    const metrics = aggregate(resampled);
    for (const name of names) {
      const value = metrics[name];
      if (value !== null) values[name].push(value);
    }
  }

  return Object.fromEntries(
    names.map((name) => {
      const low = percentile(values[name], 0.025);
      const high = percentile(values[name], 0.975);
      return [name, low === null || high === null ? null : { low, high }];
    }),
  ) as Record<MetricName, BenchmarkInterval | null>;
}

export function scoreBenchmark(
  runs: BenchmarkCaseRun[],
  options: { bootstrapSamples?: number; seed?: number } = {},
): BenchmarkScore {
  const contributions = runs.map(scoreCase);
  const metrics = aggregate(contributions);
  const intervals = bootstrapIntervals(
    contributions,
    options.bootstrapSamples ?? BENCHMARK_BOOTSTRAP_SAMPLES,
    options.seed ?? BENCHMARK_BOOTSTRAP_SEED,
  );
  const metric = (name: MetricName): BenchmarkMetric => ({
    value: metrics[name],
    ci95: intervals[name],
  });
  const retainedFindings = contributions.reduce((sum, value) => sum + value.retained, 0);
  const adjudicatedFindings = contributions.reduce(
    (sum, value) => sum + value.semanticallyAdjudicated,
    0,
  );

  return {
    cases: runs.length,
    expectedFindings: runs.reduce((sum, run) => sum + run.expectedFindings.length, 0),
    retainedFindings,
    matchedFindings: contributions.reduce((sum, value) => sum + value.matched, 0),
    severityWeightedRecall: metric('severityWeightedRecall'),
    precision: metric('precision'),
    cleanFalsePositiveRate: metric('cleanFalsePositiveRate'),
    anchorRate: metric('anchorRate'),
    duplicateRate: metric('duplicateRate'),
    triggerCompleteness: metric('triggerCompleteness'),
    evidenceSupportRate: metric('evidenceSupportRate'),
    semanticAdjudication: {
      complete: retainedFindings === adjudicatedFindings,
      adjudicatedFindings,
      retainedFindings,
    },
    missedBySeverity: Object.fromEntries(
      SEVERITY_ORDER.map((severity) => [
        severity,
        contributions.reduce((sum, value) => sum + value.missedBySeverity[severity], 0),
      ]),
    ) as Record<Severity, number>,
    latencyMs: {
      median: metric('medianLatencyMs'),
      p90: metric('p90LatencyMs'),
      p95: metric('p95LatencyMs'),
    },
    costPerRetainedFindingUsd: metric('costPerRetainedFindingUsd'),
  };
}

interface BenchmarkQualityGate {
  status: 'passed' | 'failed' | 'adjudication-required';
  passed: boolean | null;
  reasons: string[];
  semanticAdjudication: {
    control: BenchmarkScore['semanticAdjudication'];
    treatment: BenchmarkScore['semanticAdjudication'];
  };
}

export function evaluateBenchmarkQualityGate(
  control: BenchmarkScore,
  treatment: BenchmarkScore,
  tolerance = 0.02,
  completion?: {
    controlSuccessfulRuns: number;
    treatmentSuccessfulRuns: number;
    treatmentFailedRuns: number;
  },
): BenchmarkQualityGate {
  const semanticAdjudication = {
    control: control.semanticAdjudication,
    treatment: treatment.semanticAdjudication,
  };
  const reasons: string[] = [];
  if (
    completion &&
    (completion.treatmentFailedRuns > 0 ||
      completion.treatmentSuccessfulRuns !== completion.controlSuccessfulRuns)
  ) {
    reasons.push('treatment did not complete the control run population');
  }
  if (!control.semanticAdjudication.complete || !treatment.semanticAdjudication.complete) {
    return {
      status: 'adjudication-required',
      passed: null,
      reasons: ['semantic adjudication is incomplete'],
      semanticAdjudication,
    };
  }
  if (reasons.length > 0) {
    return {
      status: 'failed',
      passed: false,
      reasons,
      semanticAdjudication,
    };
  }
  if (treatment.missedBySeverity.P0 > 0 || treatment.missedBySeverity.P1 > 0) {
    reasons.push('treatment missed a seeded P0/P1 finding');
  }
  if (
    control.cleanFalsePositiveRate.value !== null &&
    treatment.cleanFalsePositiveRate.value !== null &&
    treatment.cleanFalsePositiveRate.value > control.cleanFalsePositiveRate.value
  ) {
    reasons.push('treatment introduced a new clean false positive');
  }
  for (const [label, controlValue, treatmentValue] of [
    [
      'severity-weighted recall',
      control.severityWeightedRecall.value,
      treatment.severityWeightedRecall.value,
    ],
    ['precision', control.precision.value, treatment.precision.value],
  ] as const) {
    if (
      controlValue !== null &&
      treatmentValue !== null &&
      controlValue - treatmentValue > tolerance
    ) {
      reasons.push(`${label} regressed by more than ${tolerance * 100} percentage points`);
    }
  }
  return {
    status: reasons.length === 0 ? 'passed' : 'failed',
    passed: reasons.length === 0,
    reasons,
    semanticAdjudication,
  };
}

export function benchmarkCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(benchmarkCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareCodePoints(a, b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${benchmarkCanonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareCodePoints(left: string, right: string): number {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  return leftIndex < left.length ? 1 : rightIndex < right.length ? -1 : 0;
}

function flatten(value: unknown, prefix = ''): Map<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 0) {
      return entries.reduce((result, [key, entry]) => {
        for (const [path, serialized] of flatten(entry, prefix ? `${prefix}.${key}` : key)) {
          result.set(path, serialized);
        }
        return result;
      }, new Map<string, string>());
    }
  }
  return new Map([[prefix, benchmarkCanonicalJson(value)]]);
}

export function benchmarkConfigurationDifferences(
  control: BenchmarkConfiguration,
  treatment: BenchmarkConfiguration,
): string[] {
  const left = flatten(control);
  const right = flatten(treatment);
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key))
    .sort();
}

export function assertBenchmarkComparable(
  control: BenchmarkConfiguration,
  treatment: BenchmarkConfiguration,
  declaredTreatmentVariables: string[],
  controlEnv: Record<string, string> = {},
  treatmentEnv: Record<string, string> = {},
): void {
  const required: Array<keyof BenchmarkConfiguration> = [
    'model',
    'modelRevision',
    'engine',
    'engineVersion',
    'reasoningEffort',
    'promptVersion',
    'corpusHash',
  ];
  for (const side of [control, treatment]) {
    for (const field of required) {
      if (typeof side[field] !== 'string' || !side[field].trim()) {
        throw new Error(`Benchmark configuration requires a non-empty ${field}.`);
      }
    }
  }
  const declared = new Set(declaredTreatmentVariables);
  const envKeys = [...new Set([...Object.keys(controlEnv), ...Object.keys(treatmentEnv)])];
  const differences = [
    ...benchmarkConfigurationDifferences(control, treatment),
    ...envKeys.filter((key) => controlEnv[key] !== treatmentEnv[key]).map((key) => `env.${key}`),
  ].sort();
  const undeclared = differences.filter((difference) => !declared.has(difference));
  if (undeclared.length > 0) {
    throw new Error(
      `Benchmark arms are not comparable; undeclared difference(s): ${undeclared.join(', ')}.`,
    );
  }
  const unchanged = declaredTreatmentVariables.filter(
    (variable) => !differences.includes(variable),
  );
  if (unchanged.length > 0) {
    throw new Error(`Declared treatment variable(s) did not change: ${unchanged.join(', ')}.`);
  }
}
