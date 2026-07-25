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

/**
 * Anchored to end of line: a run log also echoes PR bodies and review context,
 * which can quote this very sentence. A real emission ends its line; a quoted one
 * is followed by the rest of the blob it lives in.
 */
const TELEMETRY_LINE = /Telemetry: \d+ finding\(s\) produced(?: \(([^)]*)\))?\.?\s*$/m;
const DEFAULT_LIMIT = 60;
const MIN_SAMPLE = 30;

interface Run {
  databaseId: number;
  conclusion: string;
}

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
  const rawLimit = arg('limit');
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(`--limit must be a positive integer, got ${rawLimit}`);
    process.exitCode = 1;
    return;
  }

  // `--created` filters server-side. Filtering after the fetch would silently
  // drop eligible runs whenever newer ones fill the limit, which is exactly the
  // window this tool exists to measure.
  const fetched = JSON.parse(
    gh([
      'run',
      'list',
      '-R',
      repo,
      '--workflow',
      'jbot-review.yml',
      ...(since ? ['--created', `>=${since}`] : []),
      '--limit',
      String(limit),
      '--json',
      'databaseId,conclusion',
    ]),
  ) as Run[];
  const runs = fetched.filter((r) => r.conclusion === 'success');

  console.log(`${repo}: ${runs.length} successful run(s)${since ? ` since ${since}` : ''}`);

  const counts = new Map<string, number>();
  let withFindings = 0;
  let skipped = 0;
  for (const run of runs) {
    let log: string;
    try {
      log = gh(['run', 'view', String(run.databaseId), '-R', repo, '--log']);
    } catch {
      skipped += 1; // logs expire after ~90 days; reported below, never silent
      continue;
    }
    // One emission per run, so take the first match rather than counting lines.
    const breakdown = log.match(TELEMETRY_LINE)?.[1];
    if (!breakdown) continue;
    withFindings += 1;
    for (const entry of breakdown.split(', ')) {
      const [n, disposition] = entry.split(' ');
      counts.set(disposition, (counts.get(disposition) ?? 0) + Number(n));
    }
  }

  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  console.log(
    `${withFindings} of ${runs.length - skipped} aggregated run(s) produced findings; ${total} finding(s) routed\n`,
  );
  for (const [disposition, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(
      `  ${disposition.padEnd(18)} ${String(n).padStart(4)}  ${((100 * n) / total).toFixed(1)}%`,
    );
  }

  const caveats = [
    skipped > 0 ? `${skipped} run(s) skipped — logs unavailable, so this sample is partial` : '',
    fetched.length === limit ? `hit the ${limit}-run fetch cap; raise --limit to widen` : '',
    total > 0 && total < MIN_SAMPLE ? `n=${total} — too small to draw a rate from` : '',
  ].filter(Boolean);
  if (caveats.length > 0) console.log(`\n${caveats.map((c) => `  ! ${c}`).join('\n')}`);
}

main();
