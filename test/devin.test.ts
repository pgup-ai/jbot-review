import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildDevinReadOnlyConfig,
  devinCredentialsPath,
  isDevinProvider,
  writeDevinCredentials,
} from '../src/shared/devin.ts';
import { truncateUtf8WithNotice } from '../src/shared/prompt.ts';

describe('Devin CLI provider helpers', () => {
  it('matches only the explicit devin provider id', () => {
    assert.equal(isDevinProvider('devin'), true);
    assert.equal(isDevinProvider(' openai '), false);
    assert.equal(isDevinProvider(' devin '), false);
  });

  it('writes the static credentials file with only the API key injected', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-devin-home-'));
    try {
      const path = writeDevinCredentials('test-key', home);

      assert.equal(path, devinCredentialsPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(
        readFileSync(path, 'utf8'),
        [
          'windsurf_api_key = "test-key"',
          'api_server_url = "https://server.codeium.com"',
          'devin_webapp_host = "https://app.devin.ai"',
          'devin_api_url = "https://api.devin.ai"',
          '',
        ].join('\n'),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('pins Devin sessions to read-only review permissions', () => {
    assert.deepEqual(buildDevinReadOnlyConfig(), {
      permissions: {
        allow: [
          'read',
          'grep',
          'glob',
          'Read(**)',
          'Exec(git status)',
          'Exec(git diff)',
          'Exec(git log)',
          'Exec(git show)',
          'Exec(git grep)',
          'Exec(git ls-files)',
          'Exec(git rev-parse)',
          'Exec(git merge-base)',
        ],
        deny: ['edit', 'write', 'Write(**)', 'Write(/**)'],
      },
    });
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
