import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { isNoiseFile } from './filter.ts';
import { parseAddedLines } from './patch.ts';
import { startOpencode, waitReady, runReview } from './opencode.ts';
import { listPrFiles, postReview, decideVerdict } from './github.ts';
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
  const files = (await listPrFiles(octokit, owner, repo, pullNumber)).filter(
    (f) => f.patch && !isNoiseFile(f.filename),
  );
  if (files.length === 0) {
    log('No reviewable files after filtering.');
    return;
  }

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

  // 4. Run the agentic review against the checked-out repo.
  const prContext = [
    pullTitle && `Title: ${pullTitle}`,
    pullBody && `Description: ${pullBody}`,
    `Changed files: ${changedFiles.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');

  const { proc, client } = startOpencode(workspace, keyEnv, apiKey);
  try {
    await waitReady(client);
    const { summary, findings } = await runReview(client, model, prContext, guidelines);

    // 5. Gate: split into inline-anchorable vs orphaned, decide the verdict.
    const inline: Finding[] = [];
    const orphaned: Finding[] = [];
    for (const f of findings) {
      if (addable.get(f.path)?.has(f.line)) inline.push(f);
      else orphaned.push(f);
    }
    const verdict = decideVerdict(findings);
    const body = buildBody(summary, findings.length, orphaned);

    // 6. Post one review, fully under our control.
    await postReview(octokit, owner, repo, pullNumber, verdict, body, inline);
    log(`Posted ${verdict}: ${findings.length} finding(s), ${inline.length} inline.`);
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

function buildBody(summary: string, total: number, orphaned: Finding[]): string {
  const lines = ['### AI code review', '', summary || 'No summary provided.', ''];
  lines.push(total === 0 ? 'No issues found.' : `Found ${total} item(s).`);
  if (orphaned.length > 0) {
    lines.push('', '#### Findings outside the diff');
    for (const f of orphaned) {
      lines.push(`- **${f.title}** (${f.path}:${f.line}) — ${f.body}`);
    }
  }
  return lines.join('\n');
}
