import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSummaryScopeBlock,
  buildMainShardFailureMessage,
  computeFinderTimeoutMs,
  computeRetryTimeoutMs,
  computeRunDeadline,
  computeVerificationTimeoutMs,
  isPrCleanAfterRun,
  shouldPostReviewComment,
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
    assert.equal(computeFinderTimeoutMs(1), 30_000); // never exceeds the run deadline
    assert.equal(computeFinderTimeoutMs(30), 30 * 60_000 - 30_000); // default budget
    assert.equal(computeFinderTimeoutMs(120), 30 * 60_000); // ceiling
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

describe('buildMainShardFailureMessage', () => {
  it('makes partial main-review coverage a fatal error', () => {
    const message = buildMainShardFailureMessage(1, 2, new Error('git diff failed'));

    assert.match(message, /1 of 2 main review shard\(s\) failed/);
    assert.match(message, /refusing to post partial review coverage/);
    assert.match(message, /git diff failed/);
  });

  it('labels a missing error as unknown', () => {
    const message = buildMainShardFailureMessage(2, 3, undefined);

    assert.match(message, /2 of 3 main review shard\(s\) failed/);
    assert.match(message, /First failure: unknown error/);
  });

  it('stringifies a non-Error failure value', () => {
    const message = buildMainShardFailureMessage(1, 4, 'provider 429');

    assert.match(message, /First failure: provider 429/);
  });
});

describe('shouldPostReviewComment', () => {
  it('always posts the first visible run, clean or not', () => {
    assert.equal(shouldPostReviewComment(0, 0), true);
    assert.equal(shouldPostReviewComment(0, 3), true);
  });

  it('posts a re-run only when it has findings', () => {
    assert.equal(shouldPostReviewComment(2, 0), false);
    assert.equal(shouldPostReviewComment(2, 1), true);
  });
});

describe('isPrCleanAfterRun', () => {
  it('is clean when no new findings and no prior threads', () => {
    assert.equal(
      isPrCleanAfterRun({ findingCount: 0, priorThreadIds: [], addressedThreadIds: [] }),
      true,
    );
  });

  it('is not clean when this run posted findings', () => {
    assert.equal(
      isPrCleanAfterRun({ findingCount: 2, priorThreadIds: [], addressedThreadIds: [] }),
      false,
    );
  });

  it('is not clean while a prior finding thread is still open (e.g. suppressed)', () => {
    // findingCount 0 because the still-open P1 was suppressed, not re-posted.
    assert.equal(
      isPrCleanAfterRun({ findingCount: 0, priorThreadIds: ['t1'], addressedThreadIds: [] }),
      false,
    );
  });

  it('is clean in the same run that addresses the last open finding', () => {
    assert.equal(
      isPrCleanAfterRun({
        findingCount: 0,
        priorThreadIds: ['t1', 't2'],
        addressedThreadIds: ['t1', 't2'],
      }),
      true,
    );
  });

  it('is not clean when only some prior threads were addressed', () => {
    assert.equal(
      isPrCleanAfterRun({
        findingCount: 0,
        priorThreadIds: ['t1', 't2'],
        addressedThreadIds: ['t1'],
      }),
      false,
    );
  });
});
