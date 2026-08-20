import type { BenchmarkArm, BenchmarkCase } from './benchmark-manifest.ts';
import {
  BENCHMARK_SCHEMA_VERSION,
  benchmarkCanonicalJson,
  type BenchmarkCaseRun,
} from './benchmark-score.ts';
import {
  isBenchmarkRunnerOutput,
  type BenchmarkFailureClass,
  type BenchmarkProgramMetrics,
} from './benchmark-runner.ts';

export interface BenchmarkCaseRow extends BenchmarkCaseRun {
  schemaVersion: number;
  arm: 'control' | 'treatment';
  armName: string;
  repetition: number;
  base: string;
  head: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  failureClass: BenchmarkFailureClass | null;
  program: BenchmarkProgramMetrics;
}

const FAILURE_CLASSES = new Set<BenchmarkFailureClass>([
  'setup',
  'timeout',
  'runner-exit',
  'signal',
  'spawn',
  'invalid-output',
  'missing-output',
]);
const PROGRAM_METRICS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'costUsd',
  'sessions',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateRow(
  value: unknown,
  cases: Map<string, BenchmarkCase>,
  arms: Record<'control' | 'treatment', BenchmarkArm>,
  repetitions: number,
): BenchmarkCaseRow {
  if (!isRecord(value)) throw new Error('Adjudicated benchmark rows must be objects.');
  const row = value;
  if (row.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new Error(`Unsupported adjudicated benchmark schema for case ${String(row.caseId)}.`);
  }
  if (row.arm !== 'control' && row.arm !== 'treatment') {
    throw new Error(`Invalid adjudicated benchmark arm for case ${String(row.caseId)}.`);
  }
  const benchmarkCase = typeof row.caseId === 'string' ? cases.get(row.caseId) : undefined;
  if (!benchmarkCase) throw new Error(`Unknown adjudicated benchmark case ${String(row.caseId)}.`);
  if (
    !Number.isInteger(row.repetition) ||
    (row.repetition as number) < 1 ||
    (row.repetition as number) > repetitions
  ) {
    throw new Error(`Invalid repetition for adjudicated benchmark case ${benchmarkCase.id}.`);
  }
  if (
    row.armName !== arms[row.arm].name ||
    row.base !== benchmarkCase.base ||
    row.head !== benchmarkCase.head ||
    row.riskTier !== benchmarkCase.riskTier ||
    row.cacheState !== benchmarkCase.cacheState ||
    row.diffSize !== benchmarkCase.diffSize ||
    row.expectedClean !== benchmarkCase.expectedClean ||
    benchmarkCanonicalJson(row.expectedFindings) !==
      benchmarkCanonicalJson(benchmarkCase.expectedFindings)
  ) {
    throw new Error(`Adjudicated benchmark metadata changed for case ${benchmarkCase.id}.`);
  }
  if (!isBenchmarkRunnerOutput({ findings: row.findings })) {
    throw new Error(`Invalid adjudicated findings for case ${benchmarkCase.id}.`);
  }
  if (
    !isNonNegativeNumber(row.latencyMs) ||
    (row.costUsd !== undefined && !isNonNegativeNumber(row.costUsd)) ||
    (row.exitCode !== null && !Number.isInteger(row.exitCode)) ||
    (row.signal !== null && typeof row.signal !== 'string') ||
    typeof row.timedOut !== 'boolean' ||
    (row.failureClass !== null && !FAILURE_CLASSES.has(row.failureClass as BenchmarkFailureClass))
  ) {
    throw new Error(`Invalid execution data for adjudicated benchmark case ${benchmarkCase.id}.`);
  }
  let executionConsistent: boolean;
  switch (row.failureClass) {
    case null:
      executionConsistent = row.exitCode === 0 && row.signal === null && !row.timedOut;
      break;
    case 'timeout':
      executionConsistent = row.timedOut && row.signal !== null;
      break;
    case 'signal':
      executionConsistent = !row.timedOut && row.signal !== null;
      break;
    case 'runner-exit':
    case 'invalid-output':
    case 'missing-output':
      executionConsistent =
        !row.timedOut && row.signal === null && row.exitCode !== null && row.exitCode !== 0;
      break;
    default:
      executionConsistent = !row.timedOut && row.signal === null && row.exitCode === null;
  }
  if (!executionConsistent) {
    throw new Error(
      `Contradictory execution data for adjudicated benchmark case ${benchmarkCase.id}.`,
    );
  }
  if (!isRecord(row.program)) {
    throw new Error(`Invalid program metrics for adjudicated benchmark case ${benchmarkCase.id}.`);
  }
  const program = row.program;
  if (PROGRAM_METRICS.some((metric) => !isNonNegativeNumber(program[metric]))) {
    throw new Error(`Invalid program metrics for adjudicated benchmark case ${benchmarkCase.id}.`);
  }
  return row as unknown as BenchmarkCaseRow;
}

export function validateAdjudicatedBenchmarkRows(
  values: unknown[],
  benchmarkCases: BenchmarkCase[],
  arms: Record<'control' | 'treatment', BenchmarkArm>,
  repetitions: number,
): BenchmarkCaseRow[] {
  const cases = new Map(benchmarkCases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));
  const rows = values.map((value) => validateRow(value, cases, arms, repetitions));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.arm}:${row.caseId}:${row.repetition}`;
    if (keys.has(key)) throw new Error(`Duplicate adjudicated benchmark row ${key}.`);
    keys.add(key);
  }
  const expectedRows = benchmarkCases.length * repetitions * 2;
  if (rows.length !== expectedRows) {
    throw new Error(
      `Adjudicated benchmark input has ${rows.length} rows; expected ${expectedRows}.`,
    );
  }
  return rows;
}
