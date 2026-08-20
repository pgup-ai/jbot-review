import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIN_RATE_SAMPLE = 20;

type Row = Record<string, unknown> & { kind?: string; _source?: number };

interface Distribution {
  count: number;
  p50?: number;
  p90?: number;
  p95?: number;
}

interface Rate {
  numerator: number;
  denominator: number;
  rate: number | null;
  status: 'reported' | 'insufficient-sample' | 'zero-denominator';
}

export function distribution(values: number[]): Distribution {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { count: 0 };
  const at = (quantile: number): number =>
    sorted[Math.min(Math.ceil(quantile * sorted.length) - 1, sorted.length - 1)];
  return { count: sorted.length, p50: at(0.5), p90: at(0.9), p95: at(0.95) };
}

export function guardedRate(
  numerator: number,
  denominator: number,
  sampleCount = denominator,
): Rate {
  return {
    numerator,
    denominator,
    rate: sampleCount >= MIN_RATE_SAMPLE && denominator > 0 ? numerator / denominator : null,
    status:
      sampleCount < MIN_RATE_SAMPLE
        ? 'insufficient-sample'
        : denominator > 0
          ? 'reported'
          : 'zero-denominator',
  };
}

export function aggregatePerformance(rows: Row[]): Record<string, unknown> {
  const byKind = (kind: string): Row[] => rows.filter((row) => row.kind === kind);
  const phases = byKind('phase');
  const tools = byKind('tool');
  const explorations = byKind('exploration');
  const sessions = byKind('session');
  const findings = byKind('finding');
  const runs = byKind('run');
  const group = (input: Row[], key: string): Map<string, Row[]> => {
    const result = new Map<string, Row[]>();
    for (const row of input) {
      const value = typeof row[key] === 'string' ? row[key] : 'unknown';
      result.set(value, [...(result.get(value) ?? []), row]);
    }
    return result;
  };
  const number = (row: Row, key: string): number | undefined =>
    typeof row[key] === 'number' && Number.isFinite(row[key]) ? row[key] : undefined;
  const phaseTime = Object.fromEntries(
    [...group(phases, 'phase')].flatMap(([phase, values]) =>
      [...group(values, 'scope')].map(([scope, scoped]) => [
        `${scope}:${phase}`,
        distribution(scoped.flatMap((row) => number(row, 'durationMs') ?? [])),
      ]),
    ),
  );
  const toolBytes = tools.reduce((sum, row) => sum + (number(row, 'outputBytesAfterCap') ?? 0), 0);
  const diffTools = tools.filter((row) => row.toolClass === 'diff-recovery');
  const repeatedDiffTools = diffTools.filter((row) => row.duplicate === true);
  const duplicateReads = tools.filter(
    (row) => row.toolClass === 'file-read' && row.duplicate === true,
  ).length;
  const reads = tools.filter((row) => row.toolClass === 'file-read').length;
  const repairSessions = sessions.filter(
    (row) => typeof row.label === 'string' && row.label.endsWith('-repair'),
  ).length;
  const retained = new Set([
    'posted-inline',
    'posted-file-level',
    'rescued',
    'orphaned',
    'anchor-missed',
  ]);
  const cohorts = Object.fromEntries(
    [...group(explorations, 'backend')].map(([backend, values]) => [
      backend,
      {
        sessions: values.length,
        turns: distribution(values.flatMap((row) => number(row, 'turnCount') ?? [])),
        toolCalls: values.reduce((sum, row) => sum + (number(row, 'toolCalls') ?? 0), 0),
        toolBytes: values.reduce((sum, row) => sum + (number(row, 'toolOutputBytes') ?? 0), 0),
      },
    ]),
  );
  const modelCohorts = Object.fromEntries(
    [...group(sessions, 'model')].map(([model, values]) => [
      model,
      {
        sessions: values.length,
        cacheReadTokens: values.reduce(
          (sum, row) => sum + (number(row, 'cacheReadTokens') ?? 0),
          0,
        ),
        repairRate: guardedRate(
          values.filter((row) => typeof row.label === 'string' && row.label.endsWith('-repair'))
            .length,
          values.length,
        ),
      },
    ]),
  );
  const findingCohorts = Object.fromEntries(
    [...group(findings, 'session')].map(([session, values]) => [
      session,
      {
        produced: values.length,
        retained: values.filter((row) => retained.has(String(row.disposition))).length,
      },
    ]),
  );
  const sourceRows = new Map<number, Row[]>();
  for (const row of rows) {
    const source = row._source ?? 0;
    sourceRows.set(source, [...(sourceRows.get(source) ?? []), row]);
  }
  const reconciliations = [...sourceRows.values()].flatMap((source) => {
    const elapsed = source.find((row) => row.kind === 'run')?.elapsedMs;
    if (typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return [];
    const measured = source
      .filter((row) => row.kind === 'phase' && row.scope === 'run')
      .reduce((sum, row) => sum + (number(row, 'durationMs') ?? 0), 0);
    const gap = Math.abs(elapsed - measured);
    return [{ gap, withinTolerance: gap <= Math.max(elapsed * 0.05, 2_000) }];
  });
  return {
    minimumRateSample: MIN_RATE_SAMPLE,
    runs: {
      count: runs.length,
      elapsedMs: distribution(runs.flatMap((row) => number(row, 'elapsedMs') ?? [])),
    },
    phaseTime,
    phaseReconciliation: {
      gapMs: distribution(reconciliations.map((row) => row.gap)),
      withinToleranceRate: guardedRate(
        reconciliations.filter((row) => row.withinTolerance).length,
        reconciliations.length,
      ),
    },
    tools: {
      calls: tools.length,
      outputBytes: toolBytes,
      duplicateReadRate: guardedRate(duplicateReads, reads),
      diffRecoveryCallRate: guardedRate(diffTools.length, tools.length),
      diffRecoveryByteRate: guardedRate(
        diffTools.reduce((sum, row) => sum + (number(row, 'outputBytesAfterCap') ?? 0), 0),
        toolBytes,
        tools.length,
      ),
      repeatedDiffRecoveryCallRate: guardedRate(repeatedDiffTools.length, diffTools.length),
      repeatedDiffRecoveryByteRate: guardedRate(
        repeatedDiffTools.reduce((sum, row) => sum + (number(row, 'outputBytesAfterCap') ?? 0), 0),
        diffTools.reduce((sum, row) => sum + (number(row, 'outputBytesAfterCap') ?? 0), 0),
        diffTools.length,
      ),
    },
    turns: distribution(explorations.flatMap((row) => number(row, 'turnCount') ?? [])),
    cacheReadTokens: sessions.reduce((sum, row) => sum + (number(row, 'cacheReadTokens') ?? 0), 0),
    retryRepairRate: guardedRate(repairSessions, sessions.length),
    retainedFindings: findings.filter((row) => retained.has(String(row.disposition))).length,
    backendCohorts: cohorts,
    modelCohorts,
    findingCohorts,
  };
}

function parseFiles(paths: string[]): Row[] {
  return paths.flatMap((path, source) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => ({ ...(JSON.parse(line) as Row), _source: source })),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('Usage: npm run performance:review -- <telemetry.jsonl> [...]');
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(aggregatePerformance(parseFiles(paths)), null, 2));
  }
}
