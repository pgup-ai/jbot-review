/**
 * Priority-ordered squeeze of the supplementary context blocks toward the
 * assembled-context soft cap. The per-fragment budgets already sum past that cap
 * (diff 40K + finder guidelines 24K + playbooks 8K + PR body 4K + issues 4K)
 * before prior threads and blast radius are appended, so a total can only be held
 * by dropping whole blocks. Diff hunks and guidelines are never offered here —
 * they are the signal the dilution drowns (PR #11). Pure; runner.ts wires it (#10).
 */

export interface ContextBlock {
  name: string;
  text: string;
  /** Lower drops first. Distinct from array order, which is prompt order (#5). */
  priority: number;
}

export interface TrimmedContext {
  /** Survivors, still in prompt order. */
  kept: ContextBlock[];
  /** Dropped names, in drop order; empty when everything fit. */
  dropped: string[];
}

/** The `\n\n` each block costs once joined — budgeted, not ignored. */
const BLOCK_JOINER_BYTES = 2;

/**
 * The supplementary set and its drop order, which is deliberately not prompt
 * order (#5). Blast radius is best-effort grep output and prior threads only
 * nudge the model — suppression itself is enforced in filter.ts (#2) — so both
 * go before the two blocks that shape what the review looks for.
 */
export function buildSupplementaryBlocks(blocks: {
  summaryScope: string;
  reviewFocus: string;
  priorJbotThreads: string;
  blastRadius: string;
}): ContextBlock[] {
  return [
    { name: 'summary scope', text: blocks.summaryScope, priority: 2 },
    { name: 'review focus', text: blocks.reviewFocus, priority: 3 },
    { name: 'prior jbot threads', text: blocks.priorJbotThreads, priority: 1 },
    { name: 'blast radius', text: blocks.blastRadius, priority: 0 },
  ];
}

/**
 * Drops whole blocks, lowest priority first, until the remainder fits. Whole
 * blocks rather than truncation: each carries its own heading and omission
 * notices, so a half-rendered one reads as corrupted context, not a shorter one.
 */
export function trimContextBlocks(blocks: ContextBlock[], availableBytes: number): TrimmedContext {
  const present = blocks.filter((block) => block.text !== '');
  const size = (block: ContextBlock) => Buffer.byteLength(block.text, 'utf8') + BLOCK_JOINER_BYTES;
  let total = present.reduce((sum, block) => sum + size(block), 0);
  const dropped = new Set<ContextBlock>();
  for (const block of [...present].sort((a, b) => a.priority - b.priority)) {
    if (total <= availableBytes) break;
    total -= size(block);
    dropped.add(block);
  }
  return {
    kept: present.filter((block) => !dropped.has(block)),
    dropped: [...dropped].map((block) => block.name),
  };
}
