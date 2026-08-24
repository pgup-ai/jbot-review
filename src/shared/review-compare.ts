import { isBenchmarkRunnerOutput } from './benchmark-runner.ts';
import type { BenchmarkObservedFinding } from './benchmark-score.ts';

interface CompareArgs {
  models: string[];
  workspace?: string;
  base?: string;
}

export interface CompareResult {
  model: string;
  seconds: number;
  findings: BenchmarkObservedFinding[];
  error?: string;
}

const FLAGS = new Set(['--models', '--workspace', '--base']);

export function parseCompareArgs(argv: string[]): CompareArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!FLAGS.has(flag)) throw new Error(`Unknown review:compare argument "${flag}".`);
    const value = argv[index + 1];
    if (!value?.trim() || value.startsWith('--')) {
      throw new Error(`Review:compare argument "${flag}" requires a value.`);
    }
    values.set(flag, value);
    index += 1;
  }
  const models = [
    ...new Set(
      (values.get('--models') ?? '')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  if (models.length === 0) throw new Error('review:compare requires --models <a,b,...>.');
  const workspace = values.get('--workspace');
  const base = values.get('--base');
  return { models, ...(workspace ? { workspace } : {}), ...(base ? { base } : {}) };
}

/** `undefined` is a review that skipped: it exits 0 and writes no output. */
export function classifyReviewOutput(
  raw: string | undefined,
): Pick<CompareResult, 'findings' | 'error'> {
  if (raw === undefined) return { findings: [], error: 'no review output (nothing to review?)' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { findings: [], error: 'unreadable review output' };
  }
  return isBenchmarkRunnerOutput(parsed)
    ? { findings: parsed.findings }
    : { findings: [], error: 'unreadable review output' };
}

export function renderComparison(results: CompareResult[]): string {
  const width = Math.max(...results.map((result) => result.model.length), 5);
  const lines = [
    `${'model'.padEnd(width)}  time  findings  severities`,
    `${'-'.repeat(width)}  ----  --------  ----------`,
  ];
  for (const result of results) {
    const severities = [...new Set(result.findings.map((finding) => finding.severity))]
      .sort()
      .join(',');
    lines.push(
      `${result.model.padEnd(width)}  ${`${result.seconds}s`.padStart(4)}  ${String(result.findings.length).padStart(8)}  ${result.error ? `FAILED: ${result.error}` : severities || '-'}`,
    );
  }
  for (const result of results) {
    lines.push('', `${result.model}:`);
    if (result.error) lines.push(`  failed: ${result.error}`);
    if (result.findings.length === 0 && !result.error) lines.push('  (no findings)');
    for (const finding of result.findings) {
      lines.push(`  ${finding.severity} ${finding.path}:${finding.line} — ${finding.title}`);
    }
  }
  return lines.join('\n');
}
