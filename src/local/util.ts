import { existsSync, readFileSync } from 'node:fs';

import type { ReviewResult } from '../shared/types.ts';

/**
 * Minimal `.env` loader for the local entry only (production entries stay
 * env-driven; no dotenv dependency). Real environment always wins. Returns
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
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] ??= value;
  }
  return true;
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
