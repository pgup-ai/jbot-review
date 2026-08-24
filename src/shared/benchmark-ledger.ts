import { createHash } from 'node:crypto';

import { benchmarkCanonicalJson } from './benchmark-score.ts';
import { isFiniteNumber, isNonArrayRecord as isRecord, isNonEmptyString } from './text.ts';

interface BenchmarkLedgerArm {
  name: string;
  model: string;
  modelRevision: string;
  engine: string;
  engineVersion: string;
  reasoningEffort: string;
  promptVersion: string;
  successfulRuns: number;
  failedRuns: number;
  severityWeightedRecall: number | null;
  precision: number | null;
  cleanFalsePositiveRate: number | null;
  missedP0: number;
  missedP1: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  variance: 'reportable' | 'insufficient-repetitions';
}

export interface BenchmarkLedgerRow {
  schemaVersion: 1;
  date: string;
  jbotSha: string;
  branch: string;
  corpusHash: string;
  subset: string;
  subsetCases: number;
  repetitions: number;
  fixtureMode: 'git' | 'replay';
  control: BenchmarkLedgerArm;
  treatment: BenchmarkLedgerArm;
  gate: 'passed' | 'failed' | 'adjudication-required';
  gateReasons: string[];
  mergeGateSatisfied: boolean;
  auditDoc?: string;
  resultsHash: string;
}

function pick(summary: Record<string, unknown>, path: string): unknown {
  let current: unknown = summary;
  for (const key of path.split('.')) {
    if (!isRecord(current) || current[key] === undefined) {
      throw new Error(`benchmark summary is missing ${path}`);
    }
    current = current[key];
  }
  return current;
}

function str(summary: Record<string, unknown>, path: string): string {
  const value = pick(summary, path);
  if (!isNonEmptyString(value)) {
    throw new Error(`benchmark summary ${path} must be a non-empty string`);
  }
  return value;
}

function num(summary: Record<string, unknown>, path: string): number {
  const value = pick(summary, path);
  if (!isFiniteNumber(value)) {
    throw new Error(`benchmark summary ${path} must be a finite number`);
  }
  return value;
}

function metricValue(summary: Record<string, unknown>, path: string): number | null {
  const value = pick(summary, path);
  if (!isRecord(value) || (value.value !== null && !isFiniteNumber(value.value))) {
    throw new Error(`benchmark summary ${path} must be a metric`);
  }
  return value.value as number | null;
}

function oneOf<T extends string>(
  summary: Record<string, unknown>,
  path: string,
  allowed: readonly T[],
): T {
  const value = pick(summary, path);
  if (!allowed.includes(value as T)) {
    throw new Error(`benchmark summary ${path} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function deriveArm(
  summary: Record<string, unknown>,
  side: 'control' | 'treatment',
): BenchmarkLedgerArm {
  return {
    name: str(summary, `${side}.name`),
    model: str(summary, `${side}.configuration.model`),
    modelRevision: str(summary, `${side}.configuration.modelRevision`),
    engine: str(summary, `${side}.configuration.engine`),
    engineVersion: str(summary, `${side}.configuration.engineVersion`),
    reasoningEffort: str(summary, `${side}.configuration.reasoningEffort`),
    promptVersion: str(summary, `${side}.configuration.promptVersion`),
    successfulRuns: num(summary, `${side}.successfulRuns`),
    failedRuns: num(summary, `${side}.failedRuns`),
    severityWeightedRecall: metricValue(summary, `${side}.score.severityWeightedRecall`),
    precision: metricValue(summary, `${side}.score.precision`),
    cleanFalsePositiveRate: metricValue(summary, `${side}.score.cleanFalsePositiveRate`),
    missedP0: num(summary, `${side}.score.missedBySeverity.P0`),
    missedP1: num(summary, `${side}.score.missedBySeverity.P1`),
    latencyP50Ms: metricValue(summary, `${side}.score.latencyMs.median`),
    latencyP95Ms: metricValue(summary, `${side}.score.latencyMs.p95`),
    inputTokens: num(summary, `${side}.program.inputTokens`),
    outputTokens: num(summary, `${side}.program.outputTokens`),
    reasoningTokens: num(summary, `${side}.program.reasoningTokens`),
    cacheReadTokens: num(summary, `${side}.program.cacheReadTokens`),
    variance: oneOf(summary, `${side}.variance.status`, [
      'reportable',
      'insufficient-repetitions',
    ] as const),
  };
}

/**
 * Whitelist projection of a `review-benchmark` summary.json into a committed
 * ledger row: model identity and outcome metrics only — endpoints, sampling,
 * env config, and spend never leave the local results directory.
 */
export function deriveBenchmarkLedgerRow(
  summary: unknown,
  context: { jbotSha: string; branch: string; auditDoc?: string },
): BenchmarkLedgerRow {
  if (!isRecord(summary)) throw new Error('benchmark summary must be an object');
  const treatmentCommit = str(summary, 'treatmentCommit');
  if (treatmentCommit !== context.jbotSha) {
    throw new Error(
      `summary treatmentCommit ${treatmentCommit} does not match HEAD ${context.jbotSha}; append from the benchmarked revision`,
    );
  }
  const reasons = pick(summary, 'qualityGate.reasons');
  if (!Array.isArray(reasons) || reasons.some((reason) => typeof reason !== 'string')) {
    throw new Error('benchmark summary qualityGate.reasons must be strings');
  }
  const mergeGateSatisfied = pick(summary, 'mergeGate.satisfied');
  if (typeof mergeGateSatisfied !== 'boolean') {
    throw new Error('benchmark summary mergeGate.satisfied must be a boolean');
  }
  return {
    schemaVersion: 1,
    date: str(summary, 'generatedAt'),
    jbotSha: context.jbotSha,
    branch: context.branch,
    corpusHash: str(summary, 'corpusHash'),
    subset: str(summary, 'subset'),
    subsetCases: num(summary, 'subsetCases'),
    repetitions: num(summary, 'repetitions'),
    fixtureMode: oneOf(summary, 'fixtureMode', ['git', 'replay'] as const),
    control: deriveArm(summary, 'control'),
    treatment: deriveArm(summary, 'treatment'),
    gate: oneOf(summary, 'qualityGate.status', [
      'passed',
      'failed',
      'adjudication-required',
    ] as const),
    gateReasons: [...reasons],
    mergeGateSatisfied,
    ...(context.auditDoc ? { auditDoc: context.auditDoc } : {}),
    resultsHash: `sha256:${createHash('sha256').update(benchmarkCanonicalJson(summary)).digest('hex')}`,
  };
}
