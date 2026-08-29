import { existsSync, readFileSync } from 'node:fs';

import type { ReviewResult } from '../shared/types.ts';

/**
 * Minimal `.env` loader for the local entry only (production entries stay
 * env-driven; no dotenv dependency). Real environment always wins. Value
 * semantics follow dotenv/shell-sourcing — see `parseEnvValue`. Returns
 * whether a file was loaded.
 */
export function loadDotEnv(path = '.env', env: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(path)) return false;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // Tolerate shell-sourceable files ("export KEY=value").
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    env[key] ??= parseEnvValue(line.slice(eq + 1));
  }
  return true;
}

/**
 * dotenv/shell-sourcing value semantics: a quoted value runs to its closing
 * quote (protecting any `#` inside; anything after the close — e.g. an inline
 * comment — is ignored), and in an unquoted value a `#` preceded by
 * whitespace starts an inline comment, so `MODEL=kilo/x #stashed/alternative`
 * resolves to `kilo/x` while `a#b` stays intact. Wrap the value in quotes
 * when it legitimately contains ` #`.
 */
function parseEnvValue(raw: string): string {
  const value = raw.trim();
  const first = value[0];
  if (first === '"' || first === "'") {
    const close = value.indexOf(first, 1);
    // Unterminated quote: keep the raw value rather than guessing.
    return close > 0 ? value.slice(1, close) : value;
  }
  // `KEY= # comment` — nothing before the comment means an empty value.
  if (value.startsWith('#')) return '';
  const comment = value.search(/\s#/);
  return comment >= 0 ? value.slice(0, comment).trimEnd() : value;
}

/** owner/repo from a git remote URL (https or ssh); null when it doesn't look like one. */
export function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.trim().match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

export function benchmarkReviewOutput(
  result: ReviewResult & { telemetry?: string },
  telemetryPath: string,
): ReviewResult & { telemetry?: string } {
  const expectedRunId = telemetryRunId(result.telemetry);
  let persisted: string | undefined;
  if (expectedRunId) {
    try {
      const candidate = readFileSync(telemetryPath, 'utf8');
      if (telemetryRunId(candidate) === expectedRunId) persisted = candidate;
    } catch {
      // Keep the current in-memory telemetry when the optional sink is unreadable.
    }
  }
  return {
    ...result,
    ...(persisted ? { telemetry: persisted } : {}),
  };
}

function telemetryRunId(jsonl: string | undefined): string | undefined {
  const header = jsonl?.split('\n', 1)[0];
  if (!header) return undefined;
  try {
    const row = JSON.parse(header) as { kind?: unknown; runId?: unknown };
    return row.kind === 'run' && typeof row.runId === 'string' ? row.runId : undefined;
  } catch {
    return undefined;
  }
}

export function renderReport(
  result: ReviewResult,
  meta: {
    branch: string;
    baseRef: string;
    mergeBase: string;
    model: string;
    durationMs: number;
  },
): string {
  const elapsedSeconds = Math.round(meta.durationMs / 1_000);
  const reviewTime =
    elapsedSeconds < 1
      ? '<1s'
      : elapsedSeconds < 60
        ? `${elapsedSeconds}s`
        : `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`;
  const lines = [
    '# jbot local review',
    '',
    `- Branch: \`${meta.branch}\``,
    `- Base: \`${meta.baseRef}\` (merge-base \`${meta.mergeBase.slice(0, 12)}\`)`,
    `- Model: \`${meta.model}\``,
    `- Review time: ${reviewTime}`,
    `- Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    result.summary || '_(no summary)_',
    '',
    `## Findings (${result.findings.length})`,
    '',
  ];
  if (result.findings.length === 0) lines.push('No findings.');
  for (const finding of result.findings) {
    // line 0 = file-level finding; don't render a bogus ":0" anchor.
    const location = finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
    lines.push(`- **[${finding.severity}]** \`${location}\` — ${finding.title}`);
    for (const bodyLine of finding.body.split('\n')) lines.push(`  ${bodyLine}`);
    lines.push('');
  }
  return lines.join('\n');
}

interface ShardPreview {
  label: string;
  files: string[];
  /** Raw patch bytes assigned to this shard. */
  diffBytes: number;
  /** Bytes the diff budget would actually embed in the prompt. */
  embeddedBytes: number;
  truncated: number;
  omitted: number;
}

/**
 * Zero-LLM dry-run summary: shard assignment, fan-out plan, and budget
 * utilization, so shard/fanout decisions are debuggable without paying for a
 * run. Token figures are bytes/4 estimates over diff + guidelines only.
 */
export function renderReviewPreview(input: {
  shards: ShardPreview[];
  lensKeys: string[];
  guidelinePass: boolean;
  fanoutTier?: 'minimal' | 'full';
  fanoutReason?: string;
  guidelines: { docCount: number; fullBytes: number; finderBytes: number };
}): string {
  const lines: string[] = ['── Review preview (no sessions started) ──'];
  lines.push(`Shards: ${input.shards.length}`);
  // Mirrors the runner's gate: finders get the capped slice only while the
  // compliance pass audits the full set; otherwise they carry the full set.
  const guidelineBytes = input.guidelinePass
    ? input.guidelines.finderBytes
    : input.guidelines.fullBytes;
  for (const shard of input.shards) {
    const tokens = Math.round((shard.embeddedBytes + guidelineBytes) / 4);
    const budget = [
      shard.truncated > 0 ? `${shard.truncated} file(s) truncated` : '',
      shard.omitted > 0 ? `${shard.omitted} file(s) omitted from embedding` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `  ${shard.label}: ${shard.files.length} file(s), ${shard.diffBytes} diff bytes ` +
        `(${shard.embeddedBytes} embedded${budget ? `; ${budget}` : ''}) → ~${tokens} tokens (bytes/4, diff + guidelines)`,
    );
    lines.push(`    ${shard.files.join(', ')}`);
  }
  const fanout = input.fanoutTier === 'minimal' ? ` [minimal fan-out: ${input.fanoutReason}]` : '';
  lines.push(
    `Recall supplements: lenses: ${input.lensKeys.length > 0 ? input.lensKeys.join(', ') : '(none)'}; ` +
      `guideline pass: ${input.guidelinePass ? 'on' : 'off'}${fanout}`,
  );
  lines.push(
    `Guidelines: ${input.guidelines.docCount} doc(s), ${input.guidelines.fullBytes} bytes full; ` +
      `finder slice ${input.guidelines.finderBytes} bytes`,
  );
  return lines.join('\n');
}
