import type { PrFile } from './github.ts';

/**
 * Embeds the PR's diff hunks directly into the review prompt under an
 * explicit byte budget. The patches come from GitHub's files API and are
 * merge-base relative — the same text inline-comment anchors are validated
 * against — so the model reasons over exactly the lines it may anchor to.
 *
 * Files are ordered by a risk heuristic so budget truncation drops the
 * lowest-risk hunks (tests, docs) before the highest-risk ones (auth, API,
 * data). Anything truncated or omitted is listed so the agent knows to read
 * it via git instead of assuming it saw everything.
 */

/**
 * Path classifiers shared between diff risk ranking here and the review
 * focus checklist in runner.ts — one taxonomy, two consumers, no drift.
 */
export const PATH_PATTERNS = {
  security: /(^|\/)(auth|security|permissions?|policies)\//i,
  data: /(^|\/)(db|database|migrations?|prisma|drizzle|schema)\//i,
  api: /(^|\/)(api|routes?|controllers?|server|webhooks?)\//i,
  tooling: /(^|\/)(package\.json|action\.ya?ml)$|^\.github\/workflows\/.+\.ya?ml$/i,
  tests: /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/i,
} as const;

/**
 * ~10K tokens. The block is replicated into every session of a run (main,
 * lenses, compliance, verification), so the cap is per-fragment, not per-run.
 */
export const MAX_TOTAL_DIFF_BYTES = 40 * 1024;
export const MAX_FILE_DIFF_BYTES = 12 * 1024;
/** Files listed individually in the "not embedded" section before "+N more". */
const MAX_NOT_EMBEDDED_LISTED = 50;
interface RiskRule {
  pattern: RegExp;
  weight: number;
}

/** Higher weight = embedded earlier = survives budget truncation longer. */
const RISK_RULES: RiskRule[] = [
  { pattern: PATH_PATTERNS.security, weight: 60 },
  { pattern: PATH_PATTERNS.data, weight: 50 },
  { pattern: PATH_PATTERNS.api, weight: 50 },
  { pattern: /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|swift|c|cc|cpp|h)$/i, weight: 30 },
  { pattern: /\.(vue|svelte)$/i, weight: 30 },
  { pattern: PATH_PATTERNS.tooling, weight: 25 },
  { pattern: /\.(ya?ml|json|toml|ini|env)$/i, weight: 15 },
  { pattern: PATH_PATTERNS.tests, weight: -20 },
  { pattern: /\.(md|mdx|txt|rst)$/i, weight: -25 },
];

export function diffRiskScore(file: PrFile): number {
  let score = 0;
  for (const rule of RISK_RULES) {
    if (rule.pattern.test(file.filename)) score += rule.weight;
  }
  // Churn tiebreaker: more added lines, more surface for bugs. Capped so a
  // giant generated-looking patch cannot outrank a small auth change.
  const addedLines = file.patch
    ? file.patch.split('\n').filter((line) => line.startsWith('+')).length
    : 0;
  return score + Math.min(addedLines, 400) / 100;
}

/**
 * Sharding for heavy-weight models: one session over a whole large diff
 * scales reasoning time with PR size, so wall clock = one giant session.
 * Splitting files across parallel shard sessions makes wall clock ≈ the
 * slowest shard instead. Every changed file lands in exactly one shard, so
 * the UNION of shards preserves the full-diff-scope invariant.
 */
export const TARGET_SHARD_DIFF_BYTES = 24 * 1024;
export const DEFAULT_MAX_REVIEW_SHARDS = 4;

/**
 * Splits reviewable files into balanced shards. Shard count grows with total
 * patch size (one shard per TARGET_SHARD_DIFF_BYTES) up to maxShards;
 * `requestedShards` > 0 pins the count explicitly. Files are assigned
 * largest-first to the least-loaded shard, so shards finish in similar time.
 * Returns a single shard (no split) for small diffs.
 */
export function shardFilesForReview(
  files: PrFile[],
  options: { requestedShards?: number; maxShards?: number } = {},
): PrFile[][] {
  const maxShards = Math.max(1, options.maxShards ?? DEFAULT_MAX_REVIEW_SHARDS);
  const withPatch = files.filter((file) => file.patch);
  if (withPatch.length === 0) return [files];

  const patchBytes = (file: PrFile) => Buffer.byteLength(file.patch as string, 'utf8');
  const totalBytes = withPatch.reduce((sum, file) => sum + patchBytes(file), 0);
  const autoShards = Math.ceil(totalBytes / TARGET_SHARD_DIFF_BYTES);
  const requested = options.requestedShards ?? 0;
  const shardCount = Math.min(
    Math.max(requested > 0 ? requested : autoShards, 1),
    maxShards,
    withPatch.length,
  );
  if (shardCount <= 1) return [files];

  const patchless = files.filter((file) => !file.patch);
  const shards: PrFile[][] = Array.from({ length: shardCount }, () => []);
  const loads = Array.from({ length: shardCount }, () => 0);
  const bySize = [...withPatch].sort(
    (a, b) => patchBytes(b) - patchBytes(a) || a.filename.localeCompare(b.filename),
  );
  for (const file of bySize) {
    const target = loads.indexOf(Math.min(...loads));
    shards[target].push(file);
    loads[target] += patchBytes(file);
  }
  for (const file of patchless) {
    const target = loads.indexOf(Math.min(...loads));
    shards[target].push(file);
    loads[target] += 1;
  }
  return shards.filter((shard) => shard.length > 0);
}

export interface DiffHunksOptions {
  totalBudgetBytes?: number;
  perFileBudgetBytes?: number;
}

/**
 * Renders the '## Diff hunks' prompt section. Returns '' when no file has a
 * patch. Truncation is per-file (a single huge file cannot starve the rest)
 * and global; the budget covers the rendered section including headers and
 * fences, not just the raw patch bytes.
 */
export function buildDiffHunksBlock(files: PrFile[], options: DiffHunksOptions = {}): string {
  const totalBudget = options.totalBudgetBytes ?? MAX_TOTAL_DIFF_BYTES;
  const perFileBudget = options.perFileBudgetBytes ?? MAX_FILE_DIFF_BYTES;

  const withPatch = files.filter((file) => file.patch);
  if (withPatch.length === 0) return '';

  const ranked = [...withPatch].sort(
    (a, b) => diffRiskScore(b) - diffRiskScore(a) || a.filename.localeCompare(b.filename),
  );

  const sections: string[] = [];
  const notEmbedded: string[] = [];
  let remaining = totalBudget;

  for (const file of ranked) {
    const patch = file.patch as string;
    const truncationNotice = `_Hunks truncated for ${file.filename}; run the git diff command for the rest._`;
    const sectionSeparatorBytes = sections.length > 0 ? 2 : 0; // blank line between file sections
    const truncatedSectionOverhead =
      sectionSeparatorBytes +
      Buffer.byteLength(renderDiffSection(file.filename, '', true, truncationNotice), 'utf8');
    const patchBudget = Math.min(
      perFileBudget - truncatedSectionOverhead,
      remaining - truncatedSectionOverhead,
    );
    const { text, truncated } = truncateAtLineBoundary(patch, patchBudget);
    if (!text) {
      notEmbedded.push(file.filename);
      continue;
    }
    const section = renderDiffSection(file.filename, text, truncated, truncationNotice);
    const sectionBytes = sectionSeparatorBytes + Buffer.byteLength(section, 'utf8');
    if (sectionBytes > remaining) {
      notEmbedded.push(file.filename);
      continue;
    }
    remaining -= sectionBytes;
    sections.push(section);
  }

  const lines = [
    '## Diff hunks',
    'Merge-base-relative patches for the changed files, highest review risk first.',
    'These are a starting point — cross-reference callers, definitions, and tests in the checkout.',
    '',
    sections.join('\n\n'),
  ];

  if (notEmbedded.length > 0) {
    const listed = notEmbedded.slice(0, MAX_NOT_EMBEDDED_LISTED);
    lines.push(
      '',
      '### Hunks not embedded (diff budget reached)',
      'Read these with the git diff command before concluding the review:',
      ...listed.map((filename) => `- ${filename}`),
    );
    if (notEmbedded.length > listed.length) {
      lines.push(`- …and ${notEmbedded.length - listed.length} more changed files`);
    }
  }

  return lines.join('\n');
}

function renderDiffSection(
  filename: string,
  text: string,
  truncated: boolean,
  truncationNotice = `_Hunks truncated for ${filename}; run the git diff command for the rest._`,
): string {
  return [`### ${filename}`, '```diff', text, '```', ...(truncated ? [truncationNotice] : [])].join(
    '\n',
  );
}

/**
 * Cuts text to fit budgetBytes at a newline boundary so a diff line is never
 * split mid-way (a half line looks like a different change). Returns empty
 * text when not even the first line fits.
 */
function truncateAtLineBoundary(
  text: string,
  budgetBytes: number,
): { text: string; truncated: boolean } {
  if (budgetBytes <= 0) return { text: '', truncated: true };
  if (Buffer.byteLength(text, 'utf8') <= budgetBytes) return { text, truncated: false };

  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + (kept.length > 0 ? 1 : 0);
    if (used + cost > budgetBytes) break;
    kept.push(line);
    used += cost;
  }
  return { text: kept.join('\n'), truncated: true };
}
