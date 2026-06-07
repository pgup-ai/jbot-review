import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isNoiseFile } from './filter.ts';
import { parseAddedLines } from './patch.ts';
import { startOpencode, waitReady, runReview } from './opencode.ts';
import { listPrFiles, listPrComments, postReview, decideVerdict } from './github.ts';
import type { Octokit } from './github.ts';
import type { Finding } from './types.ts';

export async function runPrReview(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  pullTitle: string;
  pullBody: string;
  workspace: string;
  model: string;
  keyEnv: string;
  apiKey: string;
  log: (msg: string) => void;
}): Promise<void> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    pullTitle,
    pullBody,
    workspace,
    model,
    keyEnv,
    apiKey,
    log,
  } = params;

  // 1. Changed files + patches, minus noise.
  log(`Listing PR files for ${owner}/${repo}#${pullNumber}`);
  const rawFiles = await listPrFiles(octokit, owner, repo, pullNumber);
  log(`Files in PR: ${rawFiles.length} total`);
  const files = rawFiles.filter((f) => f.patch && !isNoiseFile(f.filename));
  if (files.length === 0) {
    log('No reviewable files after filtering.');
    return;
  }
  log(`Reviewable files: ${files.length} (noise filtered: ${rawFiles.length - files.length})`);

  // 2. Build the per-file commentable line sets for inline-comment validation.
  const addable = new Map<string, Set<number>>();
  const changedFiles: string[] = [];
  for (const f of files) {
    addable.set(f.filename, parseAddedLines(f.patch));
    changedFiles.push(f.filename);
  }

  // 3. Discover repo-level review guidelines.
  const guidelines = await discoverGuidelines(workspace);
  if (guidelines) log(`Guidelines loaded (${guidelines.length} bytes).`);

  // 4. Fetch existing review comments so the agent can reference prior feedback.
  const priorComments = await listPrComments(octokit, owner, repo, pullNumber);
  const commentsBlock =
    priorComments.length > 0
      ? '## Prior review comments\n' + priorComments.map((c) => `- ${c}`).join('\n')
      : '';

  // 5. Build the full PR context for the agent.
  const prContext = [
    pullTitle && `Title: ${pullTitle}`,
    pullBody && `Description: ${pullBody}`,
    `Changed files: ${changedFiles.join(', ')}`,
    commentsBlock,
  ]
    .filter(Boolean)
    .join('\n');

  // 6. Run the agentic review against the checked-out repo.
  log('Starting opencode server');
  const { proc, client } = startOpencode(workspace, keyEnv, apiKey);
  try {
    log('Waiting for opencode server readiness');
    await waitReady(client);
    log('Running review');
    const { summary, findings } = await runReview(client, model, prContext, guidelines, log);

    log(`Review complete: ${findings.length} finding(s)`);

    // 7. Gate: split into inline-anchorable vs orphaned, decide the verdict.
    const inline: Finding[] = [];
    const orphaned: Finding[] = [];
    for (const f of findings) {
      if (addable.get(f.path)?.has(f.line)) inline.push(f);
      else orphaned.push(f);
    }
    const verdict = decideVerdict(findings);
    const body = buildBody(summary, findings, orphaned);

    // 8. Post one review, fully under our control.
    log(`Posting review: verdict=${verdict} inline=${inline.length} orphaned=${orphaned.length}`);
    await postReview(octokit, owner, repo, pullNumber, verdict, body, inline);
    log(`Review posted.`);
  } finally {
    proc.kill();
  }
}

async function discoverGuidelines(cwd: string): Promise<string> {
  const sections: string[] = [];

  for (const name of ['AGENTS.md', 'REVIEW.md']) {
    try {
      const text = await readFile(join(cwd, name), 'utf8');
      if (text.trim()) sections.push(`### ${name}\n${text.trim()}`);
    } catch {
      /* optional */
    }
  }

  try {
    const entries = await readdir(join(cwd, '.pr-governance'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const text = await readFile(join(cwd, '.pr-governance', entry.name), 'utf8');
        if (text.trim()) sections.push(`### .pr-governance/${entry.name}\n${text.trim()}`);
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* directory absent */
  }

  return sections.join('\n\n');
}

function buildBody(summary: string, all: Finding[], orphaned: Finding[]): string {
  const total = all.length;
  const lines = ['## AI code review', '', summary || 'No summary provided.', ''];
  if (total === 0) {
    lines.push('_No issues found._');
  } else {
    const counts = countBySeverity(all);
    lines.push(`**${total} finding(s)** | ${counts}`, '');
  }
  if (orphaned.length > 0) {
    lines.push('### Findings (outside the diff)');
    for (const f of orphaned) {
      lines.push(`- **${f.severity}** ${f.title} — \`${f.path}:${f.line}\``);
      lines.push(`  ${f.body}`);
    }
  }
  return lines.join('\n');
}

function countBySeverity(findings: Pick<Finding, 'severity'>[]): string {
  const tags = ['P0', 'P1', 'P2', 'P3', 'nit'] as const;
  return tags
    .map((t) => {
      const n = findings.filter((f) => f.severity === t).length;
      return n > 0 ? `${n}× ${t}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}
