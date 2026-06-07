import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ReviewCommit {
  sha: string;
  message: string;
  author?: string;
}

export interface BuildReviewContextParams {
  pullTitle: string;
  pullBody: string;
  changedFiles: string[];
  priorComments: string[];
  commits: ReviewCommit[];
  checkSummary: string;
  guidelines: string;
}

export function buildReviewContext(params: BuildReviewContextParams): string {
  const sections: string[] = [];

  sections.push(
    [
      '## Pull request',
      `Title: ${params.pullTitle || '(untitled)'}`,
      params.pullBody ? `Description:\n${params.pullBody}` : 'Description: (none)',
    ].join('\n'),
  );

  sections.push(
    [
      '## Changed files',
      params.changedFiles.length > 0
        ? params.changedFiles.map((file) => `- ${file}`).join('\n')
        : '(none)',
    ].join('\n'),
  );

  sections.push(
    [
      '## Commits',
      params.commits.length > 0
        ? params.commits
            .map((commit) => {
              const author = commit.author ? ` (${commit.author})` : '';
              return `- ${commit.sha.slice(0, 7)}${author}: ${commit.message}`;
            })
            .join('\n')
        : '(none)',
    ].join('\n'),
  );

  sections.push(['## Check status summary', params.checkSummary || '(unavailable)'].join('\n'));

  if (params.priorComments.length > 0) {
    sections.push(
      [
        '## Prior review comments',
        params.priorComments.map((comment) => `- ${comment}`).join('\n'),
      ].join('\n'),
    );
  }

  if (params.guidelines) {
    sections.push(['## Repository review guidelines', params.guidelines].join('\n'));
  }

  return sections.join('\n\n');
}

export async function discoverGuidelines(cwd: string): Promise<string> {
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
