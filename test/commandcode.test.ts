import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildCommandCodeCliArgs,
  classifyCommandCodePromptFailure,
  composeCommandCodeMonthlyWindow,
  pickCommandCodeAccessKey,
  selectCommandCodeAccessKey,
  splitCommandCodeAccessKeys,
  formatCommandCodePlanUsage,
  parseCommandCodeMonthlySpend,
  parseCommandCodePeriodBounds,
  parseCommandCodePlanUsage,
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

describe('CommandCode plan usage', () => {
  const now = 1_788_230_000_000;
  const payload = {
    credits: {
      belowThreshold: false,
      creditThreshold: 0,
      monthlyCredits: 38.0527,
      purchasedCredits: 0,
      freeCredits: 0,
    },
    windowLimits: {
      limited: true,
      exceeded: null,
      fiveHour: {
        used: 0.6132,
        cap: 14,
        exceeded: false,
        resetAt: now + 2 * 3_600_000 + 41 * 60_000,
      },
      weekly: { used: 35, cap: 35, exceeded: true, resetAt: now + 49 * 3_600_000 },
    },
  };

  it('parses the credits payload and formats the one-line meter', () => {
    const usage = parseCommandCodePlanUsage(payload);
    assert.ok(usage);
    assert.equal(
      formatCommandCodePlanUsage(usage, now),
      'CommandCode plan usage: 5h 0.6/14 (4%, resets in 2h 41m), weekly 35.0/35 (100%, EXCEEDED, resets in 2d 1h); 38.1 plan credits remaining.',
    );
    // Purchased credits surface — that is the balance overage draws from.
    assert.match(
      formatCommandCodePlanUsage({ ...usage, purchasedCredits: 12 }, now),
      / \+ 12\.0 purchased\.$/,
    );
    // Sub-percent spend stays distinguishable from a zero meter.
    assert.match(
      formatCommandCodePlanUsage(
        { ...usage, fiveHour: { used: 0.0006, cap: 14, exceeded: false, resetAt: now } },
        now,
      ),
      /5h 0\.0\/14 \(<1%,/,
    );
  });

  it('composes and formats the monthly billing-period meter', () => {
    assert.equal(
      parseCommandCodeMonthlySpend({ totalMonthlyCredits: 32.2563, periodBasis: 'billing-period' }),
      32.2563,
    );
    const bounds = parseCommandCodePeriodBounds({
      data: {
        currentPeriodStart: '2026-08-13T22:06:17.000Z',
        currentPeriodEnd: '2026-09-13T22:06:17.000Z',
      },
    });
    assert.deepEqual(bounds, {
      startIso: '2026-08-13T22:06:17.000Z',
      endMs: Date.parse('2026-09-13T22:06:17.000Z'),
    });
    // Drift in either secondary payload drops only the monthly enrichment.
    for (const bad of [null, [], { totalMonthlyCredits: -1 }, { totalMonthlyCredits: 'x' }]) {
      assert.equal(parseCommandCodeMonthlySpend(bad), undefined);
    }
    for (const bad of [
      null,
      {},
      { data: { currentPeriodEnd: '2026-09-13T22:06:17.000Z' } },
      { data: { currentPeriodStart: 'x', currentPeriodEnd: '2026-09-13T22:06:17.000Z' } },
      {
        data: {
          currentPeriodStart: '2026-09-13T22:06:17.000Z',
          currentPeriodEnd: '2026-08-13T22:06:17.000Z',
        },
      },
    ]) {
      assert.equal(parseCommandCodePeriodBounds(bad), undefined);
    }
    // Zero plan total (free account) has nothing to meter, and a negative
    // remaining would shrink the cap below the plan's real total.
    assert.equal(composeCommandCodeMonthlyWindow(0, 0, 1), undefined);
    assert.equal(composeCommandCodeMonthlyWindow(32, -5, 1), undefined);

    const usage = parseCommandCodePlanUsage(payload);
    assert.ok(usage);
    usage.monthly = composeCommandCodeMonthlyWindow(32.2563, usage.monthlyCredits, bounds!.endMs);
    assert.match(
      formatCommandCodePlanUsage(usage, now),
      /, monthly 32\.3\/70\.3 \(46%, resets Sep 13\); 38\.1 plan credits remaining\.$/,
    );
  });

  it('degrades to a credits-only line without windows and rejects drifted shapes', () => {
    const usage = parseCommandCodePlanUsage({ credits: { monthlyCredits: 5 } });
    assert.ok(usage);
    assert.equal(usage.fiveHour, undefined);
    // Explicit null degrades too: null is this API's none value (see the live
    // payload's windowLimits.exceeded: null), not shape drift.
    assert.ok(parseCommandCodePlanUsage({ credits: { monthlyCredits: 5 }, windowLimits: null }));
    assert.equal(
      formatCommandCodePlanUsage(usage, now),
      'CommandCode plan usage: 5.0 plan credits remaining.',
    );
    // Alpha API: any shape drift parses to undefined, never throws. A field
    // that is PRESENT but invalid poisons the whole payload (a partial line
    // would hide a real limit); only absent fields degrade.
    const window = { used: 1, cap: 14, exceeded: false, resetAt: now };
    for (const drifted of [
      null,
      'x',
      {},
      { credits: {} },
      { credits: { monthlyCredits: 'a' } },
      { credits: { monthlyCredits: 5, purchasedCredits: 'x' } },
      { credits: { monthlyCredits: 5 }, windowLimits: 'x' },
      { credits: { monthlyCredits: 5 }, windowLimits: [] },
      { credits: { monthlyCredits: 5 }, windowLimits: { fiveHour: 'x' } },
      { credits: { monthlyCredits: 5 }, windowLimits: { fiveHour: [window] } },
      { credits: { monthlyCredits: 5 }, windowLimits: { fiveHour: { ...window, used: -1 } } },
      { credits: { monthlyCredits: 5 }, windowLimits: { fiveHour: { ...window, cap: 0 } } },
      { credits: { monthlyCredits: 5 }, windowLimits: { weekly: { ...window, resetAt: 'soon' } } },
      { credits: { monthlyCredits: 5 }, windowLimits: { weekly: { ...window, exceeded: 'yes' } } },
    ]) {
      assert.equal(parseCommandCodePlanUsage(drifted), undefined);
    }
  });
});

describe('CommandCode multi-key pick', () => {
  const usage = (monthlyCredits, fiveExceeded = false, weekExceeded = false) => ({
    monthlyCredits,
    purchasedCredits: 0,
    fiveHour: { used: 1, cap: 14, resetAt: 1, exceeded: fiveExceeded },
    weekly: { used: 1, cap: 35, resetAt: 1, exceeded: weekExceeded },
  });

  it('splits key lists; single keys stay on the legacy path', () => {
    assert.deepEqual(splitCommandCodeAccessKeys('a, b,,c '), ['a', 'b', 'c']);
    assert.deepEqual(splitCommandCodeAccessKeys(' solo '), ['solo']);
    assert.deepEqual(splitCommandCodeAccessKeys(',,'), []);
  });

  it('resolves the selector without probing when at most one key survives', async () => {
    const logs = [];
    const log = (message) => logs.push(message);
    // Comma-free values are byte-identical verbatim, whitespace included.
    assert.equal(await selectCommandCodeAccessKey(' solo ', log), ' solo ');
    // Stray separators around one real key normalize to it.
    assert.equal(await selectCommandCodeAccessKey('key,', log), 'key');
    assert.equal(await selectCommandCodeAccessKey(',key,', log), 'key');
    // Nothing parseable keeps the raw value (legacy garbage-in behavior).
    assert.equal(await selectCommandCodeAccessKey(',,', log), ',,');
    assert.equal(logs.length, 0);
  });

  it('picks window-open keys by most remaining credits, failing back sanely', () => {
    // Healthy keys: most monthly credits remaining wins; ties keep the first.
    assert.equal(
      pickCommandCodeAccessKey([
        { key: 'k1', usage: usage(3) },
        { key: 'k2', usage: usage(9) },
      ]).key,
      'k2',
    );
    assert.equal(
      pickCommandCodeAccessKey([
        { key: 'k1', usage: usage(5) },
        { key: 'k2', usage: usage(5) },
      ]).key,
      'k1',
    );
    // A window-limited key loses to an open one regardless of balance.
    const windowAware = pickCommandCodeAccessKey([
      { key: 'k1', usage: usage(9, true) },
      { key: 'k2', usage: usage(3) },
    ]);
    assert.equal(windowAware.key, 'k2');
    assert.match(windowAware.reason, /picked 2\/2 \(…k2, 3\.0 credits remaining\)/);
    // Every window limited: fall back to most remaining, flagged as such.
    const allLimited = pickCommandCodeAccessKey([
      { key: 'k1', usage: usage(9, true) },
      { key: 'k2', usage: usage(3, false, true) },
    ]);
    assert.equal(allLimited.key, 'k1');
    assert.match(allLimited.reason, /^all 2 window-limited; picked 1\/2/);
    // The window-limited count covers only REACHABLE keys, not failed probes.
    const mixed = pickCommandCodeAccessKey([{ key: 'k1', usage: usage(9, true) }, { key: 'k2' }]);
    assert.equal(mixed.key, 'k1');
    assert.match(mixed.reason, /^all 1 window-limited; picked 1\/2/);
    // Unreachable probes are excluded; all unreachable → first key (legacy behavior).
    assert.equal(
      pickCommandCodeAccessKey([{ key: 'k1' }, { key: 'k2', usage: usage(5) }]).key,
      'k2',
    );
    const none = pickCommandCodeAccessKey([{ key: 'k1' }, { key: 'k2' }]);
    assert.equal(none.key, 'k1');
    assert.match(none.reason, /probes unavailable; using first of 2/);
  });
});
