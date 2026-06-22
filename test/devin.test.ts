import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildDevinCliArgs,
  devinCredentialsPath,
  isDevinProvider,
  truncateUtf8WithNotice,
  writeDevinCredentials,
} from '../src/shared/devin.ts';

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

  it('omits --model for the default Devin model', () => {
    assert.deepEqual(
      buildDevinCliArgs({
        model: 'devin/default',
        promptFile: '/tmp/prompt.txt',
        exportFile: '/tmp/out.atif',
      }),
      [
        '--permission-mode',
        'auto',
        '--prompt-file',
        '/tmp/prompt.txt',
        '--export',
        '/tmp/out.atif',
        '-p',
      ],
    );
  });

  it('passes explicit Devin model ids without the provider prefix', () => {
    assert.deepEqual(
      buildDevinCliArgs({
        model: 'devin/codex',
        promptFile: '/tmp/prompt.txt',
        exportFile: '/tmp/out.atif',
      }),
      [
        '--permission-mode',
        'auto',
        '--prompt-file',
        '/tmp/prompt.txt',
        '--export',
        '/tmp/out.atif',
        '--model',
        'codex',
        '-p',
      ],
    );
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
