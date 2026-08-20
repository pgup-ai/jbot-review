import { type BenchmarkObservedFinding } from './benchmark-score.ts';
import { VALID_SEVERITIES, type Severity } from './types.ts';

export type BenchmarkFailureClass =
  'setup' | 'timeout' | 'runner-exit' | 'signal' | 'spawn' | 'invalid-output' | 'missing-output';

export interface BenchmarkRunnerOutput {
  findings: BenchmarkObservedFinding[];
  telemetry?: string;
  costUsd?: number;
}

export interface BenchmarkProgramMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  sessions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function emptyBenchmarkProgramMetrics(): BenchmarkProgramMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    sessions: 0,
  };
}

export function classifyBenchmarkProcessFailure(error: unknown): {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  failureClass: BenchmarkFailureClass;
} {
  const failure = error as NodeJS.ErrnoException & {
    code?: string | number;
    signal?: string;
    killed?: boolean;
  };
  const exitCode = typeof failure.code === 'number' ? failure.code : null;
  const timedOut = Boolean(failure.killed);
  const signal = failure.signal ?? (timedOut ? 'SIGTERM' : null);
  return {
    exitCode,
    signal,
    timedOut,
    failureClass: timedOut
      ? 'timeout'
      : signal
        ? 'signal'
        : exitCode !== null
          ? 'runner-exit'
          : 'spawn',
  };
}

export function parseBenchmarkTelemetry(telemetry: string | undefined): BenchmarkProgramMetrics {
  const metrics = emptyBenchmarkProgramMetrics();
  if (!telemetry) return metrics;
  for (const line of telemetry.split('\n').filter(Boolean)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const row = parsed;
    if (row.kind !== 'session') continue;
    metrics.sessions += 1;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cacheReadTokens',
    ] as const) {
      if (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0) {
        metrics[key] += row[key];
      }
    }
    const cost =
      typeof row.costUsd === 'number'
        ? row.costUsd
        : typeof row.estimatedCostUsd === 'number'
          ? row.estimatedCostUsd
          : 0;
    if (Number.isFinite(cost) && cost >= 0) metrics.costUsd += cost;
  }
  return metrics;
}

export function isBenchmarkRunnerOutput(value: unknown): value is BenchmarkRunnerOutput {
  if (!isRecord(value)) return false;
  const output = value;
  if (output.telemetry !== undefined && typeof output.telemetry !== 'string') return false;
  if (
    output.costUsd !== undefined &&
    (typeof output.costUsd !== 'number' || !Number.isFinite(output.costUsd) || output.costUsd < 0)
  ) {
    return false;
  }
  return (
    Array.isArray(output.findings) &&
    output.findings.every(
      (finding) =>
        isRecord(finding) &&
        typeof finding.path === 'string' &&
        typeof finding.line === 'number' &&
        Number.isInteger(finding.line) &&
        finding.line >= 0 &&
        typeof finding.severity === 'string' &&
        VALID_SEVERITIES.has(finding.severity as Severity) &&
        typeof finding.title === 'string' &&
        (finding.fingerprint === undefined || typeof finding.fingerprint === 'string') &&
        (finding.expectedFindingId === undefined ||
          typeof finding.expectedFindingId === 'string') &&
        (finding.retained === undefined || typeof finding.retained === 'boolean') &&
        (finding.anchored === undefined || typeof finding.anchored === 'boolean') &&
        (finding.triggerComplete === undefined || typeof finding.triggerComplete === 'boolean') &&
        (finding.evidenceSupported === undefined || typeof finding.evidenceSupported === 'boolean'),
    )
  );
}
