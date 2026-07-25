/**
 * Aggregates per-finding dispositions from a repository's review run logs.
 *
 * `emitReviewTelemetry` prints one summary line per run, so the whole history is
 * a log grep — no labelled corpus, no extra instrumentation:
 *
 *   Telemetry: 3 finding(s) produced (1 anchor-missed, 2 posted-inline)
 *
 * Use `--since` to split runs around a change under test. The published image is
 * a floating tag resolved at run time, so the boundary is the image BUILD time,
 * not the merge time.
 *
 * Reads the `jbot-review.yml` workflow's runs; `gh` must be authenticated for the
 * target repository.
 *
 * Usage: npm run findings:dispositions -- <owner/repo> [--since=<iso>] [--limit=<n>]
 */
import { execFileSync } from 'node:child_process';

const TELEMETRY_LINE = /Telemetry: \d+ finding\(s\) produced(?: \(([^)]*)\))?/g;

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
}

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
}

function main(): void {
  const repo = process.argv[2];
  if (!repo?.includes('/')) {
    console.error('usage: finding-dispositions.ts <owner/repo> [--since=<iso>] [--limit=<n>]');
    process.exitCode = 1;
    return;
  }
  const since = arg('since');
  const limit = Number(arg('limit') ?? 40);

  const runs = (
    JSON.parse(
      gh([
        'run',
        'list',
        '-R',
        repo,
        '--workflow',
        'jbot-review.yml',
        '--limit',
        String(limit),
        '--json',
        'databaseId,createdAt,conclusion',
      ]),
    ) as { databaseId: number; createdAt: string; conclusion: string }[]
  ).filter((r) => r.conclusion === 'success' && (!since || r.createdAt >= since));

  console.log(`${repo}: ${runs.length} successful run(s)${since ? ` since ${since}` : ''}`);

  const counts = new Map<string, number>();
  let withFindings = 0;
  for (const run of runs) {
    let log: string;
    try {
      log = gh(['run', 'view', String(run.databaseId), '-R', repo, '--log']);
    } catch {
      continue; // logs expire; a missing run is not a failed sweep
    }
    for (const [, breakdown] of log.matchAll(TELEMETRY_LINE)) {
      if (!breakdown) continue;
      withFindings += 1;
      for (const entry of breakdown.split(', ')) {
        const [n, disposition] = entry.split(' ');
        counts.set(disposition, (counts.get(disposition) ?? 0) + Number(n));
      }
    }
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  console.log(`${withFindings} run(s) produced findings; ${total} finding(s) routed\n`);
  for (const [disposition, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${disposition.padEnd(18)} ${String(n).padStart(4)}  ${((100 * n) / total).toFixed(1)}%`,
    );
  }
  if (total > 0 && total < 30) {
    console.log(`\n  n=${total} — too small to draw a rate from.`);
  }
}

main();
