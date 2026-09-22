import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posix } from 'node:path';
import { completedReviewHead, type PrFile } from './github.ts';
import { indexEvidenceSource, resolveEvidenceImport, JS_SOURCE } from './evidence.ts';
import { extractChangedExportedSymbols } from './blast-radius.ts';
import { PATH_PATTERNS } from './diff-context.ts';

const exec = promisify(execFile);
const MARKER = /\n<!-- jbot-review:baseline:(\{[^\n]*\}) -->\n/;

export interface ReviewBaseline {
  head: string;
  base: string;
  policy: string;
}

export interface IncrementalReviewPlan {
  mode: 'full' | 'incremental';
  reason: string;
  files: PrFile[];
  baseline?: string;
}

export function reviewBaseline(body: string): ReviewBaseline | undefined {
  const footer = body.lastIndexOf('</sup>');
  const match = footer >= 0 && body.slice(footer + 6).match(MARKER);
  const head = completedReviewHead(body) ?? completedReviewHead(body, 'incremental');
  if (!match || !head) return;
  try {
    const row = JSON.parse(match[1]) as ReviewBaseline;
    if (row.head === head && /^[a-f0-9]{40}$/.test(row.base) && /^[a-f0-9]{64}$/.test(row.policy))
      return row;
  } catch {
    /* An invalid baseline requires a full review. */
  }
}

export function withReviewBaseline(body: string, baseline?: ReviewBaseline): string {
  return baseline ? `${body}\n<!-- jbot-review:baseline:${JSON.stringify(baseline)} -->` : body;
}

function indexImpactSource(path: string, text: string) {
  const index = indexEvidenceSource(path, text);
  return {
    ...index,
    declarations: [
      ...new Set([
        ...index.definitions.map((definition) => definition.symbol),
        ...extractChangedExportedSymbols([
          {
            filename: path,
            patch: text
              .split('\n')
              .map((line) => '+' + line)
              .join('\n'),
          },
        ]),
      ]),
    ],
  };
}

export function impactedReviewFiles(
  files: PrFile[],
  changed: string[],
  sources: Map<string, string[]>,
): PrFile[] {
  const indexes = new Map(
    [...sources].map(([path, texts]) => [path, texts.map((text) => indexImpactSource(path, text))]),
  );
  const paths = new Set(files.map((file) => file.filename));
  const selected = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    const symbols = new Set(
      [...selected].flatMap((path) => indexes.get(path)!.flatMap((index) => index.declarations)),
    );
    const uses = new Set(
      [...selected].flatMap((path) =>
        indexes
          .get(path)!
          .flatMap((index) => [
            ...index.uses.map((use) => use.symbol),
            ...index.imports.map((binding) => binding.imported),
          ]),
      ),
    );
    const dependencies = new Set(
      [...selected].flatMap((path) =>
        indexes
          .get(path)!
          .flatMap((index) =>
            index.imports.map((binding) => resolveEvidenceImport(path, binding.from, paths)),
          ),
      ),
    );
    const directories = new Set([...selected].map((path) => posix.dirname(path)));
    for (const file of files) {
      if (selected.has(file.filename)) continue;
      if (
        directories.has(posix.dirname(file.filename)) ||
        dependencies.has(file.filename) ||
        indexes
          .get(file.filename)!
          .some(
            (index) =>
              index.uses.some((use) => symbols.has(use.symbol)) ||
              index.imports.some(
                (binding) =>
                  symbols.has(binding.imported) ||
                  selected.has(resolveEvidenceImport(file.filename, binding.from, paths) ?? ''),
              ) ||
              index.declarations.some((symbol) => uses.has(symbol)),
          )
      ) {
        selected.add(file.filename);
        grew = true;
      }
    }
  }
  return files.filter((file) => selected.has(file.filename));
}

export async function planIncrementalReview(input: {
  workspace: string;
  files: PrFile[];
  head?: string;
  base?: string;
  policy: string;
  priorBody?: string;
  forceFull?: boolean;
  worktree?: boolean;
}): Promise<IncrementalReviewPlan> {
  const full = (reason: string): IncrementalReviewPlan => ({
    mode: 'full',
    reason,
    files: input.files,
  });
  if (input.forceFull) return full('explicit-or-incomplete-review');
  const baseline = reviewBaseline(input.priorBody ?? '');
  if (!baseline) return full('no-completed-baseline');
  if (baseline.base !== input.base) return full('base-changed');
  if (baseline.policy !== input.policy) return full('policy-changed');
  if (!input.head || input.head === baseline.head) return full('same-head-rerun');
  const deadline = Date.now() + 5000;
  const git = async (...args: string[]) => {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error('Impact lookup budget exhausted');
    return (
      await exec('git', args, {
        cwd: input.workspace,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  };
  try {
    if (input.worktree && (await git('status', '--porcelain')).trim())
      return full('uncommitted-changes');
    await git('merge-base', '--is-ancestor', baseline.head, input.head);
    const delta = await git(
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-status',
      '-z',
      baseline.head,
      input.head,
      '--',
    );
    const entries = delta.split('\0').filter(Boolean);
    const changed: string[] = [];
    for (let i = 0; i < entries.length; i += 2) {
      if (entries[i] !== 'M') return full('added-removed-or-renamed-file');
      changed.push(entries[i + 1]);
    }
    if (!changed.length || changed.length > 3) return full('broad-or-empty-followup');
    if (
      input.files.length > 80 ||
      input.files.some((file) => !file.patch || !JS_SOURCE.test(file.filename))
    )
      return full('unsupported-or-large-pr');
    const paths = new Set(input.files.map((file) => file.filename));
    if (changed.some((path) => !paths.has(path))) return full('change-outside-current-pr-diff');
    const sensitive = [
      PATH_PATTERNS.security,
      PATH_PATTERNS.data,
      PATH_PATTERNS.api,
      PATH_PATTERNS.infra,
      PATH_PATTERNS.tooling,
    ];
    if (changed.some((path) => sensitive.some((pattern) => pattern.test(path))))
      return full('sensitive-followup');
    const patch = await git(
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=0',
      baseline.head,
      input.head,
      '--',
    );
    const edits = patch.split('\n').filter((line) => /^[+-](?![+-])/.test(line));
    if (edits.length > 120 || edits.some((line) => /\b(import|export|require)\b/.test(line)))
      return full('broad-or-contract-change');
    const sources = new Map<string, string[]>();
    let bytes = 0;
    for (const file of input.files) {
      const texts = await Promise.all(
        [baseline.head, input.head].map((ref) => git('show', `${ref}:${file.filename}`)),
      );
      bytes += texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
      if (bytes > 2 * 1024 * 1024) return full('impact-context-too-large');
      // These forms defeat the simple declaration/reference expansion.
      if (
        texts.some((text) =>
          /\b(?:require\s*\(|import\s*(?:\(|['"]|\*)|export\s*[*{]|eval\s*\()/.test(text),
        )
      )
        return full('dynamic-or-reexported-dependencies');
      if (
        texts.some((text) =>
          indexEvidenceSource(file.filename, text).imports.some(
            (binding) => binding.imported === 'default' && !binding.from.startsWith('.'),
          ),
        )
      )
        return full('unresolved-default-import');
      sources.set(file.filename, texts);
    }
    const files = impactedReviewFiles(input.files, changed, sources);
    if (files.length === input.files.length || files.length > 8) return full('broad-impact');
    // A caller through an unchanged intermediary is outside the graph above.
    // Widen to a full review rather than trusting that incomplete graph.
    const terms = [
      ...new Set(
        files.flatMap((file) => [
          posix.basename(file.filename).replace(/\.[^.]+$/, ''),
          ...sources
            .get(file.filename)!
            .flatMap((text) => indexImpactSource(file.filename, text).declarations),
        ]),
      ),
    ];
    if (terms.length > 100) return full('broad-impact');
    for (const ref of [baseline.head, input.head]) {
      const references = await git(
        'grep',
        '-l',
        '-z',
        '-w',
        '-F',
        ...terms.flatMap((term) => ['-e', term]),
        ref,
        '--',
        '*.ts',
        '*.tsx',
        '*.js',
        '*.jsx',
        '*.mts',
        '*.cts',
        '*.mjs',
        '*.cjs',
      );
      if (
        references
          .split('\0')
          .filter(Boolean)
          .some((path) => !paths.has(path.slice(ref.length + 1)))
      )
        return full('references-outside-pr');
    }
    return { mode: 'incremental', reason: 'bounded-followup', files, baseline: baseline.head };
  } catch {
    return full('history-or-impact-unavailable');
  }
}
