import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertValidKiloAuth,
  buildKiloCliArgs,
  buildKiloPromptInput,
  isKiloProvider,
  KILO_STRIPPED_ENV_KEYS,
  kiloEnvForAuth,
} from '../src/shared/kilo.ts';

describe('Kilo CLI provider helpers', () => {
  it('matches only the kilo provider id', () => {
    assert.equal(isKiloProvider('kilo'), true);
    assert.equal(isKiloProvider('Kilo'), false);
    assert.equal(isKiloProvider(' kilo '), false);
    assert.equal(isKiloProvider('kilocode'), false);
  });

  it('maps default to the free gateway model, gateway-prefixed', () => {
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/default' }), [
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      '--model',
      'kilo/kilo-auto/free',
    ]);
  });

  it('preserves the kilo/ gateway prefix for explicit models', () => {
    // parseModelName strips the leading `kilo/`; buildKiloCliArgs must re-add it,
    // else the bare id 404s ("Model not found") — POC-observed.
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/kilo-auto/free' }).slice(-2), [
      '--model',
      'kilo/kilo-auto/free',
    ]);
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/anthropic/claude-opus-4.8' }).slice(-2), [
      '--model',
      'kilo/anthropic/claude-opus-4.8',
    ]);
  });

  it('never emits bypass flags (invariant #8)', () => {
    for (const model of ['kilo/default', 'kilo/kilo-auto/free']) {
      const args = buildKiloCliArgs({ model });
      assert.equal(args.includes('--auto'), false);
      assert.equal(args.includes('--dangerously-skip-permissions'), false);
      const agentIdx = args.indexOf('--agent');
      assert.equal(args[agentIdx + 1], 'plan');
    }
  });

  it('prepends the no-tools directive to the prompt input (avoids read-only stall)', () => {
    const input = buildKiloPromptInput('REVIEW BODY');
    assert.match(input, /Use no tools for this review/);
    assert.ok(input.endsWith('\n\nREVIEW BODY'));
  });
});

describe('Kilo CLI auth env', () => {
  it('accepts valid JSON and returns trimmed content', () => {
    assert.equal(assertValidKiloAuth('  {"kilo":{"type":"api","key":"k"}}  '), '{"kilo":{"type":"api","key":"k"}}');
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
