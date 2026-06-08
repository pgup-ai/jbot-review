import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

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
  const seen = new Set<string>();

  async function addGuidelineFile(label: string, path: string): Promise<string | undefined> {
    const absolutePath = resolve(path);
    if (seen.has(absolutePath)) return undefined;
    try {
      const text = await readFile(absolutePath, 'utf8');
      if (!text.trim()) return undefined;
      seen.add(absolutePath);
      sections.push(`### ${label}\n${text.trim()}`);
      return text;
    } catch {
      return undefined;
    }
  }

  for (const name of ['AGENTS.md', 'REVIEW.md']) {
    await addGuidelineFile(name, resolve(cwd, name));
  }

  const governanceDir = resolve(cwd, '.pr-governance');
  const readme = await addGuidelineFile(
    '.pr-governance/README.md',
    resolve(governanceDir, 'README.md'),
  );

  if (readme) {
    for (const reference of extractMarkdownDocumentReferences(readme)) {
      const path = resolveGovernanceReference(cwd, governanceDir, reference);
      if (!path) continue;
      await addGuidelineFile(formatGuidelineLabel(cwd, path), path);
    }
    return sections.join('\n\n');
  }

  try {
    const entries = await readdir(governanceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      await addGuidelineFile(`.pr-governance/${entry.name}`, resolve(governanceDir, entry.name));
    }
  } catch {
    /* directory absent */
  }

  return sections.join('\n\n');
}

function extractMarkdownDocumentReferences(markdown: string): string[] {
  const references: string[] = [];
  const patterns = [/`([^`\n]+\.md(?:#[^`\n]+)?)`/gi, /\[[^\]]+\]\(([^)\s]+\.md(?:#[^)]+)?)\)/gi];

  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const reference = match[1]?.trim();
      if (reference) references.push(reference);
    }
  }

  return [...new Set(references)];
}

function resolveGovernanceReference(
  cwd: string,
  governanceDir: string,
  reference: string,
): string | undefined {
  const pathWithoutAnchor = reference.split('#')[0];
  if (!pathWithoutAnchor || /^[a-z][a-z0-9+.-]*:/i.test(pathWithoutAnchor)) return undefined;

  const baseDir = pathWithoutAnchor.startsWith('.pr-governance') ? cwd : governanceDir;
  const resolvedPath = resolve(baseDir, pathWithoutAnchor);
  return isInsideDirectory(cwd, resolvedPath) ? resolvedPath : undefined;
}

function isInsideDirectory(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith(sep));
}

function formatGuidelineLabel(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(path));
}
