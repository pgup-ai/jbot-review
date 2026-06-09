import { access, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

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
  const referencedDocs = new Map<string, string>();

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

  async function addReferencedDoc(baseDir: string, reference: string): Promise<void> {
    const referencedPath = resolveMarkdownReference(cwd, baseDir, reference);
    if (!referencedPath || seen.has(referencedPath)) return;
    try {
      await access(referencedPath);
    } catch {
      return;
    }
    referencedDocs.set(referencedPath, formatGuidelineLabel(cwd, referencedPath));
  }

  for (const name of ['AGENTS.md', 'REVIEW.md']) {
    const path = resolve(cwd, name);
    const text = await addGuidelineFile(name, path);
    if (!text) continue;
    for (const reference of extractMarkdownDocumentReferences(text)) {
      await addReferencedDoc(cwd, reference);
    }
  }

  const governanceDir = resolve(cwd, '.pr-governance');
  const readme = await addGuidelineFile(
    '.pr-governance/README.md',
    resolve(governanceDir, 'README.md'),
  );

  if (readme) {
    for (const reference of extractMarkdownDocumentReferences(readme)) {
      await addReferencedDoc(governanceDir, reference);
    }
    return formatGuidelineSections(sections, seen, referencedDocs);
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

  return formatGuidelineSections(sections, seen, referencedDocs);
}

function formatGuidelineSections(
  sections: string[],
  loadedPaths: Set<string>,
  referencedDocs: Map<string, string>,
): string {
  const availableDocs = [...referencedDocs]
    .filter(([path]) => !loadedPaths.has(path))
    .map(([, label]) => label)
    .sort();

  if (availableDocs.length > 0) {
    sections.push(
      [
        '### Referenced Markdown documents',
        'These docs were mentioned by AGENTS.md, REVIEW.md, or .pr-governance/README.md but were not preloaded. Read them only when relevant to the changed files or review question.',
        availableDocs.map((label) => `- ${label}`).join('\n'),
      ].join('\n'),
    );
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

function resolveMarkdownReference(
  cwd: string,
  baseDir: string,
  reference: string,
): string | undefined {
  const pathWithoutAnchor = reference.split('#')[0];
  if (!pathWithoutAnchor || /^[a-z][a-z0-9+.-]*:/i.test(pathWithoutAnchor)) return undefined;

  // AGENTS.md/REVIEW.md refs resolve from repo root; governance README refs
  // resolve from .pr-governance unless they explicitly start at .pr-governance.
  const referenceBaseDir = pathWithoutAnchor.startsWith('.pr-governance') ? cwd : baseDir;
  const resolvedPath = resolve(referenceBaseDir, pathWithoutAnchor);
  return isInsideDirectory(cwd, resolvedPath) ? resolvedPath : undefined;
}

function isInsideDirectory(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function formatGuidelineLabel(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(path));
}
