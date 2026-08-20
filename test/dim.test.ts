import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildDimCliArgs,
  decodeDimBundle,
  dimEnvForHome,
  dimHomePaths,
  dimProviderMismatch,
  encodeDimBundle,
  parseDimEventStream,
} from '../src/shared/dim.ts';

const event = (eventType: string, payload: unknown): string =>
  JSON.stringify({ eventType, payload });

describe('buildDimCliArgs', () => {
  it('always pins plan mode, read-only, and the tool allowlist', () => {
    const args = buildDimCliArgs('dim/dimcode-api-oauth/deepseek-v4-flash');
    // --policy alone still permits every `git *`; --mode plan is what declines
    // the mutating ones, so neither may drift out of the arg set.
    assert.deepEqual(args.slice(0, 9), [
      'exec',
      '--mode',
      'plan',
      '--policy',
      'read-only',
      '--tools',
      'read,glob,grep,exec',
      '--json',
      '--stdin',
    ]);
    assert.ok(!args.includes('write') && !args.includes('skill'));
  });

  it('splits the model tail into dim provider and model, and omits both for default', () => {
    assert.deepEqual(buildDimCliArgs('dim/dimcode-api-oauth/deepseek-v4-flash').slice(9), [
      '--provider',
      'dimcode-api-oauth',
      '--model',
      'deepseek-v4-flash',
    ]);
    // A bare id stays unqualified rather than inventing a dim provider.
    assert.deepEqual(buildDimCliArgs('dim/glm-5.2').slice(9), ['--model', 'glm-5.2']);
    assert.deepEqual(buildDimCliArgs('dim/default').slice(9), []);
  });
});

describe('dim event telemetry', () => {
  it('pins the sanitized Dim 0.3.15 JSONL contract and leaves turns unavailable', () => {
    const stdout = readFileSync(new URL('fixtures/dim-events.jsonl', import.meta.url), 'utf8');
    const observed = parseDimEventStream(stdout);
    assert.equal(observed.turnCount, undefined);
    assert.equal(observed.text, 'OK');
    assert.deepEqual(observed.toolEvents, [
      {
        name: 'read',
        input: { path: 'package.json' },
        output: { content: 'sanitized', isError: false, structuredContent: {} },
        success: true,
        durationMs: 5,
      },
    ]);
    assert.deepEqual(parseDimEventStream(stdout, false).toolEvents, []);
  });
});

describe('parseDimEventStream', () => {
  it('accumulates text:delta and reads usage off run:ended', () => {
    const stdout = [
      'Session started', // dim prints this bare line before the JSONL
      event('run:started', { runId: 'r1' }),
      event('message:started', { messageId: 'm1' }),
      event('text:delta', { delta: '{"findings":' }),
      event('text:delta', { delta: '[]}' }),
      event('run:ended', {
        status: 'completed',
        usage: { promptTokens: 11, completionTokens: 7, cacheReadTokens: 3 },
      }),
    ].join('\n');
    const result = parseDimEventStream(stdout);
    assert.equal(result.text, '{"findings":[]}');
    assert.equal(result.failure, undefined);
    assert.deepEqual(result.usage, {
      input: 11,
      output: 7,
      reasoning: 0,
      cacheRead: 3,
      cacheWrite: 0,
    });
  });

  it('surfaces a failed run so a provider error is not read as an empty review', () => {
    const stdout = [
      event('text:delta', { delta: 'partial' }),
      event('run:ended', {
        status: 'failed',
        reason: 'provider_error',
        error: { message: 'Provider error: boom' },
      }),
    ].join('\n');
    assert.equal(parseDimEventStream(stdout).failure, 'Provider error: boom');
    const noMessage = event('run:ended', { status: 'failed', reason: 'timeout' });
    assert.equal(parseDimEventStream(noMessage).failure, 'run failed (timeout)');
  });
});

describe('dim bundle', () => {
  it('round-trips both files and rejects a malformed secret', () => {
    // Carrying the store is what separates a working secret from "No connected
    // provider", so a bundle missing either half must fail at setup, not mid-run.
    const bundle = {
      auth: '{"tokens":{"refresh_token":"rt"}}',
      store: 'c3FsaXRl',
      provider: 'dimcode-api-oauth',
    };
    assert.deepEqual(decodeDimBundle(encodeDimBundle(bundle)), bundle);
    assert.throws(() => decodeDimBundle('  '), /Missing dim credential/);
    assert.throws(() => decodeDimBundle('not-base64-gzip'), /Invalid DIM_AUTH_BUNDLE/);
    assert.throws(
      () => decodeDimBundle(encodeDimBundle({ auth: 'a' } as never)),
      /missing auth, store, or provider/,
    );
    // Empty and truthy-non-string both reach dim as garbage — an empty file, or a
    // Buffer.from throw — so both must be rejected here instead.
    assert.throws(
      () => decodeDimBundle(encodeDimBundle({ auth: '', store: '', provider: '' })),
      /missing auth, store, or provider/,
    );
    assert.throws(
      () => decodeDimBundle(encodeDimBundle({ auth: 1, store: {}, provider: [] } as never)),
      /missing auth, store, or provider/,
    );
  });

  it('rejects a model whose provider the pruned store cannot serve', () => {
    const bundle = { auth: 'a', store: 'b', provider: 'dimcode-api-oauth' };
    assert.equal(dimProviderMismatch('dim/dimcode-api-oauth/deepseek-v4-flash', bundle), undefined);
    assert.equal(dimProviderMismatch('dim/default', bundle), undefined);
    assert.match(
      dimProviderMismatch('dim/other-provider/some-model', bundle) ?? '',
      /carries only "dimcode-api-oauth".*dim:bundle -- other-provider/s,
    );
  });

  it('keeps auth.json at the home root and the store under v2/', () => {
    // Swapping these is a silent "Not authenticated", so both the session writer
    // and scripts/dim-bundle.ts read the layout from here.
    assert.deepEqual(dimHomePaths('/h'), {
      auth: '/h/auth.json',
      store: '/h/v2/dimcode.sqlite',
    });
  });
});

describe('dimEnvForHome', () => {
  it('carries an allowlist plus the home, and disables self-update', () => {
    process.env.OPENAI_API_KEY = 'ambient-secret';
    try {
      const env = dimEnvForHome('/tmp/dim-home');
      assert.equal(env.DIMCODE_HOME, '/tmp/dim-home');
      assert.equal(env.DIMCODE_DISABLE_AUTOUPDATE, '1');
      assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
      // An ambient key present in this process must not reach the child.
      assert.equal(env.OPENAI_API_KEY, undefined);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('refuses to run without a home rather than falling back to the real one', () => {
    assert.throws(() => dimEnvForHome(undefined), /Missing dim home/);
  });
});
