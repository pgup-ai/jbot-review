import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { parseEnvInt, resolveAuxModelForMainModel } from '../src/app/app.ts';

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe('parseEnvInt', () => {
  it('accepts zero for env knobs where zero is meaningful', () => {
    process.env.JBOT_TIME_BUDGET_MINUTES = '0';

    assert.equal(parseEnvInt('JBOT_TIME_BUDGET_MINUTES', 10), 0);
  });

  it('falls back for invalid and negative values', () => {
    process.env.JBOT_REVIEW_SHARDS = '-1';
    process.env.JBOT_MAX_CONCURRENT_SESSIONS = 'many';

    assert.equal(parseEnvInt('JBOT_REVIEW_SHARDS', 3), 3);
    assert.equal(parseEnvInt('JBOT_MAX_CONCURRENT_SESSIONS', 2), 2);
  });
});

describe('resolveAuxModelForMainModel', () => {
  it('prefixes bare aux models with the main provider', () => {
    assert.equal(
      resolveAuxModelForMainModel('opencode/deepseek-v4-pro', 'deepseek-v4-flash-free'),
      'opencode/deepseek-v4-flash-free',
    );
  });

  it('keeps already-prefixed aux models on the same provider', () => {
    assert.equal(
      resolveAuxModelForMainModel('opencode/deepseek-v4-pro', 'opencode/deepseek-v4-flash-free'),
      'opencode/deepseek-v4-flash-free',
    );
  });
});
