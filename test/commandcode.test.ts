import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCommandCodeCliArgs,
  classifyCommandCodePromptFailure,
  commandCodeEnvForHome,
  commandCodeSessionEffort,
  commandCodeAuthPath,
  commandCodeSessionEstimatedCost,
  formatCommandCodePromptTimeoutMessage,
  isCommandCodeProvider,
  parseCommandCodeJsonOutput,
  parseCommandCodeModelList,
  writeCommandCodeAuth,
  writeCommandCodeReadOnlySettings,
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
      '--no-skills',
      '--no-auto-update',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
      '--max-turns',
      '1000',
    ]);
  });

  it('passes explicit CommandCode model ids without the provider prefix', () => {
    assert.deepEqual(buildCommandCodeCliArgs({ model: 'commandcode/Qwen/Qwen3.7-Max' }), [
      '-p',
      '--trust',
      '--skip-onboarding',
      '--no-skills',
      '--no-auto-update',
      '--output-format',
      'json',
      '--permission-mode',
      'plan',
      '--max-turns',
      '1000',
      '--model',
      'Qwen/Qwen3.7-Max',
    ]);
    assert.deepEqual(
      buildCommandCodeCliArgs({
        model: 'commandcode/deepseek/deepseek-v4-flash',
        effort: 'high',
      }).slice(-4),
      ['--model', 'deepseek/deepseek-v4-flash', '--effort', 'high'],
    );
  });

  it('delivers --effort from the per-model allowlist: exact for defaults, clamped when explicit', () => {
    // Defaults must never be promoted to a restricted model's floor; explicit
    // efforts clamp so one global knob still reaches restricted models. The
    // override path exercises the raw allowlist matrix.
    const deepseek = 'commandcode/deepseek/deepseek-v4-flash';
    const effortOf = (model: string, opts: Record<string, unknown> | undefined, explicit = false) =>
      commandCodeSessionEffort(model, opts, { auxModel: 'commandcode/unused', explicit });
    assert.equal(effortOf(deepseek, { reasoningEffort: 'high' }), 'high');
    assert.equal(effortOf(deepseek, { reasoningEffort: 'max' }), 'max');
    assert.equal(effortOf(deepseek, { reasoningEffort: 'low' }), undefined);
    assert.equal(effortOf(deepseek, { reasoningEffort: 'medium' }), undefined);
    assert.equal(effortOf(deepseek, { reasoningEffort: 'low' }, true), 'high');
    assert.equal(effortOf(deepseek, { reasoningEffort: 'max' }, true), 'max');
    for (const explicit of [false, true]) {
      assert.equal(
        effortOf(
          'commandcode/meta/muse-spark-1.2-contributor',
          { reasoningEffort: 'high' },
          explicit,
        ),
        undefined,
      );
      assert.equal(
        effortOf('commandcode/Qwen/Qwen3.7-Max', { reasoningEffort: 'high' }, explicit),
        undefined,
      );
    }
    assert.equal(effortOf(deepseek, {}), undefined);
    assert.equal(effortOf(deepseek, undefined), undefined);

    // Role selection: the aux default never clamps, main options and the
    // verifier override do; an aux model sharing the main entry follows it.
    const ctx = {
      auxModel: deepseek,
      auxModelOptions: { reasoningEffort: 'low' },
      mainModelOptions: { reasoningEffort: 'low' },
      explicit: true,
    };
    assert.equal(commandCodeSessionEffort(deepseek, undefined, ctx), undefined);
    assert.equal(commandCodeSessionEffort(deepseek, { reasoningEffort: 'low' }, ctx), 'high');
    assert.equal(
      commandCodeSessionEffort(deepseek, undefined, { ...ctx, auxModelOptions: undefined }),
      'high',
    );
  });

  it('denies all CommandCode tools', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-commandcode-home-'));
    try {
      const path = writeCommandCodeReadOnlySettings(home);

      assert.equal(path, join(home, '.commandcode', 'settings.json'));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
        permissions: { deny: ['*'] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

  it('parses final text and token totals from CommandCode NDJSON output', () => {
    const result = parseCommandCodeJsonOutput(
      [
        '{"type":"event","event":',
        JSON.stringify({ type: 'event', event: { type: 'tool_running' } }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          sessionId: 'session-1',
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 40,
          },
          durationMs: 1000,
          finalText: '{"summary":"ok","findings":[]}',
        }),
      ].join('\n'),
    );

    assert.deepEqual(result, {
      finalText: '{"summary":"ok","findings":[]}',
      sessionId: 'session-1',
      usage: { input: 100, output: 20, reasoning: 0, cacheRead: 30, cacheWrite: 40 },
    });

    const finalText = '{"summary":"recovered","findings":[]}';
    assert.deepEqual(
      parseCommandCodeJsonOutput(
        `{"type":"event","event":{"type":"run_end","result":{"finalText":${JSON.stringify(
          finalText,
        )},"usage":{"inputTokens":297159,"outputTokens":19247,"cacheReadTokens":191556,"cacheWriteTokens":0},"nextState":{"sessionId":"session-2","messages":[`,
      ),
      {
        finalText,
        sessionId: 'session-2',
        usage: {
          input: 297159,
          output: 19247,
          reasoning: 0,
          cacheRead: 191556,
          cacheWrite: 0,
        },
      },
    );
  });

  it('keeps a successful CommandCode result when usage is unavailable', () => {
    assert.deepEqual(
      parseCommandCodeJsonOutput(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { inputTokens: 1 },
          finalText: 'ok',
        }),
      ),
      { finalText: 'ok' },
    );
  });

  it('rejects CommandCode output without a successful result frame', () => {
    assert.throws(
      () =>
        parseCommandCodeJsonOutput(
          JSON.stringify({ type: 'result', subtype: 'error', finalText: '' }),
        ),
      /CommandCode JSON result was error/,
    );
    assert.throws(
      () => parseCommandCodeJsonOutput(JSON.stringify({ type: 'event', event: {} })),
      /contained no result frame/,
    );
  });

  it('discovers a nested session transcript and fails open when it is absent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-commandcode-home-'));
    try {
      const sessions = join(home, '.commandcode', 'projects', 'repo');
      mkdirSync(sessions, { recursive: true });
      writeFileSync(
        join(sessions, 'session-1.jsonl'),
        [
          '{"type":"header"}',
          '{"type":"message","message":{"role":"assistant"},"usage":{"costUsd":0.2}}',
          'corrupt line',
          '{"type":"message","message":{"role":"assistant"},"usage":{"costUsd":0.3}}',
          '{"type":"message","message":{"role":"assistant"},"usage":{"costUsd":-1}}',
          '{"type":"message","message":{"role":"user"},"usage":{"costUsd":10}}',
        ].join('\n'),
      );

      assert.equal(await commandCodeSessionEstimatedCost(home, 'session-1'), 0.5);
      assert.equal(await commandCodeSessionEstimatedCost(home, 'missing'), undefined);
      assert.equal(
        await commandCodeSessionEstimatedCost(join(home, 'missing'), 'session-1'),
        undefined,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('classifies CommandCode rate-limit failures from CLI output', () => {
    assert.equal(
      classifyCommandCodePromptFailure('HTTP 429 Too Many Requests. Retry-After: 30'),
      'rate_limit',
    );
    assert.equal(classifyCommandCodePromptFailure('provider rate limit exceeded'), 'rate_limit');
    assert.equal(classifyCommandCodePromptFailure('rate_limit_exceeded'), 'rate_limit');
    assert.equal(classifyCommandCodePromptFailure('request throttled'), 'rate_limit');
  });

  it('classifies CommandCode usage and quota failures from CLI output', () => {
    assert.equal(
      classifyCommandCodePromptFailure('Usage exceeded for this workspace'),
      'usage_exceeded',
    );
    assert.equal(classifyCommandCodePromptFailure('quota_exceeded'), 'usage_exceeded');
  });

  it('does not classify unrelated CommandCode failures', () => {
    assert.equal(classifyCommandCodePromptFailure('model id not found'), undefined);
  });

  it('truncates repair context by bytes with an omission notice', () => {
    const value = 'abc😃def';
    const truncated = truncateUtf8WithNotice(value, 6, 'Context');

    assert.equal(Buffer.byteLength(truncated.split('\n\n')[0]!, 'utf8') <= 6, true);
    assert.match(truncated, /\[Context truncated to \d+ bytes; omitted \d+ bytes\.\]/);
  });
});
