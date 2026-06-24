import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseChangesSinceLastReviewSummary } from '../src/shared/opencode.ts';

const noop = () => {};

describe('parseChangesSinceLastReviewSummary', () => {
  it('extracts the summary string from a valid object', () => {
    const out = parseChangesSinceLastReviewSummary('{"summary":"- did a thing"}', 'changes-since', noop);
    assert.equal(out, '- did a thing');
  });

  it('returns empty string on unparseable output (fail open, omit the block)', () => {
    const out = parseChangesSinceLastReviewSummary('not json at all', 'changes-since', noop);
    assert.equal(out, '');
  });

  it('returns empty string when summary is missing or not a string', () => {
    assert.equal(parseChangesSinceLastReviewSummary('{"findings":[]}', 'changes-since', noop), '');
    assert.equal(parseChangesSinceLastReviewSummary('{"summary":42}', 'changes-since', noop), '');
  });
});
