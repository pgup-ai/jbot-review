import { access, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { GIT_DIFF_ARGS } from './git.ts';

export interface ReviewCommit {
  sha: string;
  message: string;
  author?: string;
}

export interface DiffScope {
  baseRef?: string;
  baseSha?: string;
  headSha?: string;
  /**
   * Local mode: the right side is the WORKING TREE (merge-base→worktree), so
   * the reproduction command is a two-dot `git diff <base>` that includes
   * uncommitted changes — not the three-dot `<base>...HEAD`, which stops at the
   * last commit and would hide the very edits under review on a dirty tree.
   */
  worktree?: boolean;
}

/** Relevance tiers for finder-pass guideline ranking; higher = kept first. */
const GUIDELINE_RELEVANCE = { root: 1, governance: 2, scoped: 3 } as const;
type GuidelineRelevance = (typeof GUIDELINE_RELEVANCE)[keyof typeof GUIDELINE_RELEVANCE];

export interface GuidelineDoc {
  /** Relative-path label, e.g. "apps/web/AGENTS.md". */
  label: string;
  /** Trimmed, byte-bounded text (may end with a per-file truncation notice). */
  text: string;
  /** Higher = more relevant to the changed files (scoped > governance > root). */
  relevance: GuidelineRelevance;
}

export interface DiscoveredGuidelines {
  /** Loaded docs in discovery order. */
  docs: GuidelineDoc[];
  /** Labels referenced by loaded docs but not themselves loaded (sorted). */
  referenced: string[];
  /** True when the total discovery budget was exhausted before all files. */
  budgetExhausted: boolean;
}

const GIT_DIFF_COMMAND = `git ${GIT_DIFF_ARGS.join(' ')}`;

/**
 * Renders the PR base/head and the exact three-dot diff command the agent
 * should run. Three-dot (merge-base) diff is required: GitHub's patch — which
 * inline-comment anchors are validated against — is merge-base-relative.
 * Returns '' when nothing about the scope is known.
 *
 * Prefers the base SHA, which is unambiguous in any checkout. Only when the
 * SHA is absent does it fall back to `origin/<baseRef>`, which assumes the
 * conventional `origin` remote name; both entry points pass the base SHA, so
 * the agent can also locate the base from the surrounding context if that
 * assumption does not hold.
 */
export function formatDiffScope(scope: DiffScope): string {
  const lines: string[] = [];
  if (scope.baseRef || scope.baseSha) {
    const sha = scope.baseSha ? ` (${scope.baseSha})` : '';
    lines.push(`Base: ${scope.baseRef ?? '(unknown ref)'}${sha}`);
  }
  if (scope.headSha) lines.push(`Head: ${scope.headSha}`);

  const base = scope.baseSha ?? (scope.baseRef ? `origin/${scope.baseRef}` : undefined);
  if (base && scope.worktree) {
    // Two-dot against the working tree: matches the merge-base→worktree diff the
    // local run was built from, uncommitted changes included. Reuse the canonical
    // safe argv so model-run diffs match the embedded hunks without invoking
    // external diff or textconv drivers.
    lines.push(
      'To see exactly what this review covers (merge-base → working tree, includes uncommitted changes), run:',
      `    ${GIT_DIFF_COMMAND} ${base}`,
      'Only review changes within this diff.',
    );
  } else if (base) {
    const head = scope.headSha ?? 'HEAD';
    lines.push(
      'To see exactly what this PR changes, run:',
      `    ${GIT_DIFF_COMMAND} ${base}...${head}`,
      'Only review changes within this diff.',
    );
  }
  return lines.join('\n');
}

/**
 * One-line UTF-8 byte report of the assembled context fragments, largest first,
 * for spotting prompt-bloat / dilution regressions in run logs. Dev-facing
 * observability only — never added to a model-visible prompt.
 */
export function formatContextBudget(fragments: Array<{ name: string; text: string }>): string {
  const sized = fragments
    .map(({ name, text }) => ({ name, bytes: Buffer.byteLength(text, 'utf8') }))
    .filter(({ bytes }) => bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const total = sized.reduce((sum, { bytes }) => sum + bytes, 0);
  const parts = sized.map(({ name, bytes }) => `${name}=${bytes}`).join(' ');
  return `Context budget (bytes): ${parts} total=${total}`;
}

export interface BuildReviewContextParams {
  pullTitle: string;
  pullBody: string;
  changedFiles: string[];
  priorComments: string[];
  commits: ReviewCommit[];
  checkSummary: string;
  guidelines: string;
  diffScope?: DiffScope;
}

// Author-controlled and unbounded upstream; cap like every injected block (invariant #4).
export const MAX_PR_BODY_BYTES = 4 * 1024;
const PR_BODY_TRUNCATION_NOTICE =
  '\n\n[PR description truncated to keep the review prompt bounded.]';

/** Shared by the enhanced (buildReviewContext) and basic (runner) PR-context paths. */
export function truncatePrBody(body: string): string {
  const buffer = Buffer.from(body, 'utf8');
  if (buffer.length <= MAX_PR_BODY_BYTES) return body;
  // Reserve the notice's bytes so body + notice together stay within the cap.
  const budget = MAX_PR_BODY_BYTES - Buffer.byteLength(PR_BODY_TRUNCATION_NOTICE, 'utf8');
  return buffer.toString('utf8', 0, findUtf8Boundary(buffer, budget)) + PR_BODY_TRUNCATION_NOTICE;
}

export function buildReviewContext(params: BuildReviewContextParams): string {
  const sections: string[] = [];

  const pullRequestLines = [
    '## Pull request',
    `Title: ${params.pullTitle || '(untitled)'}`,
    params.pullBody ? `Description:\n${truncatePrBody(params.pullBody)}` : 'Description: (none)',
  ];
  const diffScopeText = params.diffScope ? formatDiffScope(params.diffScope) : '';
  if (diffScopeText) pullRequestLines.push(diffScopeText);
  sections.push(pullRequestLines.join('\n'));

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
  'TECHNICAL_STANDARDS.md',
  'ARCHITECTURE.md',
  'DESIGN.md',
  'DECISIONS.md',
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
  'TECHNICAL_STANDARDS.md',
  'DESIGN.md',
  'DECISIONS.md',
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
const MAX_GUIDELINE_FILE_BYTES = 24 * 1024;
const MAX_GUIDELINE_TOTAL_BYTES = 96 * 1024;

export async function discoverGuidelineDocs(
  cwd: string,
  changedFiles: string[] = [],
): Promise<DiscoveredGuidelines> {
  const docs: GuidelineDoc[] = [];
  const seen = new Set<string>();
  const seenRealPaths = new Set<string>();
  const referencedDocs = new Map<string, string>();
  const workspaceRoot = await realpath(cwd);
  let remainingGuidelineBytes = MAX_GUIDELINE_TOTAL_BYTES;
  let budgetExhausted = false;

  function markBudgetExhausted(): void {
    budgetExhausted = true;
  }

  async function resolveExistingInsideWorkspace(
    path: string,
  ): Promise<{ absolutePath: string; realPath: string } | undefined> {
    const absolutePath = resolve(path);
    if (!isInsideDirectory(cwd, absolutePath)) return undefined;
    try {
      const realPath = await realpath(absolutePath);
      if (!isInsideDirectory(workspaceRoot, realPath)) return undefined;
      return { absolutePath, realPath };
    } catch {
      return undefined;
    }
  }

  async function readBoundedGuidelineFile(realPath: string): Promise<string | undefined> {
    if (remainingGuidelineBytes <= 0) {
      markBudgetExhausted();
      return undefined;
    }

    const handle = await open(realPath, 'r');
    try {
      const { size } = await handle.stat();
      if (size <= 0) return undefined;

      const byteLimit = Math.min(size, MAX_GUIDELINE_FILE_BYTES, remainingGuidelineBytes);
      const buffer = Buffer.alloc(byteLimit);
      const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
      if (bytesRead <= 0) return undefined;

      const includedBytes = findUtf8Boundary(buffer, bytesRead);
      if (includedBytes <= 0) return undefined;

      remainingGuidelineBytes -= includedBytes;
      const text = buffer.toString('utf8', 0, includedBytes);
      if (size <= includedBytes) return text;

      return [
        text,
        '',
        `[Guidance truncated after ${includedBytes} bytes to keep the review prompt bounded.]`,
      ].join('\n');
    } finally {
      await handle.close();
    }
  }

  async function addGuidelineFile(
    label: string,
    path: string,
    relevance: GuidelineRelevance,
  ): Promise<{ text: string; absolutePath: string } | undefined> {
    const resolved = await resolveExistingInsideWorkspace(path);
    if (!resolved) return undefined;
    if (seen.has(resolved.absolutePath) || seenRealPaths.has(resolved.realPath)) return undefined;
    try {
      const text = await readBoundedGuidelineFile(resolved.realPath);
      if (!text) return undefined;
      const trimmed = text.trim();
      if (!trimmed) return undefined;
      seen.add(resolved.absolutePath);
      seenRealPaths.add(resolved.realPath);
      docs.push({ label, text: trimmed, relevance });
      return { text, absolutePath: resolved.absolutePath };
    } catch {
      return undefined;
    }
  }

  async function addReferencedDoc(baseDir: string, reference: string): Promise<void> {
    const referencedPath = resolveMarkdownReference(cwd, baseDir, reference);
    if (!referencedPath || seen.has(referencedPath)) return;
    const resolved = await resolveExistingInsideWorkspace(referencedPath);
    if (!resolved || seenRealPaths.has(resolved.realPath)) return;
    try {
      await access(resolved.realPath);
    } catch {
      return;
    }
    referencedDocs.set(referencedPath, formatGuidelineLabel(cwd, referencedPath));
  }

  async function preloadOrListReferencedDoc(baseDir: string, reference: string): Promise<void> {
    const referencedPath = resolveMarkdownReference(cwd, baseDir, reference);
    if (!referencedPath || seen.has(referencedPath)) return;
    // Referenced docs are review guidance by definition: preload them (budget
    // permitting) so loading does not depend on the model volunteering extra
    // reads. Path-escape and symlink checks happen inside addGuidelineFile.
    // Nested references inside preloaded docs are intentionally not followed.
    const loaded = await addGuidelineFile(
      formatGuidelineLabel(cwd, referencedPath),
      referencedPath,
      GUIDELINE_RELEVANCE.governance,
    );
    // Budget exhausted (or unreadable): fall back to listing the doc so the
    // agent can still read it on demand instead of never seeing it.
    if (!loaded) await addReferencedDoc(baseDir, reference);
  }

  // Referenced-doc preloading is DEFERRED until every primary guideline file
  // has had its chance at the budget: primary files have no list-as-available
  // fallback, so a large referenced doc loading early could silently evict
  // the actual review rules.
  const deferredReferences: Array<{ baseDir: string; reference: string }> = [];

  async function flushDeferredReferences(): Promise<void> {
    for (const { baseDir, reference } of deferredReferences) {
      await preloadOrListReferencedDoc(baseDir, reference);
    }
    deferredReferences.length = 0;
  }

  async function addGuidelineWithReferences(
    relativePath: string,
    relevance: GuidelineRelevance,
  ): Promise<void> {
    const result = await addGuidelineFile(relativePath, resolve(cwd, relativePath), relevance);
    if (!result) return;
    const baseDir = ['AGENTS.md', 'REVIEW.md'].includes(relativePath)
      ? cwd
      : dirname(result.absolutePath);
    for (const reference of extractMarkdownDocumentReferences(result.text)) {
      deferredReferences.push({ baseDir, reference });
    }
  }

  async function addRuleDirectory(
    relativeDir: string,
    relevance: GuidelineRelevance,
  ): Promise<void> {
    const resolvedDir = await resolveExistingInsideWorkspace(resolve(cwd, relativeDir));
    if (!resolvedDir) return;
    try {
      const entries = await readdir(resolvedDir.realPath, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile()) continue;
        const ext = entry.name.match(/\.[^.]+$/)?.[0] ?? '';
        if (!RULE_DIRECTORY_FILES.has(ext)) continue;
        await addGuidelineWithReferences(`${relativeDir}/${entry.name}`, relevance);
      }
    } catch {
      /* directory absent */
    }
  }

  for (const relativePath of ROOT_GUIDELINE_FILES) {
    await addGuidelineWithReferences(relativePath, GUIDELINE_RELEVANCE.root);
  }
  await addRuleDirectory('.cursor/rules', GUIDELINE_RELEVANCE.root);

  for (const dir of getChangedFileAncestorDirs(changedFiles)) {
    for (const name of SCOPED_GUIDELINE_FILES) {
      await addGuidelineWithReferences(`${dir}/${name}`, GUIDELINE_RELEVANCE.scoped);
    }
    await addRuleDirectory(`${dir}/.cursor/rules`, GUIDELINE_RELEVANCE.scoped);
  }

  const governanceDir = resolve(cwd, '.pr-governance');
  const readme = await addGuidelineFile(
    '.pr-governance/README.md',
    resolve(governanceDir, 'README.md'),
    GUIDELINE_RELEVANCE.governance,
  );

  if (readme) {
    // Governance README references are review rules; they outrank the
    // deferred root-guideline references for the remaining budget.
    for (const reference of extractMarkdownDocumentReferences(readme.text)) {
      await preloadOrListReferencedDoc(governanceDir, reference);
    }
    await flushDeferredReferences();
    return buildDiscoveredGuidelines(docs, seen, referencedDocs, budgetExhausted);
  }

  try {
    const resolvedGovernanceDir = await resolveExistingInsideWorkspace(governanceDir);
    if (resolvedGovernanceDir) {
      const entries = await readdir(resolvedGovernanceDir.realPath, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile()) continue;
        await addGuidelineFile(
          `.pr-governance/${entry.name}`,
          resolve(governanceDir, entry.name),
          GUIDELINE_RELEVANCE.governance,
        );
      }
    }
  } catch {
    /* directory absent */
  }

  await flushDeferredReferences();
  return buildDiscoveredGuidelines(docs, seen, referencedDocs, budgetExhausted);
}

export async function discoverGuidelines(
  cwd: string,
  changedFiles: string[] = [],
): Promise<string> {
  return formatGuidelines(await discoverGuidelineDocs(cwd, changedFiles));
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

function buildDiscoveredGuidelines(
  docs: GuidelineDoc[],
  loadedPaths: Set<string>,
  referencedDocs: Map<string, string>,
  budgetExhausted: boolean,
): DiscoveredGuidelines {
  const referenced = [...referencedDocs]
    .filter(([path]) => !loadedPaths.has(path))
    .map(([, label]) => label)
    .sort();
  return { docs, referenced, budgetExhausted };
}

/** A single loaded guideline doc rendered as a prompt section. */
function formatGuidelineDoc(doc: GuidelineDoc): string {
  return `### ${doc.label}\n${doc.text}`;
}

/**
 * Full guideline render: every loaded doc, plus the budget notice (when the
 * total discovery budget was exhausted) and the referenced-but-not-loaded
 * pointer list. This is what the dedicated guideline-compliance session and
 * the back-compat `discoverGuidelines` wrapper receive.
 */
export function formatGuidelines(discovered: DiscoveredGuidelines): string {
  const sections = discovered.docs.map(formatGuidelineDoc);

  if (discovered.budgetExhausted) {
    sections.push(
      [
        '### Review guidance budget',
        `Additional guidance was skipped after the ${MAX_GUIDELINE_TOTAL_BYTES} byte review guidance budget was reached.`,
      ].join('\n'),
    );
  }

  if (discovered.referenced.length > 0) {
    sections.push(
      [
        '### Referenced Markdown documents',
        'These docs were mentioned by loaded review guidance but were not preloaded. Read them only when relevant to the changed files or review question.',
        discovered.referenced.map((label) => `- ${label}`).join('\n'),
      ].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/**
 * Finder-pass guideline budget. Bug-finder shards and recall lenses get this
 * relevance-ranked slice instead of the full set; the dedicated
 * guideline-compliance session still receives every loaded doc via
 * formatGuidelines. Smaller than MAX_GUIDELINE_TOTAL_BYTES on purpose: finders
 * spend attention on the diff, not on the full standards corpus.
 */
export const MAX_FINDER_GUIDELINE_BYTES = 24 * 1024;

/**
 * Relevance-ranked, byte-capped render for finder sessions (shards + lenses).
 * Docs are CHOSEN by relevance (scoped > governance > root) but RENDERED in
 * discovery order. The single highest-relevance doc is always kept even if it
 * alone exceeds the cap, so finders are never left with zero guidance; the
 * referenced-doc pointer list is omitted to avoid inviting extra reads.
 */
export function formatFinderGuidelines(
  discovered: DiscoveredGuidelines,
  options: { capBytes?: number } = {},
): string {
  const capBytes = options.capBytes ?? MAX_FINDER_GUIDELINE_BYTES;

  const ranked = discovered.docs
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => b.doc.relevance - a.doc.relevance || a.index - b.index);

  const keptIndices = new Set<number>();
  let usedBytes = 0;
  let omitted = 0;
  for (const { doc, index } of ranked) {
    const separatorBytes = keptIndices.size > 0 ? 2 : 0;
    const sectionBytes = Buffer.byteLength(formatGuidelineDoc(doc), 'utf8') + separatorBytes;
    // Always keep the single highest-relevance doc, even if it alone exceeds
    // the cap (the per-file read bound can equal this budget): finders must
    // never be left with zero guidance when guidance exists. This makes the
    // cap intentionally soft for the first doc only.
    if (keptIndices.size === 0 || usedBytes + sectionBytes <= capBytes) {
      keptIndices.add(index);
      usedBytes += sectionBytes;
    } else {
      omitted += 1;
    }
  }

  const sections = discovered.docs
    .filter((_, index) => keptIndices.has(index))
    .map(formatGuidelineDoc);

  const budgetNotes: string[] = [];
  if (omitted > 0) {
    budgetNotes.push(
      `${omitted} lower-relevance guideline file(s) were omitted from this pass to stay within the ${capBytes} byte finder budget`,
    );
  }
  if (discovered.budgetExhausted) {
    budgetNotes.push(
      `repository guidance also hit the ${MAX_GUIDELINE_TOTAL_BYTES} byte discovery budget upstream`,
    );
  }
  if (budgetNotes.length > 0) {
    sections.push(
      [
        '### Review guidance budget',
        `${budgetNotes.join('; ')}. The full set is reviewed by the separate guideline-compliance pass.`,
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

function findUtf8Boundary(buffer: Buffer, length: number): number {
  let start = length;
  while (start > 0 && (buffer[start - 1] & 0xc0) === 0x80) {
    start -= 1;
  }

  if (start === length) {
    const lastByte = buffer[length - 1];
    return utf8SequenceLength(lastByte) > 1 ? length - 1 : length;
  }

  const leadIndex = start - 1;
  const sequenceLength = utf8SequenceLength(buffer[leadIndex]);
  return length - leadIndex < sequenceLength ? leadIndex : length;
}

function utf8SequenceLength(byte: number): number {
  if (byte <= 0x7f) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

function formatGuidelineLabel(cwd: string, path: string): string {
  return relative(resolve(cwd), resolve(path));
}
