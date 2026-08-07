import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { trimContextBlocks } from '../src/shared/context-trim.ts';

// Prompt order b0,b1,b2 with drop priorities 2,0,1 — b1 must go before b2.
const blocks = [
  { name: 'b0', text: 'x'.repeat(100), priority: 2 },
  { name: 'b1', text: 'x'.repeat(100), priority: 0 },
  { name: 'b2', text: 'x'.repeat(100), priority: 1 },
];

describe('trimContextBlocks', () => {
  it('keeps everything that fits, dropping empties', () => {
    const result = trimContextBlocks([...blocks, { name: 'empty', text: '', priority: 9 }], 1000);
    assert.deepEqual(
      result.kept.map((block) => block.name),
      ['b0', 'b1', 'b2'],
    );
    assert.deepEqual(result.dropped, []);
  });

  it('drops lowest priority first, leaving survivors in prompt order', () => {
    const result = trimContextBlocks(blocks, 210);
    assert.deepEqual(result.dropped, ['b1']);
    assert.deepEqual(
      result.kept.map((block) => block.name),
      ['b0', 'b2'],
    );
    // A budget under one block's cost drops every block rather than overflowing.
    assert.deepEqual(trimContextBlocks(blocks, 0).kept, []);
  });
});
