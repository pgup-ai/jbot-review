import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StaleReviewError, classifyMainShardFailure } from '../src/shared/retry-policy.ts';

describe('classifyMainShardFailure', () => {
  it('never retries deterministic failures and always retries plausibly-transient ones', () => {
    const classify = (message: string) => classifyMainShardFailure(new Error(message));

    // Deterministic: an identical prompt re-buys the identical failure.
    assert.deepEqual(classify('401 Unauthorized'), { failureClass: 'auth', retryable: false });
    assert.deepEqual(classify('invalid API key provided'), {
      failureClass: 'auth',
      retryable: false,
    });
    assert.deepEqual(classify('Incorrect API key provided'), {
      failureClass: 'auth',
      retryable: false,
    });
    assert.deepEqual(classify("Unknown model: 'opencode/nope'"), {
      failureClass: 'model-not-found',
      retryable: false,
    });
    assert.deepEqual(classify('maximum context length exceeded'), {
      failureClass: 'context-length',
      retryable: false,
    });
    assert.deepEqual(classify('413 request entity too large'), {
      failureClass: 'context-length',
      retryable: false,
    });

    // Transient: worth one fresh session.
    assert.deepEqual(classify('429 rate limit exceeded'), {
      failureClass: 'rate-limit',
      retryable: true,
    });
    assert.deepEqual(classify('review prompt did not finish within 900s'), {
      failureClass: 'timeout',
      retryable: true,
    });
    assert.deepEqual(classify('Failed to parse review JSON after repair'), {
      failureClass: 'parse',
      retryable: true,
    });
    assert.deepEqual(classify('The API server encountered an error (500)'), {
      failureClass: 'provider-transient',
      retryable: true,
    });
    assert.deepEqual(classify('Upstream idle timeout exceeded'), {
      failureClass: 'timeout',
      retryable: true,
    });

    // Unknown stays retryable: a wrongly skipped retry loses a review; a
    // wasted one only loses time (recall-safe default).
    assert.deepEqual(classifyMainShardFailure('something novel'), {
      failureClass: 'unknown',
      retryable: true,
    });
  });
});

describe('StaleReviewError', () => {
  it('carries the staleness reason and a stable message prefix for telemetry', () => {
    const error = new StaleReviewError('merged');
    assert.equal(error.reason, 'merged');
    assert.match(error.message, /^stale-before-retry: /);
  });
});
