import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCommandCodeCliArgs,
  commandCodeEnvForHome,
  commandCodeAuthPath,
  formatCommandCodePromptTimeoutMessage,
  isCommandCodeProvider,
  parseCommandCodeModelList,
  writeCommandCodeAuth,
} from '../src/shared/commandcode.ts';
import { truncateUtf8WithNotice } from '../src/shared/prompt.ts';

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
      '20',
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
      '20',
      '--model',
      'Qwen/Qwen3.7-Max',
    ]);
  });

  it('keeps ambient API-key auth from overriding the temp auth file', () => {
    const previousApiKey = process.env.COMMAND_CODE_API_KEY;
    const previousHome = process.env.HOME;
    try {
      process.env.COMMAND_CODE_API_KEY = 'stale-api-key';
      process.env.HOME = '/ambient-home';

      const env = commandCodeEnvForHome('/tmp/jbot-commandcode-home-test');

      assert.equal(env?.HOME, '/tmp/jbot-commandcode-home-test');
      assert.equal(env?.COMMAND_CODE_API_KEY, undefined);
      assert.equal(process.env.COMMAND_CODE_API_KEY, 'stale-api-key');
    } finally {
      if (previousApiKey === undefined) delete process.env.COMMAND_CODE_API_KEY;
      else process.env.COMMAND_CODE_API_KEY = previousApiKey;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatCommandCodePromptTimeoutMessage(
        'review-integrity',
        'commandcode/zai-org/GLM-5.2',
        1770_000,
      ),
      'commandcode review-integrity prompt timed out after 1770s (model=commandcode/zai-org/GLM-5.2)',
    );
  });

  it('parses model ids from CommandCode list output', () => {
    assert.deepEqual(
      parseCommandCodeModelList(
        [
          'Available models  ·  3 models',
          '',
          'Open Source',
          '',
          'zai-org/GLM-5.2                      powerful coding with 1M context',
          'Qwen/Qwen3.7-Max                     frontier coding',
          '',
          'OpenAI',
          '',
          'gpt-5.5                              latest frontier model',
          '',
          'Pass the full id, or just the short name after the last "/":',
          'cmd --model qwen3.7-max',
        ].join('\n'),
      ),
      ['zai-org/GLM-5.2', 'Qwen/Qwen3.7-Max', 'gpt-5.5'],
    );
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
