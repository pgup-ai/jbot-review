import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCodexCliArgs,
  codexAuthPath,
  codexEnvForHome,
  formatCodexPromptTimeoutMessage,
  isCodexProvider,
  writeCodexAuth,
} from '../src/shared/codex.ts';

describe('Codex CLI provider helpers', () => {
  it('matches only the explicit codex provider id', () => {
    assert.equal(isCodexProvider('codex'), true);
    assert.equal(isCodexProvider('Codex'), false);
    assert.equal(isCodexProvider(' codex '), false);
  });

  it('omits --model for the default Codex model and runs read-only', () => {
    assert.deepEqual(buildCodexCliArgs({ model: 'codex/default' }), [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
    ]);
  });

  it('passes explicit Codex model ids without the provider prefix', () => {
    assert.deepEqual(buildCodexCliArgs({ model: 'codex/gpt-5.1-codex' }).slice(-2), [
      '--model',
      'gpt-5.1-codex',
    ]);
  });

  it('never force-bypasses the sandbox (invariant #8)', () => {
    for (const model of ['codex/default', 'codex/gpt-5.1-codex']) {
      const args = buildCodexCliArgs({ model });
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
      const sandboxIndex = args.indexOf('--sandbox');
      assert.notEqual(sandboxIndex, -1);
      assert.equal(args[sandboxIndex + 1], 'read-only');
    }
  });

  it('writes auth.json from the raw JSON secret with 0600 perms', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-codex-home-'));
    try {
      const auth = JSON.stringify({ tokens: { access_token: 'a' }, auth_mode: 'chatgpt' }, null, 2);
      const path = writeCodexAuth(auth, home);

      assert.equal(path, codexAuthPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(auth));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a blank or non-JSON Codex secret', () => {
    assert.throws(() => writeCodexAuth('   ', '/tmp/x'), /Missing Codex auth/);
    assert.throws(() => writeCodexAuth('not json', '/tmp/x'), /Invalid CODEX_AUTH_JSON/);
  });

  it('sets CODEX_HOME and strips ambient api-key envs so subscription auth wins', () => {
    const previous = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
      CODEX_ACCESS_TOKEN: process.env.CODEX_ACCESS_TOKEN,
    };
    try {
      process.env.OPENAI_API_KEY = 'sk-ambient';
      process.env.CODEX_API_KEY = 'ck-ambient';
      process.env.CODEX_ACCESS_TOKEN = 'at-ambient';

      const env = codexEnvForHome('/tmp/jbot-codex-home-test');

      assert.equal(env.CODEX_HOME, '/tmp/jbot-codex-home-test');
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
      // The ambient process env must be left untouched.
      assert.equal(process.env.OPENAI_API_KEY, 'sk-ambient');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects a blank Codex home', () => {
    assert.throws(() => codexEnvForHome('   '), /Missing Codex home/);
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatCodexPromptTimeoutMessage('finding-verification', 'codex/gpt-5.1-codex', 1200_000),
      'codex finding-verification prompt timed out after 1200s (model=codex/gpt-5.1-codex)',
    );
  });
});
