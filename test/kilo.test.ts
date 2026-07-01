import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertValidKiloAuth,
  buildKiloCliArgs,
  buildKiloPromptInput,
  formatKiloPromptTimeoutMessage,
  isKiloProvider,
  KILO_STRIPPED_ENV_KEYS,
  kiloEnvForAuth,
  parseKiloFinalMessage,
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

describe('Kilo CLI output parsing', () => {
  it('returns the LAST type:text event part.text (cumulative — never concat)', () => {
    const ndjson = [
      '{"type":"step_start"}',
      'INFO 2026-07-01 service=db opening database',
      '{"type":"text","part":{"type":"text","text":"PONG"}}',
      '{"type":"text","part":{"type":"text","text":"PONG"}}',
      '{"type":"step_finish"}',
    ].join('\n');
    // Two identical cumulative snapshots must yield "PONG", not "PONGPONG".
    assert.equal(parseKiloFinalMessage(ndjson), 'PONG');
  });

  it('returns the full text from a single cumulative event', () => {
    const ndjson = '{"type":"text","part":{"type":"text","text":"ALPHA\\nBRAVO"}}';
    assert.equal(parseKiloFinalMessage(ndjson), 'ALPHA\nBRAVO');
  });

  it('returns empty when no text event is present', () => {
    assert.equal(parseKiloFinalMessage('{"type":"error","error":{"data":{"message":"boom"}}}'), '');
    assert.equal(parseKiloFinalMessage('garbage\nlines'), '');
    assert.equal(parseKiloFinalMessage('{"type":"text","part":{"text":""}}'), '');
  });

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

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatKiloPromptTimeoutMessage('finding-verification', 'kilo/kilo-auto/free', 1200_000),
      'kilo finding-verification prompt timed out after 1200s (model=kilo/kilo-auto/free)',
    );
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
