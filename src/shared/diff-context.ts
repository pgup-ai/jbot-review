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
export const MAX_TOTAL_DIFF_BYTES = 64 * 1024;
export const MAX_FILE_DIFF_BYTES = 12 * 1024;

interface RiskRule {
  pattern: RegExp;
  weight: number;
}

/** Higher weight = embedded earlier = survives budget truncation longer. */
const RISK_RULES: RiskRule[] = [
  { pattern: /(^|\/)(auth|security|permissions?|policies)\//i, weight: 60 },
  { pattern: /(^|\/)(db|database|migrations?|prisma|drizzle|schema)\//i, weight: 50 },
  { pattern: /(^|\/)(api|routes?|controllers?|server|webhooks?)\//i, weight: 50 },
  { pattern: /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs|swift|c|cc|cpp|h)$/i, weight: 30 },
  { pattern: /\.(vue|svelte)$/i, weight: 30 },
  { pattern: /(^|\/)(package\.json|action\.ya?ml)$|^\.github\/workflows\/.+\.ya?ml$/i, weight: 25 },
  { pattern: /\.(ya?ml|json|toml|ini|env)$/i, weight: 15 },
  { pattern: /(^|\/)(test|tests|__tests__|spec)\//i, weight: -20 },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/i, weight: -20 },
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

export interface DiffHunksOptions {
  totalBudgetBytes?: number;
  perFileBudgetBytes?: number;
}

/**
 * Renders the '## Diff hunks' prompt section. Returns '' when no file has a
 * patch. Truncation is per-file (a single huge file cannot starve the rest)
 * and global (the section never exceeds the total budget).
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
    const budget = Math.min(perFileBudget, remaining);
    const { text, truncated } = truncateAtLineBoundary(patch, budget);
    if (!text) {
      notEmbedded.push(file.filename);
      continue;
    }
    remaining -= Buffer.byteLength(text, 'utf8');
    sections.push(
      [
        `### ${file.filename}`,
        '```diff',
        text,
        '```',
        ...(truncated
          ? [`_Hunks truncated for ${file.filename}; run the git diff command for the rest._`]
          : []),
      ].join('\n'),
    );
  }

  const lines = [
    '## Diff hunks',
    'Merge-base-relative patches for the changed files, highest review risk first.',
    'These are a starting point — cross-reference callers, definitions, and tests in the checkout.',
    '',
    sections.join('\n\n'),
  ];

  if (notEmbedded.length > 0) {
    lines.push(
      '',
      '### Hunks not embedded (diff budget reached)',
      'Read these with the git diff command before concluding the review:',
      ...notEmbedded.map((filename) => `- ${filename}`),
    );
  }

  return lines.join('\n');
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
