import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildDevinCliArgs,
  buildDevinReadOnlyConfig,
  devinCredentialsPath,
  isDevinFirstRunSetupOutput,
  isDevinProvider,
  parseDevinAtifUsage,
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

  it('omits --model for the default Devin model', () => {
    assert.deepEqual(
      buildDevinCliArgs({
        model: 'devin/default',
        promptFile: '/tmp/prompt.txt',
        exportFile: '/tmp/out.atif',
        configFile: '/tmp/config.json',
      }),
      [
        '--permission-mode',
        'auto',
        '--config',
        '/tmp/config.json',
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
        configFile: '/tmp/config.json',
      }),
      [
        '--permission-mode',
        'auto',
        '--config',
        '/tmp/config.json',
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

  it('detects Devin first-run setup output separately from prompt output', () => {
    assert.equal(
      isDevinFirstRunSetupOutput(
        [
          '\u001b[1mWelcome to Devin CLI!\u001b[0m',
          'Logged in as user@example.com.',
          '',
          "You're all set. Run \u001b[1mdevin\u001b[0m to get started.",
          '',
        ].join('\n'),
      ),
      true,
    );
    assert.equal(
      isDevinFirstRunSetupOutput('{"summary":"ok","findings":[],"addressedPriorComments":[]}'),
      false,
    );
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

  it('extracts token and cost usage from Devin ATIF records', () => {
    const parsed = parseDevinAtifUsage(
      JSON.stringify({
        version: 'atif/v1',
        messages: [
          {
            role: 'assistant',
            telemetry: {
              total_input_tokens: 10,
              output_tokens: 2,
              reasoning_tokens: 3,
              cache_read_tokens: 4,
              cache_creation_tokens: 5,
              cost_usd: 0.125,
              committed_credit_cost: 0.5,
              committed_acu_cost: 1.25,
              generation_model: 'codex',
            },
          },
          {
            role: 'assistant',
            telemetry: {
              totalInputTokens: '7',
              outputTokens: 1,
              generationModel: 'codex',
            },
          },
        ],
      }),
      'devin/default',
    );

    assert.deepEqual(parsed, {
      usage: {
        input: 17,
        output: 3,
        reasoning: 3,
        cacheRead: 4,
        cacheWrite: 5,
        costUsd: 0.125,
        creditCost: 0.5,
        acuCost: 1.25,
      },
      model: 'devin/codex',
      records: 2,
    });
  });

  it('falls back to the selected Devin model when ATIF models are mixed', () => {
    const parsed = parseDevinAtifUsage(
      JSON.stringify([
        { total_input_tokens: 1, output_tokens: 2, generation_model: 'codex' },
        { total_input_tokens: 3, output_tokens: 4, generation_model: 'sonnet' },
      ]),
      'devin/default',
    );

    assert.equal(parsed?.model, 'devin/default');
  });

  it('returns undefined when Devin ATIF has no recognized usage records', () => {
    assert.equal(
      parseDevinAtifUsage(JSON.stringify({ messages: [{ role: 'assistant' }] })),
      undefined,
    );
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
