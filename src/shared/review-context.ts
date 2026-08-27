import { access, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { GIT_DIFF_ARGS } from './git.ts';
import {
  extractRuleSection,
  parseDiffRoutes,
  parseRuleIdDocs,
  selectDiffRoutes,
  splitRuleId,
} from './review-routing.ts';

export interface ReviewCommit {
  sha: string;
  message: string;
  author?: string;
}

/** Same-repo issue this PR closes — intent input for the claims-verification pass. */
export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
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
  /**
   * Path scopes a `.mdc` rule declared for itself (Cursor `globs:` frontmatter).
   * Absent for docs with no declared scope and for `alwaysApply: true` rules.
   */
  globs?: string[];
}

/**
 * Cursor `.mdc` frontmatter: the one discovered-guideline source that declares
 * its own path scope. Returns the effective globs — empty for `alwaysApply`
 * rules and for docs without frontmatter, so absence means "applies anywhere".
 */
// Both PR-controlled inputs to globMatches are bounded, and matching is a
// linear-time walk (no RegExp anywhere), so hostile frontmatter can neither
// stall nor crash the review. An unusable glob is dropped at parse time,
// leaving the doc unscoped (never demoted).
const MAX_GLOB_LENGTH = 128;
const MAX_GLOBS_PER_DOC = 64;
const MAX_GLOB_VARIANTS = 64;

/** Cuts an unquoted trailing `# comment` — valid YAML Cursor tolerates. */
function stripYamlComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd();
  }
  return value;
}

function parseMdcGlobs(text: string): string[] {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  if (lines.some((line) => /^alwaysApply:\s*true\b/.test(line))) return [];
  const unquote = (value: string) => value.trim().replace(/^['"]|['"]$/g, '');
  const globs: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const inline = lines[i].match(/^globs:\s*(.*)$/);
    if (!inline) continue;
    const value = stripYamlComment(inline[1].trim());
    if (value) {
      // YAML flow sequences (`globs: ["a", "b"]`) reduce to the comma form;
      // the split must not break inside a brace set (`*.{ts,tsx}`).
      const entries = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
      globs.push(...splitOutsideBraces(entries).map(unquote));
    } else {
      for (let j = i + 1; j < lines.length; j += 1) {
        const item = lines[j].match(/^\s*-\s*(.+)$/);
        if (!item) break;
        globs.push(unquote(stripYamlComment(item[1])));
      }
    }
  }
  return globs
    .filter((glob) => glob.length > 0 && glob.length <= MAX_GLOB_LENGTH)
    .filter((glob) => expandBraces(glob).length <= MAX_GLOB_VARIANTS)
    .slice(0, MAX_GLOBS_PER_DOC);
}

function splitOutsideBraces(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * `{a,b}` sets multiply into brace-free variants; unbalanced braces stay
 * literal. Iterative — one brace set per pass — and bails the moment the
 * working set exceeds the cap, so a brace bomb ({a,b} × N) costs at most
 * one over-cap pass instead of expanding its full Cartesian product. An
 * over-cap result (length > MAX_GLOB_VARIANTS) marks the glob unusable.
 */
function expandBraces(glob: string): string[] {
  let variants = [glob];
  for (;;) {
    const next: string[] = [];
    let expanded = false;
    for (const variant of variants) {
      const open = variant.indexOf('{');
      let close = -1;
      if (open >= 0) {
        let depth = 0;
        for (let i = open; i < variant.length; i += 1) {
          if (variant[i] === '{') depth += 1;
          else if (variant[i] === '}') {
            depth -= 1;
            if (depth === 0) {
              close = i;
              break;
            }
          }
        }
      }
      if (open < 0 || close < 0) {
        next.push(variant);
        continue;
      }
      expanded = true;
      const prefix = variant.slice(0, open);
      const suffix = variant.slice(close + 1);
      for (const part of splitOutsideBraces(variant.slice(open + 1, close))) {
        next.push(prefix + part + suffix);
      }
      if (next.length > MAX_GLOB_VARIANTS) return next;
    }
    if (!expanded) return next;
    variants = next;
  }
}

type GlobToken =
  | { kind: 'lit'; ch: string }
  | { kind: 'any1' }
  | { kind: 'star' }
  | { kind: 'globstar' }
  | { kind: 'globstarSlash' };

function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          tokens.push({ kind: 'globstarSlash' });
        } else {
          tokens.push({ kind: 'globstar' });
        }
      } else {
        tokens.push({ kind: 'star' });
      }
    } else if (glob[i] === '?') {
      tokens.push({ kind: 'any1' });
    } else {
      tokens.push({ kind: 'lit', ch: glob[i] });
    }
  }
  return tokens;
}

// Reusable reachability rows: route matching runs matchTokens over every
// (glob, file) pair, so allocating a fresh array per token per call dominated
// large diffs. Node is single-threaded and matchTokens never awaits, so shared
// scratch grown to the longest path seen is safe and keeps the loop alloc-free.
let matchRowA = new Uint8Array(0);
let matchRowB = new Uint8Array(0);

/**
 * Linear-time glob match: one reachability pass per token over the target,
 * O(tokens × length) with no regex engine. Wildcard propagation is a single
 * left-to-right sweep with a carry flag — NOT an inner scan from every reachable
 * index — so an adversarial pattern (triple-star, or globstar-then-star on a
 * deep path) stays linear instead of going quadratic per glob/file pair.
 */
function matchTokens(tokens: GlobToken[], target: string): boolean {
  const len = target.length;
  if (matchRowA.length < len + 1) {
    matchRowA = new Uint8Array(len + 1);
    matchRowB = new Uint8Array(len + 1);
  }
  let cur = matchRowA;
  let next = matchRowB;
  cur.fill(0, 0, len + 1);
  cur[0] = 1;
  for (const token of tokens) {
    next.fill(0, 0, len + 1);
    switch (token.kind) {
      case 'lit':
        for (let j = 0; j < len; j += 1) if (cur[j] && target[j] === token.ch) next[j + 1] = 1;
        break;
      case 'any1':
        for (let j = 0; j < len; j += 1) if (cur[j] && target[j] !== '/') next[j + 1] = 1;
        break;
      case 'star': {
        // Any reachable index carries forward within the segment, stopping at a `/`.
        let reach = false;
        for (let k = 0; k <= len; k += 1) {
          if (cur[k]) reach = true;
          if (reach) next[k] = 1;
          if (k < len && target[k] === '/') reach = false;
        }
        break;
      }
      case 'globstar': {
        // Any reachable index carries forward across everything, slashes included.
        let reach = false;
        for (let k = 0; k <= len; k += 1) {
          if (cur[k]) reach = true;
          if (reach) next[k] = 1;
        }
        break;
      }
      case 'globstarSlash': {
        // `**/` spans any leading directories or none: reachable at the start
        // index (zero dirs) and after each subsequent `/`.
        let reach = false;
        for (let k = 0; k <= len; k += 1) {
          if (cur[k]) {
            reach = true;
            next[k] = 1;
          } else if (reach && k > 0 && target[k - 1] === '/') {
            next[k] = 1;
          }
        }
        break;
      }
    }
    const tmp = cur;
    cur = next;
    next = tmp;
  }
  return cur[len] === 1;
}

function matchGlobVariant(glob: string, target: string): boolean {
  return matchTokens(tokenizeGlob(glob), target);
}

/** Slash-less globs match the basename (Cursor's `*.ts` means "any .ts file"). */
function globMatches(glob: string, file: string): boolean {
  const target = glob.includes('/') ? file : file.slice(file.lastIndexOf('/') + 1);
  return expandBraces(glob).some((variant) => matchGlobVariant(variant, target));
}

/**
 * Compile a bounded glob into matchable token variants once (expand braces +
 * tokenize), cached by glob string. Route selection matches every glob against
 * every changed file, so without this each glob would re-expand and re-tokenize
 * per file — O(globs × files) redundant work that stalls large diffs. `null`
 * marks a glob that fails the length/variant bound (treated as non-matching).
 */
function compileBoundedGlob(
  glob: string,
  cache: Map<string, GlobToken[][] | null>,
): GlobToken[][] | null {
  const cached = cache.get(glob);
  if (cached !== undefined) return cached;
  let variants: GlobToken[][] | null = null;
  if (glob.length <= MAX_GLOB_LENGTH) {
    const expanded = expandBraces(glob);
    if (expanded.length <= MAX_GLOB_VARIANTS) variants = expanded.map(tokenizeGlob);
  }
  cache.set(glob, variants);
  return variants;
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
  linkedIssues?: LinkedIssue[];
  /** Closing issues the fetch dropped (cap, cross-repo) — disclosed in the block. */
  linkedIssuesOmitted?: number;
}

// Issue bodies are author-controlled and unbounded like the PR body; all linked
// issues share one cap (invariant #4).
export const MAX_LINKED_ISSUES_BYTES = 4 * 1024;
const LINKED_ISSUE_TRUNCATION_NOTICE =
  '\n[Issue body truncated to keep the review prompt bounded.]';
// Room held back for the trailing omission line so it always fits.
const LINKED_ISSUE_OMISSION_RESERVE_BYTES = 96;

/**
 * Data-only block (the instruction to review against it lives in prompt.ts).
 * Every emitted byte — headings, bodies, placeholders, notices, joiners —
 * charges the shared budget, so the rendered block never exceeds
 * MAX_LINKED_ISSUES_BYTES. `omittedCount` carries issues the fetch already
 * dropped (cap, cross-repo); issues that don't fit here add to it, and one
 * trailing line discloses the total.
 */
export function formatLinkedIssues(issues: LinkedIssue[], omittedCount = 0): string {
  // All-omitted (e.g. every closing reference is cross-repo) still discloses.
  if (issues.length === 0 && omittedCount === 0) return '';
  const intro = '## Linked issues\n\nGitHub records this PR as closing these issues.';
  const sections = [intro];
  const cost = (section: string) => Buffer.byteLength(`\n\n${section}`, 'utf8');
  let omitted = omittedCount;
  let remaining =
    MAX_LINKED_ISSUES_BYTES -
    Buffer.byteLength(intro, 'utf8') -
    LINKED_ISSUE_OMISSION_RESERVE_BYTES;
  for (const issue of issues) {
    const heading = `### #${issue.number}: ${issue.title || '(untitled)'}`;
    const body = issue.body.trim();
    const full = `${heading}\n${body || '(no body)'}`;
    if (cost(full) <= remaining) {
      sections.push(full);
      remaining -= cost(full);
      continue;
    }
    const bodyBudget = remaining - cost(`${heading}\n${LINKED_ISSUE_TRUNCATION_NOTICE}`);
    if (body && bodyBudget > 0) {
      const buffer = Buffer.from(body, 'utf8');
      const truncated = `${heading}\n${buffer.toString(
        'utf8',
        0,
        findUtf8Boundary(buffer, bodyBudget),
      )}${LINKED_ISSUE_TRUNCATION_NOTICE}`;
      sections.push(truncated);
      remaining -= cost(truncated);
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    sections.push(
      `(${omitted} closing issue(s) not shown: issue cap, cross-repo, or byte budget.)`,
    );
  }
  return sections.join('\n\n');
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

// These blocks grow with PR maturity and were the last uncapped ones
// (invariant #4). Budgets sit alongside the PR-body/linked-issue caps above.
export const MAX_CHANGED_FILES_BYTES = 8 * 1024;
export const MAX_COMMITS_BYTES = 4 * 1024;
export const MAX_PRIOR_COMMENTS_BYTES = 8 * 1024;
// One runaway comment must not evict every other one from the capped block.
const MAX_PRIOR_COMMENT_ENTRY_CHARS = 2_000;

/**
 * Keeps whole entries in order until the byte budget, then one disclosure
 * line. The disclosure's widest form is reserved up front so it always fits.
 */
function capListSection(
  header: string,
  entries: string[],
  budgetBytes: number,
  omission: (omitted: number) => string,
): string {
  const lines = [header];
  let used = Buffer.byteLength(header, 'utf8');
  const reserve = Buffer.byteLength(`\n${omission(entries.length)}`, 'utf8');
  let omitted = 0;
  for (const [index, entry] of entries.entries()) {
    const cost = Buffer.byteLength(`\n${entry}`, 'utf8');
    if (used + cost + reserve > budgetBytes) {
      omitted = entries.length - index;
      break;
    }
    lines.push(entry);
    used += cost;
  }
  if (omitted > 0) lines.push(omission(omitted));
  return lines.join('\n');
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

  const linkedIssuesBlock = formatLinkedIssues(
    params.linkedIssues ?? [],
    params.linkedIssuesOmitted ?? 0,
  );
  if (linkedIssuesBlock) sections.push(linkedIssuesBlock);

  sections.push(
    params.changedFiles.length > 0
      ? capListSection(
          '## Changed files',
          params.changedFiles.map((file) => `- ${file}`),
          MAX_CHANGED_FILES_BYTES,
          (omitted) =>
            `(and ${omitted} more changed file(s) not listed to keep the prompt bounded; the diff itself is unaffected.)`,
        )
      : '## Changed files\n(none)',
  );

  sections.push(
    params.commits.length > 0
      ? capListSection(
          '## Commits',
          params.commits.map((commit) => {
            const author = commit.author ? ` (${commit.author})` : '';
            return `- ${commit.sha.slice(0, 7)}${author}: ${commit.message}`;
          }),
          MAX_COMMITS_BYTES,
          (omitted) => `(and ${omitted} more commit(s) not listed.)`,
        )
      : '## Commits\n(none)',
  );

  sections.push(['## Check status summary', params.checkSummary || '(unavailable)'].join('\n'));

  if (params.priorComments.length > 0) {
    sections.push(
      capListSection(
        '## Prior review comments',
        params.priorComments.map(
          (comment) =>
            `- ${comment.length > MAX_PRIOR_COMMENT_ENTRY_CHARS ? `${comment.slice(0, MAX_PRIOR_COMMENT_ENTRY_CHARS)}…` : comment}`,
        ),
        MAX_PRIOR_COMMENTS_BYTES,
        (omitted) => `(and ${omitted} more prior review comment(s) not shown.)`,
      ),
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
// A rule doc is read in full to locate a section (which can sit past the
// per-file guideline cap); only the extracted section is charged to the budget.
const MAX_RULE_DOC_BYTES = 512 * 1024;

// Byte-cap a routed bundle's omission note. Routes are PR-controlled and can
// cite hundreds of sections with arbitrarily long dotted ids, so bounding the
// count alone is not enough — the rendered ids must fit a fixed byte budget or
// the note could dwarf the section content and blow the prompt budget.
const MAX_OMISSION_NOTE_BYTES = 1024;

/** Bounded omission note: ids listed until MAX_OMISSION_NOTE_BYTES, rest summed as "+N more". */
function renderOmissionNote(ids: string[], sourceRel: string): string {
  if (ids.length === 0) return '';
  const shown: string[] = [];
  let used = 0;
  for (const id of ids) {
    used += (shown.length > 0 ? 2 : 0) + Buffer.byteLength(id, 'utf8');
    if (used > MAX_OMISSION_NOTE_BYTES) break;
    shown.push(id);
  }
  const more = ids.length - shown.length;
  const list =
    more > 0 ? `${shown.length > 0 ? `${shown.join(', ')}, ` : ''}+${more} more` : shown.join(', ');
  return `\n\n[Omitted from this bundle to stay within budget: ${list} — read from .pr-governance/${sourceRel} if relevant.]`;
}

/**
 * Read up to MAX_RULE_DOC_BYTES from a governance file via a bounded handle
 * read — never allocating the whole of a repo-controlled, possibly oversized
 * file — and cut to a UTF-8 boundary.
 */
async function readWholeBounded(realPath: string): Promise<string> {
  const handle = await open(realPath, 'r');
  try {
    const byteLimit = Math.min((await handle.stat()).size, MAX_RULE_DOC_BYTES);
    if (byteLimit <= 0) return '';
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
    return buffer.toString('utf8', 0, findUtf8Boundary(buffer, bytesRead));
  } finally {
    await handle.close();
  }
}

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

  const governanceDir = resolve(cwd, '.pr-governance');

  // Whole-file read of a governance file (routing config, README, or rule doc),
  // independent of the guideline budget — see MAX_RULE_DOC_BYTES.
  async function readGovernanceFile(relativePath: string): Promise<string | undefined> {
    const resolved = await resolveExistingInsideWorkspace(resolve(governanceDir, relativePath));
    if (!resolved) return undefined;
    try {
      return await readWholeBounded(resolved.realPath);
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
      const globs = label.endsWith('.mdc') ? parseMdcGlobs(trimmed) : [];
      docs.push({ label, text: trimmed, relevance, ...(globs.length > 0 ? { globs } : {}) });
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

  // Load the matched sections of a rule doc as one synthetic guideline, then
  // mark the source seen so the whole (often large) file is not also loaded.
  async function addRuleSections(governanceRelPath: string, sections: string[]): Promise<void> {
    if (sections.length === 0) return;
    if (remainingGuidelineBytes <= 0) {
      markBudgetExhausted();
      return;
    }
    const resolved = await resolveExistingInsideWorkspace(
      resolve(governanceDir, governanceRelPath),
    );
    if (!resolved || seenRealPaths.has(resolved.realPath)) return;
    let source: string;
    try {
      source = await readWholeBounded(resolved.realPath);
    } catch {
      return;
    }
    const extracted = sections.map((section) => ({
      section,
      text: extractRuleSection(source, section),
    }));
    const found = extracted.filter((entry): entry is { section: string; text: string } =>
      Boolean(entry.text),
    );
    // Cited sections not present in the source (removed, mis-numbered, or past
    // the MAX_RULE_DOC_BYTES read) — named in the omission note, never dropped
    // silently.
    const missing = extracted.filter((entry) => !entry.text).map((entry) => entry.section);
    // A nested child (`### 6.1` under `## 6`) is already inside its selected
    // parent's extract — drop the duplicate so it is neither emitted nor budgeted
    // twice. Strictly-larger guard: equal-length distinct sections keep both.
    const deduped = found.filter(
      (entry) =>
        !found.some(
          (other) => other.text.length > entry.text.length && other.text.includes(entry.text),
        ),
    );
    if (deduped.length === 0) {
      // Every cited section was unavailable — disclose the request (invariant #4)
      // instead of contributing nothing. missing is non-empty here (all cited
      // sections failed to extract) and the note is bounded, like the main path.
      seen.add(resolved.absolutePath);
      seenRealPaths.add(resolved.realPath);
      const note = renderOmissionNote(
        missing.map((section) => `§${section} (not found)`),
        governanceRelPath,
      ).trim();
      remainingGuidelineBytes -= Buffer.byteLength(note, 'utf8');
      docs.push({
        label: `.pr-governance/${governanceRelPath} (unavailable)`,
        text: note,
        relevance: GUIDELINE_RELEVANCE.scoped,
      });
      return;
    }
    seen.add(resolved.absolutePath);
    seenRealPaths.add(resolved.realPath);
    // Fit whole sections under the per-file cap, skipping any single one too
    // large so a smaller later rule still lands (an oversized section never
    // blocks the rest). If every section is over-cap, keep the first so the
    // bundle is non-empty — it is truncated to the cap below.
    const cap = Math.min(MAX_GUIDELINE_FILE_BYTES, remainingGuidelineBytes);
    const included: typeof deduped = [];
    let used = 0;
    for (const entry of deduped) {
      const bytes = Buffer.byteLength(entry.text, 'utf8') + (included.length > 0 ? 2 : 0);
      if (used + bytes > cap) continue;
      included.push(entry);
      used += bytes;
    }
    if (included.length === 0) included.push(deduped[0]);
    const buffer = Buffer.from(included.map((entry) => entry.text).join('\n\n'), 'utf8');
    const label = `.pr-governance/${governanceRelPath} (§${included.map((e) => e.section).join(', §')})`;
    // Name the omitted sections (and the source) so a reviewer can read them on
    // demand instead of silently missing a matched rule that didn't fit.
    const droppedIds = [
      ...deduped.filter((entry) => !included.includes(entry)).map((e) => `§${e.section}`),
      ...missing.map((section) => `§${section} (not found)`),
    ];
    // Reserve room for the (bounded) note so body+note stays within the per-file
    // cap; +32 covers the optional truncation marker. buffer opens with a `#`
    // heading, so flooring the limit at 1 keeps at least one boundary.
    const reserve =
      Buffer.byteLength(renderOmissionNote(droppedIds, governanceRelPath), 'utf8') + 32;
    const bodyBytes = findUtf8Boundary(buffer, Math.max(1, Math.min(buffer.length, cap - reserve)));
    const note = renderOmissionNote(
      bodyBytes < buffer.length
        ? [...droppedIds, `§${included.at(-1)?.section} (truncated)`]
        : droppedIds,
      governanceRelPath,
    );
    const text = `${buffer.toString('utf8', 0, bodyBytes)}${note}`.trim();
    remainingGuidelineBytes -= Buffer.byteLength(text, 'utf8');
    docs.push({
      label,
      text,
      relevance: GUIDELINE_RELEVANCE.scoped,
    });
  }

  // Diff-scoped routing first, so its rule sections and docs win the budget over
  // the generic files below (see review-routing.ts). Absent or malformed → that
  // whole-file discovery is the fallback.
  {
    const routingText = await readGovernanceFile('review/rules-for-diff.yaml');
    const routes = routingText ? parseDiffRoutes(routingText) : [];
    if (routes.length > 0) {
      // Route globs are PR-controlled; bound them like `.mdc` globs and compile
      // each once so matching every glob against every changed file can't stall.
      const globCache = new Map<string, GlobToken[][] | null>();
      const boundedGlobMatch = (glob: string, file: string): boolean => {
        const variants = compileBoundedGlob(glob, globCache);
        if (!variants) return false;
        const target = glob.includes('/') ? file : file.slice(file.lastIndexOf('/') + 1);
        return variants.some((tokens) => matchTokens(tokens, target));
      };
      const matched = selectDiffRoutes(routes, changedFiles, boundedGlobMatch);
      const readmeText = await readGovernanceFile('README.md');
      const ruleIdDocs = readmeText ? parseRuleIdDocs(readmeText) : new Map<string, string>();
      const wholeDocRealPaths = new Set<string>();
      for (const doc of matched.docs) {
        const resolved = await resolveExistingInsideWorkspace(resolve(cwd, doc));
        if (resolved) wholeDocRealPaths.add(resolved.realPath);
      }
      const sectionsByDoc = new Map<string, string[]>();
      for (const id of matched.ruleIds) {
        const parsed = splitRuleId(id);
        const doc = parsed && ruleIdDocs.get(parsed.prefix);
        if (doc) sectionsByDoc.set(doc, [...(sectionsByDoc.get(doc) ?? []), parsed.section]);
      }
      // A doc requested whole via `docs:` outranks section extraction of the same
      // file (the whole doc already contains its sections). Compare real paths so
      // a symlinked docs: entry still matches; extracting first would mark the
      // path seen and suppress the explicit whole-doc load. Sections (most
      // targeted) load first, then the whole docs.
      for (const [doc, sections] of sectionsByDoc) {
        const resolved = await resolveExistingInsideWorkspace(resolve(governanceDir, doc));
        if (resolved && wholeDocRealPaths.has(resolved.realPath)) continue;
        await addRuleSections(doc, sections);
      }
      for (const doc of matched.docs)
        await addGuidelineWithReferences(doc, GUIDELINE_RELEVANCE.scoped);
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
// Rendered omitted-doc labels in the budget note (invariant #4 backstop).
const MAX_OMITTED_LABEL_BYTES = 1024;

/**
 * Relevance-ranked, byte-capped render for finder sessions (shards + lenses).
 * Docs are CHOSEN by relevance (scoped > governance > root) but RENDERED in
 * discovery order. The single highest-relevance doc is always kept even if it
 * alone exceeds the cap, so finders are never left with zero guidance; the
 * referenced-doc pointer list is omitted to avoid inviting extra reads.
 */
export function formatFinderGuidelines(
  discovered: DiscoveredGuidelines,
  options: { capBytes?: number; forFiles?: string[]; complianceCovers?: boolean } = {},
): string {
  const capBytes = options.capBytes ?? MAX_FINDER_GUIDELINE_BYTES;
  const complianceCovers = options.complianceCovers ?? true;

  // A rule that declared its own path scope and matches none of the changed
  // files ranks below everything else: demoted (first out under the cap),
  // never dropped outright — the compliance pass still sees the full set.
  const { forFiles } = options;
  const effectiveRelevance = (doc: GuidelineDoc): number =>
    forFiles && doc.globs && !doc.globs.some((glob) => forFiles.some((f) => globMatches(glob, f)))
      ? 0
      : doc.relevance;
  const ranked = discovered.docs
    .map((doc, index) => ({ doc, index, relevance: effectiveRelevance(doc) }))
    .sort((a, b) => b.relevance - a.relevance || a.index - b.index);

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
    // When the compliance pass is skipped, "the full set is reviewed" would be
    // false — name the omitted docs instead so a tool-capable finder can read
    // any that apply. The label list is itself byte-capped: labels are not
    // charged to any other budget, and a hostile repo could regrow the block
    // through hundreds of long paths.
    // Referenced-but-unloaded docs count too: the full rendering exposed
    // their paths, and with compliance skipped no other session names them.
    const omittedLabels = [
      ...discovered.docs.filter((_, index) => !keptIndices.has(index)).map((doc) => doc.label),
      ...discovered.referenced,
    ];
    const shownLabels: string[] = [];
    let labelBytes = 0;
    for (const label of omittedLabels) {
      labelBytes += Buffer.byteLength(`${label}, `, 'utf8');
      if (labelBytes > MAX_OMITTED_LABEL_BYTES) break;
      shownLabels.push(label);
    }
    const hidden = omittedLabels.length - shownLabels.length;
    const coverage = complianceCovers
      ? 'The full set is reviewed by the separate guideline-compliance pass.'
      : omittedLabels.length === 0
        ? 'The guideline-compliance pass is not running this run.'
        : shownLabels.length === 0
          ? `The guideline-compliance pass is not running this run; ${omittedLabels.length} omitted file(s) not listed (label budget).`
          : `The guideline-compliance pass is not running this run; omitted file(s): ${shownLabels.join(
              ', ',
            )}${hidden > 0 ? ` and ${hidden} more omitted file(s)` : ''}. Read any that apply to your changed files.`;
    sections.push(
      ['### Review guidance budget', `${budgetNotes.join('; ')}. ${coverage}`].join('\n'),
    );
  }

  return sections.join('\n\n');
}

/**
 * The guideline text a finder session receives. When the compliance pass runs
 * it audits the full set in parallel, so finders keep the relevance-ranked
 * slice — byte-identical to the slice used before this selector existed. When
 * it is skipped, only backends that cannot read the checkout still widen to
 * the full set ("no doc seen by zero sessions" is load-bearing only there);
 * tool-capable finders keep the slice with the omitted docs named for
 * on-demand reads. `widen: 'full'` (JBOT_GUIDELINE_WIDEN=full) restores the
 * old widen-everywhere behavior.
 */
export function selectFinderGuidelineText(params: {
  discovered: DiscoveredGuidelines;
  forFiles: string[];
  complianceRuns: boolean;
  mainCanReadWorkspace: boolean;
  widen: 'auto' | 'full';
  full: string;
}): string {
  if (params.complianceRuns) {
    return formatFinderGuidelines(params.discovered, { forFiles: params.forFiles });
  }
  if (params.widen === 'full' || !params.mainCanReadWorkspace) return params.full;
  return formatFinderGuidelines(params.discovered, {
    forFiles: params.forFiles,
    complianceCovers: false,
  });
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
