import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSupplementaryBlocks, trimContextBlocks } from '../src/shared/context-trim.ts';

const blocks = [
  { name: 'b0', text: 'x'.repeat(100), required: true },
  { name: 'b1', text: 'x'.repeat(100) },
  { name: 'b2', text: 'x'.repeat(100) },
];

describe('buildSupplementaryBlocks', () => {
  it('preserves investigation and scope hints even when the required diff exceeds the soft cap', () => {
    const built = buildSupplementaryBlocks({
      summaryScope: 'a',
      reviewFocus: 'b',
      priorJbotThreads: 'c',
      blastRadius: 'd',
    });
    assert.deepEqual(
      built.map((block) => block.name),
      ['summary scope', 'review focus', 'prior jbot threads', 'blast radius'],
    );
    const trimmed = trimContextBlocks(built, -200_000);
    assert.deepEqual(trimmed.dropped, ['prior jbot threads']);
    assert.deepEqual(
      trimmed.kept.map((block) => block.text),
      ['a', 'b', 'd'],
    );
  });
});

describe('trimContextBlocks', () => {
  it('keeps everything that fits, dropping empties', () => {
    const result = trimContextBlocks([...blocks, { name: 'empty', text: '' }], 1000);
    assert.deepEqual(
      result.kept.map((block) => block.name),
      ['b0', 'b1', 'b2'],
    );
    assert.deepEqual(result.dropped, []);
  });

  it('drops optional blocks while preserving required evidence and prompt order', () => {
    const result = trimContextBlocks(blocks, 210);
    assert.deepEqual(result.dropped, ['b1']);
    assert.deepEqual(
      result.kept.map((block) => block.name),
      ['b0', 'b2'],
    );
    assert.deepEqual(trimContextBlocks(blocks, 0).kept, [blocks[0]]);
  });
});
