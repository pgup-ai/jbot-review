import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertValidKiloAuth,
  isKiloProvider,
  KILO_STRIPPED_ENV_KEYS,
  kiloEnvForAuth,
  parseKiloModelList,
} from '../src/shared/kilo.ts';
import { modelSupportsPromptCache, PROVIDERS } from '../src/shared/config.ts';

describe('Kilo CLI provider helpers', () => {
  it('matches only the kilo provider id', () => {
    assert.equal(isKiloProvider('kilo'), true);
    assert.equal(isKiloProvider('Kilo'), false);
    assert.equal(isKiloProvider(' kilo '), false);
    assert.equal(isKiloProvider('kilocode'), false);
  });
});

describe('Kilo CLI auth env', () => {
  it('accepts valid JSON and returns trimmed content', () => {
    assert.equal(
      assertValidKiloAuth('  {"kilo":{"type":"api","key":"k"}}  '),
      '{"kilo":{"type":"api","key":"k"}}',
    );
  });

  it('rejects a blank or non-JSON Kilo secret', () => {
    assert.throws(() => assertValidKiloAuth('   '), /Missing Kilo auth/);
    assert.throws(() => assertValidKiloAuth('not json'), /Invalid KILO_AUTH_CONTENT/);
  });

  it('injects KILO_AUTH_CONTENT + isolated HOME/XDG and strips ambient keys', () => {
    const previous = new Map(KILO_STRIPPED_ENV_KEYS.map((k) => [k, process.env[k]] as const));
    try {
      for (const key of KILO_STRIPPED_ENV_KEYS) process.env[key] = `ambient-${key}`;
      const env = kiloEnvForAuth('{"kilo":{"type":"api","key":"k"}}', '/tmp/jbot-kilo-test');
      assert.equal(env.KILO_AUTH_CONTENT, '{"kilo":{"type":"api","key":"k"}}');
      assert.equal(env.HOME, '/tmp/jbot-kilo-test');
      assert.equal(env.XDG_DATA_HOME, '/tmp/jbot-kilo-test/.local/share');
      for (const key of KILO_STRIPPED_ENV_KEYS) {
        assert.equal(env[key], undefined, `${key} must be stripped from the child env`);
        assert.equal(process.env[key], `ambient-${key}`, `${key} ambient env must be intact`);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects a blank Kilo home', () => {
    assert.throws(() => kiloEnvForAuth('{"kilo":{}}', '   '), /Missing Kilo home/);
  });
});

describe('Kilo CLI output parsing', () => {
  it('extracts provider/model lines and skips log/header lines', () => {
    const out = [
      'kilo/kilo-auto/free',
      'kilo/anthropic/claude-opus-4.8',
      'kilo/stepfun/step-3.7-flash:free',
      '',
      'INFO 2026-07-01 service=db opening database',
      'Available models:',
    ].join('\n');
    assert.deepEqual(parseKiloModelList(out), [
      'kilo/kilo-auto/free',
      'kilo/anthropic/claude-opus-4.8',
      'kilo/stepfun/step-3.7-flash:free',
    ]);
  });
});

describe('Kilo config registration', () => {
  it('registers the kilo provider with the free-gateway default', () => {
    assert.equal(PROVIDERS.kilo?.defaultModel, 'kilo/kilo-auto/free');
    assert.equal(PROVIDERS.kilo?.keyEnv, 'KILO_AUTH_CONTENT');
    assert.equal(PROVIDERS.kilo?.keyInput, 'kilo-auth');
  });

  it('disables prompt cache for kilo (not opencode-driven)', () => {
    assert.equal(modelSupportsPromptCache('kilo', 'kilo-auto/free'), false);
    assert.equal(modelSupportsPromptCache('kilo', 'default'), false);
  });
});
