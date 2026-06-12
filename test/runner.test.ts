import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSummaryScopeBlock } from '../src/shared/runner.ts';

const PRIOR_JBOT_REVIEW = [
  '## J-Bot Code Review',
  '- earlier summary',
  '**Reviewed head:** `abc123def456`',
].join('\n');

describe('buildSummaryScopeBlock', () => {
  it('always declares itself summary-only and never narrows review scope', () => {
    for (const block of [
      buildSummaryScopeBlock([], 'fffeeeddd111'),
      buildSummaryScopeBlock([PRIOR_JBOT_REVIEW], 'fffeeeddd111'),
    ]) {
      assert.match(block, /affect ONLY the text of the "summary" field/);
      assert.match(block, /findings always come from the complete PR diff/);
    }
  });

  it('on re-review, scopes the summary TEXT to the delta without delta-review instructions', () => {
    const block = buildSummaryScopeBlock([PRIOR_JBOT_REVIEW], 'fffeeeddd111');

    assert.match(block, /Latest prior reviewed head: abc123def456\. Current head: fffeeeddd111\./);
    assert.match(block, /still cover the full PR diff/);
    // Regression pins for the wording that originally leaked into review
    // scope on small models (the headline recall gap): never tell the model
    // to diff or review only the prior..head delta.
    assert.doesNotMatch(block, /git log/i);
    assert.doesNotMatch(block, /git diff/i);
    assert.doesNotMatch(block, /summarize only/i);
    assert.doesNotMatch(block, /review only/i);
  });

  it('asks for a whole-PR summary on the first run', () => {
    const block = buildSummaryScopeBlock([], 'fffeeeddd111');

    assert.match(block, /first visible jbot-review run/);
  });
});
