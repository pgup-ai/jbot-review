import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { minifyEnvAuth } from '../src/local/env-auth.ts';

const KEYS = new Set(['CODEX_AUTH_JSON', 'CLINE_AUTH_JSON', 'KILO_AUTH_CONTENT']);

describe('minifyEnvAuth', () => {
  it('re-joins a pretty-printed blob spilled across lines and minifies it', () => {
    const content = [
      'PROVIDER=codex',
      'CODEX_AUTH_JSON={',
      '  "access_token": "abc",',
      '  "refresh_token": "def"',
      '}',
      'MODEL=codex/default',
    ].join('\n');
    const result = minifyEnvAuth(content, KEYS);
    assert.deepEqual(result.changed, ['CODEX_AUTH_JSON']);
    assert.deepEqual(result.warnings, []);
    assert.equal(
      result.content,
      [
        'PROVIDER=codex',
        'CODEX_AUTH_JSON={"access_token":"abc","refresh_token":"def"}',
        'MODEL=codex/default',
      ].join('\n'),
    );
  });

  it('is idempotent: an already-minified value stays byte-identical', () => {
    const content = 'CODEX_AUTH_JSON={"access_token":"abc"}\n';
    const result = minifyEnvAuth(content, KEYS);
    assert.equal(result.content, content);
    assert.deepEqual(result.changed, []);
  });

  it('minifies a single-line value with internal spacing', () => {
    const result = minifyEnvAuth('KILO_AUTH_CONTENT={ "a": 1 }', KEYS);
    assert.equal(result.content, 'KILO_AUTH_CONTENT={"a":1}');
    assert.deepEqual(result.changed, ['KILO_AUTH_CONTENT']);
  });

  it('strips one pair of outer quotes around a quoted blob', () => {
    const content = ["KILO_AUTH_CONTENT='{", '  "a": 1', "}'"].join('\n');
    const result = minifyEnvAuth(content, KEYS);
    assert.equal(result.content, 'KILO_AUTH_CONTENT={"a":1}');
  });

  it('preserves an export prefix', () => {
    const result = minifyEnvAuth('export CLINE_AUTH_JSON={ "a": 1 }', KEYS);
    assert.equal(result.content, 'export CLINE_AUTH_JSON={"a":1}');
  });

  it('stops consuming at blank lines, comments, and the next KEY= line', () => {
    const content = [
      'CODEX_AUTH_JSON={',
      '  "a": 1',
      '}',
      '',
      '# comment stays',
      'CLINE_AUTH_JSON={"b":2}',
    ].join('\n');
    const result = minifyEnvAuth(content, KEYS);
    assert.equal(
      result.content,
      ['CODEX_AUTH_JSON={"a":1}', '', '# comment stays', 'CLINE_AUTH_JSON={"b":2}'].join('\n'),
    );
    assert.deepEqual(result.changed, ['CODEX_AUTH_JSON']);
  });

  it('warns and leaves the file byte-identical when the JSON never parses', () => {
    const content = ['CODEX_AUTH_JSON={', '  "a": 1', '# truncated, no closing brace'].join('\n');
    const result = minifyEnvAuth(content, KEYS);
    assert.equal(result.content, content);
    assert.deepEqual(result.changed, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^CODEX_AUTH_JSON:/);
    // Key name only — the secret value must never appear in output.
    assert.doesNotMatch(result.warnings[0], /"a"/);
  });

  it('never touches non-candidate keys or non-JSON values', () => {
    const content = ['SOME_JSON={', '  "a": 1', '}', 'CODEX_AUTH_JSON=plain-token'].join('\n');
    const result = minifyEnvAuth(content, KEYS);
    assert.equal(result.content, content);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.warnings, []);
  });
});
