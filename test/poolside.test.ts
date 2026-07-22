import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { modelSupportsPromptCache, PROVIDERS } from '../src/shared/config.ts';
import {
  assertPoolsideApiKey,
  buildPoolsideCliArgs,
  buildPoolsidePromptInput,
  formatPoolsidePromptTimeoutMessage,
  isPoolsideProvider,
  parsePoolsideFinalMessage,
  POOLSIDE_DEFAULT_MODEL,
  poolsideEnvForRuntime,
  poolsideModelID,
  poolsideSettingsPath,
  writePoolsideSettings,
} from '../src/shared/poolside.ts';

describe('Poolside CLI provider helpers', () => {
  it('matches only the poolside provider id', () => {
    assert.equal(isPoolsideProvider('poolside'), true);
    assert.equal(isPoolsideProvider('Poolside'), false);
    assert.equal(isPoolsideProvider(' poolside '), false);
  });

  it('maps the default sentinel and qualifies explicit model ids', () => {
    assert.equal(poolsideModelID('poolside/default'), POOLSIDE_DEFAULT_MODEL);
    assert.equal(poolsideModelID('poolside/laguna-s-2.1'), 'poolside/laguna-s-2.1');
  });

  it('uses stdin and NLJSON in an explicit isolated workspace', () => {
    assert.deepEqual(buildPoolsideCliArgs('/tmp/jbot-poolside-workspace'), [
      'exec',
      '--directory',
      '/tmp/jbot-poolside-workspace',
      '--output',
      'json',
      '--prompt',
      '-',
      '--unsafe-auto-allow',
    ]);
  });

  it('prepends the no-tools directive', () => {
    const input = buildPoolsidePromptInput('REVIEW BODY');
    assert.match(input, /Use no tools for this review/);
    assert.ok(input.endsWith('\n\nREVIEW BODY'));
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatPoolsidePromptTimeoutMessage('review', 'poolside/laguna-s-2.1', 1200_000),
      'pool review prompt timed out after 1200s (model=poolside/laguna-s-2.1)',
    );
  });
});

describe('Poolside CLI runtime isolation', () => {
  it('validates and trims the API key', () => {
    assert.equal(assertPoolsideApiKey('  sky_test  '), 'sky_test');
    assert.throws(() => assertPoolsideApiKey('   '), /Missing Poolside API key/);
  });

  it('passes only an allowlisted ambient env plus explicit Poolside configuration', () => {
    const priorSecret = process.env.JBOT_POOL_TEST_SECRET;
    process.env.JBOT_POOL_TEST_SECRET = 'must-not-leak';
    try {
      const env = poolsideEnvForRuntime(
        'sky_explicit',
        'poolside/laguna-s-2.1',
        '/tmp/jbot-poolside-home',
      );
      assert.equal(env.JBOT_POOL_TEST_SECRET, undefined);
      assert.equal(env.POOLSIDE_API_KEY, 'sky_explicit');
      assert.equal(env.POOLSIDE_API_URL, 'https://inference.poolside.ai');
      assert.equal(env.POOLSIDE_STANDALONE_BASE_URL, 'https://inference.poolside.ai/v1');
      assert.equal(env.POOLSIDE_STANDALONE_MODEL, 'poolside/laguna-s-2.1');
      assert.equal(env.HOME, '/tmp/jbot-poolside-home');
      assert.equal(env.XDG_CONFIG_HOME, '/tmp/jbot-poolside-home/.config');
    } finally {
      if (priorSecret === undefined) delete process.env.JBOT_POOL_TEST_SECRET;
      else process.env.JBOT_POOL_TEST_SECRET = priorSecret;
    }
  });

  it('writes private settings that disable shell and deny all paths', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-poolside-test-'));
    try {
      const path = writePoolsideSettings(home);
      assert.equal(path, poolsideSettingsPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const settings = readFileSync(path, 'utf8');
      assert.match(settings, /shell:\n\s+disabled: true/);
      assert.match(settings, /deny:\n\s+- path: "\/\*\*"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('Poolside CLI output parsing', () => {
  it('returns the last assistantMessage event and ignores tool/log events', () => {
    const stdout = [
      '{"message":"partial","type":"assistantMessage"}',
      '{"type":"toolCall","title":"exit"}',
      'non-json log line',
      '{"message":"final","type":"assistantMessage"}',
    ].join('\n');
    assert.equal(parsePoolsideFinalMessage(stdout), 'final');
  });

  it('returns empty when no assistant message is present', () => {
    assert.equal(parsePoolsideFinalMessage('{"type":"toolCallResult"}'), '');
    assert.equal(parsePoolsideFinalMessage('garbage'), '');
  });
});

describe('Poolside config registration', () => {
  it('registers Laguna S 2.1 as the Pool CLI default', () => {
    assert.equal(PROVIDERS.poolside?.defaultModel, 'poolside/laguna-s-2.1');
    assert.equal(PROVIDERS.poolside?.keyEnv, 'POOLSIDE_API_KEY');
    assert.equal(PROVIDERS.poolside?.keyInput, 'poolside-api-key');
  });

  it('keeps the Action, dogfood workflow, and env example on the same key contract', () => {
    const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    const workflow = readFileSync(
      new URL('../.github/workflows/jbot-review.yml', import.meta.url),
      'utf8',
    );
    const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

    assert.match(action, /poolside-api-key:/);
    assert.match(action, /INPUT_POOLSIDE-API-KEY: \$\{\{ inputs\.poolside-api-key \}\}/);
    assert.match(workflow, /poolside-api-key: \$\{\{ secrets\.POOLSIDE_API_KEY \}\}/);
    assert.match(envExample, /^POOLSIDE_API_KEY=$/m);
    assert.match(envExample, /MODEL=poolside\/laguna-s-2\.1/);
  });

  it('disables opencode prompt-cache options for Pool CLI models', () => {
    assert.equal(modelSupportsPromptCache('poolside', 'laguna-s-2.1'), false);
  });
});
