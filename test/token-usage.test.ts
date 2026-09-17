import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPromptTokenUsage, formatTokenUsage } from '../src/shared/token-usage.ts';

describe('token usage', () => {
  it('formats counters and cost, defaults missing ones to 0, and drops a non-finite cost', () => {
    assert.equal(
      formatTokenUsage({
        cost: 0.0123,
        tokens: { input: 12000, output: 600, reasoning: 900, cache: { read: 11000, write: 1000 } },
      }),
      'tokens: input=12000 output=600 reasoning=900 cache(read=11000 write=1000) cost=$0.0123',
    );
    assert.equal(
      formatTokenUsage({}),
      'tokens: input=0 output=0 reasoning=0 cache(read=0 write=0)',
    );
    assert.equal(
      formatTokenUsage({ cost: Infinity, tokens: { input: 5 } }),
      'tokens: input=5 output=0 reasoning=0 cache(read=0 write=0)',
    );
    assert.deepEqual(extractPromptTokenUsage({ cost: Infinity, tokens: { input: 5 } }), {
      input: 5,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
