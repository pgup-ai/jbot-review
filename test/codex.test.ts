import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  codexAuthPath,
  codexEnvForHome,
  isCodexProvider,
  writeCodexAuth,
} from '../src/shared/codex.ts';

describe('Codex CLI provider helpers', () => {
  it('matches only the explicit codex provider id', () => {
    assert.equal(isCodexProvider('codex'), true);
    assert.equal(isCodexProvider('Codex'), false);
    assert.equal(isCodexProvider(' codex '), false);
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
});
