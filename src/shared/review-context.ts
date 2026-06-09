import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

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

const ROOT_GUIDELINE_FILES = [
  'AGENTS.md',
  'REVIEW.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.cursor/BUGBOT.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
  '.windsurfrules',
  '.coderabbit.yaml',
  '.coderabbit.yml',
  'greptile.json',
];

const SCOPED_GUIDELINE_FILES = [
  'AGENTS.md',
  'REVIEW.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.cursor/BUGBOT.md',
  '.agents/REVIEW.md',
  '.devin/REVIEW.md',
  '.cursor/REVIEW.md',
  '.cursorrules',
  '.windsurfrules',
];

const RULE_DIRECTORY_FILES = new Set(['.md', '.mdc']);

export async function discoverGuidelines(
  cwd: string,
  changedFiles: string[] = [],
): Promise<string> {
  const sections: string[] = [];
  const seen = new Set<string>();
  const referencedDocs = new Map<string, string>();

  async function addGuidelineFile(
    label: string,
    path: string,
  ): Promise<
    | {
        text: string;
        absolutePath: string;
      }
    | undefined
  > {
    const absolutePath = resolve(path);
    if (!isInsideDirectory(cwd, absolutePath)) return undefined;
    if (seen.has(absolutePath)) return undefined;
    try {
      const text = await readFile(absolutePath, 'utf8');
      if (!text.trim()) return undefined;
      seen.add(absolutePath);
      sections.push(`### ${label}\n${text.trim()}`);
      return { text, absolutePath };
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

  async function addGuidelineWithReferences(relativePath: string): Promise<void> {
    const result = await addGuidelineFile(relativePath, resolve(cwd, relativePath));
    if (!result) return;
    const baseDir = ['AGENTS.md', 'REVIEW.md'].includes(relativePath)
      ? cwd
      : dirname(result.absolutePath);
    for (const reference of extractMarkdownDocumentReferences(result.text)) {
      await addReferencedDoc(baseDir, reference);
    }
  }

  async function addRuleDirectory(relativeDir: string): Promise<void> {
    const absoluteDir = resolve(cwd, relativeDir);
    if (!isInsideDirectory(cwd, absoluteDir)) return;
    try {
      const entries = await readdir(absoluteDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = entry.name.match(/\.[^.]+$/)?.[0] ?? '';
        if (!RULE_DIRECTORY_FILES.has(ext)) continue;
        await addGuidelineWithReferences(`${relativeDir}/${entry.name}`);
      }
    } catch {
      /* directory absent */
    }
  }

  for (const relativePath of ROOT_GUIDELINE_FILES) {
    await addGuidelineWithReferences(relativePath);
  }
  await addRuleDirectory('.cursor/rules');

  for (const dir of getChangedFileAncestorDirs(changedFiles)) {
    for (const name of SCOPED_GUIDELINE_FILES) {
      await addGuidelineWithReferences(`${dir}/${name}`);
    }
    await addRuleDirectory(`${dir}/.cursor/rules`);
  }

  const governanceDir = resolve(cwd, '.pr-governance');
  const readme = await addGuidelineFile(
    '.pr-governance/README.md',
    resolve(governanceDir, 'README.md'),
  );

  if (readme) {
    for (const reference of extractMarkdownDocumentReferences(readme.text)) {
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

function getChangedFileAncestorDirs(changedFiles: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of changedFiles) {
    const parts = file.split('/').filter(Boolean);
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join('/'));
    }
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
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
        'These docs were mentioned by loaded review guidance but were not preloaded. Read them only when relevant to the changed files or review question.',
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

  // Governance README refs resolve from .pr-governance unless they
  // explicitly start at .pr-governance.
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
