import { SUPPLEMENTARY_BLOCK_NAMES } from './prompt.ts';

export interface ContextBlock {
  name: string;
  text: string;
  required?: boolean;
}

export interface TrimmedContext {
  /** Survivors, still in prompt order. */
  kept: ContextBlock[];
  /** Dropped names, in drop order; empty when everything fit. */
  dropped: string[];
}

/** The `\n\n` each block costs once joined — budgeted, not ignored. */
const BLOCK_JOINER_BYTES = 2;

export function buildSupplementaryBlocks(blocks: {
  summaryScope: string;
  reviewFocus: string;
  priorJbotThreads: string;
  blastRadius: string;
}): ContextBlock[] {
  return [
    {
      name: SUPPLEMENTARY_BLOCK_NAMES.summaryScope,
      text: blocks.summaryScope,
      required: true,
    },
    {
      name: SUPPLEMENTARY_BLOCK_NAMES.reviewFocus,
      text: blocks.reviewFocus,
      required: true,
    },
    {
      name: SUPPLEMENTARY_BLOCK_NAMES.priorJbotThreads,
      text: blocks.priorJbotThreads,
    },
    {
      name: SUPPLEMENTARY_BLOCK_NAMES.blastRadius,
      text: blocks.blastRadius,
      required: true,
    },
  ];
}

// Drop optional blocks whole so their headings and omission notices stay intact.
export function trimContextBlocks(blocks: ContextBlock[], availableBytes: number): TrimmedContext {
  const present = blocks.filter((block) => block.text !== '');
  const size = (block: ContextBlock) => Buffer.byteLength(block.text, 'utf8') + BLOCK_JOINER_BYTES;
  let total = present.reduce((sum, block) => sum + size(block), 0);
  const dropped = new Set<ContextBlock>();
  for (const block of present.filter((block) => !block.required)) {
    if (total <= availableBytes) break;
    total -= size(block);
    dropped.add(block);
  }
  return {
    kept: present.filter((block) => !dropped.has(block)),
    dropped: [...dropped].map((block) => block.name),
  };
}
