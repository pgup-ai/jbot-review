import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSummaryScopeBlock,
  computeFinderTimeoutMs,
  computeRetryTimeoutMs,
  computeRunDeadline,
  computeVerificationTimeoutMs,
} from '../src/shared/runner.ts';

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

describe('session timeout budgeting', () => {
  it('gives finders the full budget minus the posting reserve, within clamps', () => {
    assert.equal(computeFinderTimeoutMs(0), undefined);
    assert.equal(computeFinderTimeoutMs(10), 10 * 60_000 - 30_000); // ~9.5m for a 10m budget
    assert.equal(computeFinderTimeoutMs(1), 60_000); // floor
    assert.equal(computeFinderTimeoutMs(120), 15 * 60_000); // ceiling
  });

  it('gives verification what actually remains, or signals a skip', () => {
    assert.equal(computeVerificationTimeoutMs(0, 999_999), undefined);
    // 6m budget, 3m elapsed: 3m - 30s reserve = 150s remaining.
    assert.equal(computeVerificationTimeoutMs(6, 3 * 60_000), 150_000);
    // Nearly exhausted: skip signal (0), never a tiny unusable timeout.
    assert.equal(computeVerificationTimeoutMs(6, 6 * 60_000), 0);
    // Huge budget: capped at 5 minutes.
    assert.equal(computeVerificationTimeoutMs(120, 0), 5 * 60_000);
  });
});

describe('shard retry budgeting', () => {
  it('retries with the original timeout when no budget is set', () => {
    assert.equal(computeRetryTimeoutMs(undefined, 1_000, 390_000), 390_000);
    assert.equal(computeRetryTimeoutMs(undefined, 1_000, undefined), undefined);
  });

  it('caps the retry at the remaining budget', () => {
    const deadline = 600_000;
    // 4 minutes remain, finder timeout is 6.5 — retry gets the 4 minutes.
    assert.equal(computeRetryTimeoutMs(deadline, 360_000, 390_000), 240_000);
    // Plenty remains — retry keeps the finder timeout.
    assert.equal(computeRetryTimeoutMs(deadline, 100_000, 390_000), 390_000);
  });

  it('skips the retry when under a usable minute remains', () => {
    assert.equal(computeRetryTimeoutMs(600_000, 550_000, 390_000), 0);
    assert.equal(computeRetryTimeoutMs(600_000, 700_000, 390_000), 0);
  });
});

describe('computeRunDeadline', () => {
  it('derives the absolute deadline from the budget minus the posting reserve', () => {
    assert.equal(computeRunDeadline(10, 1_000_000), 1_000_000 + 10 * 60_000 - 30_000);
    assert.equal(computeRunDeadline(0, 1_000_000), undefined);
  });
});
