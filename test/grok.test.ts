import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  GROK_MAX_PROMPT_BYTES,
  assertGrokPromptWithinBudget,
  buildGrokCliArgs,
  buildGrokPrompt,
  configureGrokHome,
  formatGrokPromptTimeoutMessage,
  grokAuthPath,
  grokEnvForHome,
  isGrokModelsAuthenticated,
  isGrokProvider,
} from '../src/shared/grok.ts';

describe('Grok Build CLI provider helpers', () => {
  it('matches only the grok provider id', () => {
    assert.equal(isGrokProvider('grok'), true);
    assert.equal(isGrokProvider('xai'), false);
    assert.equal(isGrokProvider('Grok'), false);
  });

  it('writes the complete auth JSON under an isolated home', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-grok-test-'));
    try {
      const auth = '{"https://auth.x.ai":{"key":"token"}}';
      const runtime = configureGrokHome(auth, home);
      assert.deepEqual(runtime, {
        home,
        authMode: 'account',
        authPath: grokAuthPath(home),
      });
      assert.equal(runtime.authMode, 'account');
      assert.deepEqual(JSON.parse(readFileSync(runtime.authPath, 'utf8')), JSON.parse(auth));
      assert.equal(statSync(join(home, '.grok')).mode & 0o777, 0o700);
      assert.equal(statSync(runtime.authPath).mode & 0o777, 0o600);
      assert.equal(
        readFileSync(join(home, '.grok', 'config.toml'), 'utf8'),
        '[cli]\nauto_update = false\n',
      );
    } finally {
      chmodSync(home, 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('configures API-key auth without writing the key to disk', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-grok-test-'));
    try {
      assert.deepEqual(configureGrokHome(' xai-test ', home), {
        home,
        authMode: 'api-key',
        apiKey: 'xai-test',
      });
      assert.equal(existsSync(grokAuthPath(home)), false);
      assert.equal(
        readFileSync(join(home, '.grok', 'config.toml'), 'utf8'),
        '[cli]\nauto_update = false\n',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects missing or malformed account auth JSON', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-grok-test-'));
    try {
      assert.throws(() => configureGrokHome('', home), /Missing Grok credential/);
      assert.throws(() => configureGrokHome('{not json', home), /Invalid GROK_AUTH_JSON/);
      assert.throws(() => configureGrokHome('[]', home), /expected a JSON object/);
      assert.equal(existsSync(join(home, '.grok')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('builds a hermetic no-write headless invocation', () => {
    assert.deepEqual(buildGrokCliArgs({ model: 'grok/default', promptFile: '/tmp/prompt' }), [
      '--sandbox',
      'strict',
      '--permission-mode',
      'dontAsk',
      '--no-memory',
      '--no-subagents',
      '--disable-web-search',
      '--no-plan',
      '--verbatim',
      '--tools',
      '',
      '--disallowed-tools',
      'Bash,Edit,Read,Grep,MCPTool,WebFetch',
      '--max-turns',
      '12',
      '--prompt-file',
      '/tmp/prompt',
      '--output-format',
      'plain',
    ]);
    assert.deepEqual(
      buildGrokCliArgs({ model: 'grok/grok-4.5', promptFile: '/tmp/prompt' }).slice(-4),
      ['--output-format', 'plain', '--model', 'grok-4.5'],
    );
  });

  it('scrubs ambient secrets and configuration from the child environment', () => {
    const previous = {
      PATH: process.env.PATH,
      XAI_API_KEY: process.env.XAI_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GROK_SANDBOX: process.env.GROK_SANDBOX,
    };
    process.env.PATH = '/test/bin';
    process.env.XAI_API_KEY = 'paid-key';
    process.env.GITHUB_TOKEN = 'github-secret';
    process.env.GROK_SANDBOX = 'off';
    try {
      const env = grokEnvForHome('/tmp/grok-home');
      assert.equal(env.PATH, '/test/bin');
      assert.equal(env.HOME, '/tmp/grok-home');
      assert.equal(env.GROK_HOME, '/tmp/grok-home/.grok');
      assert.equal(env.XAI_API_KEY, undefined);
      assert.equal(env.GITHUB_TOKEN, undefined);
      assert.equal(env.GROK_SANDBOX, undefined);
      assert.equal(grokEnvForHome('/tmp/grok-home', 'explicit-key').XAI_API_KEY, 'explicit-key');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('requires an isolated home for every invocation', () => {
    assert.throws(() => grokEnvForHome(undefined), /Missing Grok home/);
    assert.throws(() => grokEnvForHome('  '), /Missing Grok home/);
  });

  it('recognizes unauthenticated model-list output without exposing its details', () => {
    assert.equal(isGrokModelsAuthenticated('You are not authenticated.\nAvailable models:'), false);
    assert.equal(isGrokModelsAuthenticated('Available models:\n  * grok-build'), true);
  });

  it('prepends the shared no-tools directive and enforces a byte cap', () => {
    const prompt = buildGrokPrompt('review this diff');
    assert.match(prompt, /^## Tool use disabled/);
    assert.match(prompt, /review this diff$/);
    assert.doesNotThrow(() => assertGrokPromptWithinBudget('review', prompt));
    assert.throws(
      () => assertGrokPromptWithinBudget('review', 'x'.repeat(GROK_MAX_PROMPT_BYTES + 1)),
      /over the .* Grok prompt budget/,
    );
  });

  it('formats timeout diagnostics', () => {
    assert.equal(
      formatGrokPromptTimeoutMessage('review', 'grok/default', 90_000),
      'grok review prompt timed out after 90s (model=grok/default)',
    );
  });
});
