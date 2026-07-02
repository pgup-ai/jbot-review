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

export function renderReport(
  result: ReviewResult,
  meta: { branch: string; baseRef: string; mergeBase: string; model: string },
): string {
  const lines = [
    '# jbot local review',
    '',
    `- Branch: \`${meta.branch}\``,
    `- Base: \`${meta.baseRef}\` (merge-base \`${meta.mergeBase.slice(0, 12)}\`)`,
    `- Model: \`${meta.model}\``,
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
