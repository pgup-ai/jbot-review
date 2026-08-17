import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDimCliArgs,
  decodeDimBundle,
  dimEnvForHome,
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
  });
});

describe('dim bundle', () => {
  it('round-trips both files and rejects a malformed secret', () => {
    // Carrying the store is what separates a working secret from "No connected
    // provider", so a bundle missing either half must fail at setup, not mid-run.
    const bundle = { auth: '{"tokens":{"refresh_token":"rt"}}', store: 'c3FsaXRl' };
    assert.deepEqual(decodeDimBundle(encodeDimBundle(bundle)), bundle);
    assert.throws(() => decodeDimBundle('  '), /Missing dim credential/);
    assert.throws(() => decodeDimBundle('not-base64-gzip'), /Invalid DIM_AUTH_BUNDLE/);
    assert.throws(
      () => decodeDimBundle(encodeDimBundle({ auth: 'a' } as never)),
      /missing auth or store/,
    );
  });
});

describe('dimEnvForHome', () => {
  it('carries an allowlist plus the home, and disables self-update', () => {
    const env = dimEnvForHome('/tmp/dim-home');
    assert.equal(env.DIMCODE_HOME, '/tmp/dim-home');
    assert.equal(env.DIMCODE_DISABLE_AUTOUPDATE, '1');
    // Ambient provider credentials must not reach the child.
    assert.ok(!Object.keys(env).some((key) => /(^|_)(KEY|TOKEN|SECRET)$/.test(key)));
  });

  it('refuses to run without a home rather than falling back to the real one', () => {
    assert.throws(() => dimEnvForHome(undefined), /Missing dim home/);
  });
});
