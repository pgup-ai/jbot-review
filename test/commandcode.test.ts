import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCommandCodeCliArgs,
  commandCodeAuthPath,
  isCommandCodeProvider,
  truncateUtf8WithNotice,
  writeCommandCodeAuth,
} from '../src/shared/commandcode.ts';

describe('CommandCode CLI provider helpers', () => {
  it('matches only the explicit commandcode provider id', () => {
    assert.equal(isCommandCodeProvider('commandcode'), true);
    assert.equal(isCommandCodeProvider('CommandCode'), false);
    assert.equal(isCommandCodeProvider(' commandcode '), false);
  });

  it('writes the CLI auth file from a single access key', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-commandcode-home-'));
    try {
      const path = writeCommandCodeAuth('cc-access-key', home);

      assert.equal(path, commandCodeAuthPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { apiKey: 'cc-access-key' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('omits --model for the default CommandCode model', () => {
    assert.deepEqual(buildCommandCodeCliArgs({ model: 'commandcode/default' }), [
      '-p',
      '--trust',
      '--skip-onboarding',
      '--permission-mode',
      'plan',
      '--max-turns',
      '10',
    ]);
  });

  it('passes explicit CommandCode model ids without the provider prefix', () => {
    assert.deepEqual(buildCommandCodeCliArgs({ model: 'commandcode/Qwen/Qwen3.7-Max' }), [
      '-p',
      '--trust',
      '--skip-onboarding',
      '--permission-mode',
      'plan',
      '--max-turns',
      '10',
      '--model',
      'Qwen/Qwen3.7-Max',
    ]);
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
