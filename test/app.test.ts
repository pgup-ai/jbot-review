import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { parseEnvBoolean, parseEnvInt, resolveAuxModelForMainModel } from '../src/app/app.ts';

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

describe('parseEnvBoolean', () => {
  it('defaults when unset', () => {
    delete process.env.JBOT_PROMPT_CACHE;

    assert.equal(parseEnvBoolean('JBOT_PROMPT_CACHE', true), true);
    assert.equal(parseEnvBoolean('JBOT_PROMPT_CACHE', false), false);
  });

  it('disables only on the literal "false" (case-insensitive)', () => {
    process.env.JBOT_PROMPT_CACHE = 'false';
    assert.equal(parseEnvBoolean('JBOT_PROMPT_CACHE', true), false);

    process.env.JBOT_PROMPT_CACHE = 'FALSE';
    assert.equal(parseEnvBoolean('JBOT_PROMPT_CACHE', true), false);
  });

  it('enables on "true" and falls back to the default for unrecognized values', () => {
    process.env.JBOT_PROMPT_CACHE = 'true';
    assert.equal(parseEnvBoolean('JBOT_PROMPT_CACHE', false), true);

    process.env.JBOT_PROMPT_CACHE = 'garbage';
    assert.equal(parseEnvBoolean('JBOT_PROMPT_CACHE', true), true);
    assert.equal(parseEnvBoolean('JBOT_PROMPT_CACHE', false), false);
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
