import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  Semaphore,
  buildConfig,
  extractPromptTokenUsage,
  formatTokenUsage,
  parsePortEnv,
  runAddressedPriorCommentsCheck,
  runGuidelineComplianceCheck,
  runReview,
} from '../src/shared/opencode.ts';
import type { OpencodeClient } from '@opencode-ai/sdk';

const noLog = (): void => undefined;

interface FakeMessage {
  info: {
    role: 'assistant';
    id: string;
    time: { completed: number };
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  parts: Array<{ type: 'text'; text: string }>;
}

/**
 * Minimal fake of the opencode client surface runReview touches. Each
 * promptAsync call appends the next scripted assistant response, mimicking a
 * session that answers every prompt immediately. A null response scripts a
 * reasoning-only message with no text part; an Error scripts a transport
 * failure (the promptAsync call rejects).
 */
function makeFakeClient(
  responses: Array<string | string[] | null | Error>,
  tokenUsages: FakeMessage['info']['tokens'][] = [],
): {
  client: OpencodeClient;
  prompts: string[];
} {
  const messages: FakeMessage[] = [];
  const prompts: string[] = [];

  const client = {
    session: {
      create: async () => ({ data: { id: 'session-1' } }),
      promptAsync: async (request: { body: { parts: Array<{ text: string }> } }) => {
        prompts.push(request.body.parts[0].text);
        // index access, not `??`: a scripted null means "no text part" and
        // must not fall back to '{}'.
        const index = prompts.length - 1;
        const text = index < responses.length ? responses[index] : '{}';
        if (text instanceof Error) throw text;
        const parts = Array.isArray(text)
          ? text.map((part) => ({ type: 'text' as const, text: part }))
          : text === null
            ? []
            : [{ type: 'text' as const, text }];
        messages.push({
          info: {
            role: 'assistant',
            id: `m${prompts.length}`,
            time: { completed: 1 },
            ...(tokenUsages[index] ? { tokens: tokenUsages[index] } : {}),
          },
          parts,
        });
        return {};
      },
      messages: async () => ({ data: [...messages] }),
      status: async () => ({ data: { 'session-1': { type: 'idle' } } }),
    },
  } as unknown as OpencodeClient;

  return { client, prompts };
}

const VALID_REVIEW = JSON.stringify({
  summary: 'ok after repair',
  findings: [{ path: 'src/a.ts', line: 3, severity: 'P2', title: 'T', body: 'B' }],
});

describe('runReview JSON repair loop', () => {
  it('repairs a malformed response with one same-session re-prompt', async () => {
    const { client, prompts } = makeFakeClient(['this is not json at all, sorry', VALID_REVIEW]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /could not be parsed as JSON/);
    assert.match(prompts[1], /Parse error:/);
    assert.equal(result.summary, 'ok after repair');
    assert.equal(result.findings.length, 1);
  });

  it('does not send a repair prompt when the first response parses', async () => {
    const { client, prompts } = makeFakeClient([VALID_REVIEW]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(result.summary, 'ok after repair');
  });

  it('records token usage for each completed prompt, including repair prompts', async () => {
    const { client } = makeFakeClient(
      ['broken', VALID_REVIEW],
      [
        { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
        { input: 6, output: 7 },
      ],
    );
    const usages: Array<{
      model: string;
      input: number;
      output: number;
      reasoning: number;
      cacheRead: number;
      cacheWrite: number;
    }> = [];

    await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog, {
      onTokenUsage: (usage, model) => usages.push({ model, ...usage }),
    });

    assert.deepEqual(usages, [
      { model: 'prov/model', input: 10, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      { model: 'prov/model', input: 6, output: 7, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    ]);
  });

  it('parses JSON from an earlier text part without repair', async () => {
    const { client, prompts } = makeFakeClient([
      [VALID_REVIEW, 'The review is complete. My findings are captured in the JSON above.'],
    ]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(result.summary, 'ok after repair');
    assert.equal(result.findings.length, 1);
  });

  it('treats a reasoning-only response (no text part) as repairable, not as zero findings', async () => {
    // Seen in production: a heavy reasoning model burned its budget and
    // finished with parts [step-start, reasoning, step-finish] — no text.
    // That must trigger the repair loop, never silently parse as "{}".
    const { client, prompts } = makeFakeClient([null, VALID_REVIEW]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /could not be parsed as JSON/);
    assert.equal(result.findings.length, 1);
  });

  it('fails the run when the repair response is also malformed', async () => {
    const { client, prompts } = makeFakeClient(['garbage one', 'garbage two']);

    await assert.rejects(
      () => runReview(client, 'prov/model', 'PR CONTEXT', '', noLog),
      /unparseable JSON/,
    );
    assert.equal(prompts.length, 2);
  });
});

const VALID_ADDRESSED = JSON.stringify({
  summary: '',
  findings: [],
  addressedPriorComments: [{ id: 'PRRT_abc', addressedByCommit: 'abc1234' }],
});

describe('runGuidelineComplianceCheck JSON repair loop', () => {
  it('repairs a malformed compliance response with one same-session re-prompt', async () => {
    const { client, prompts } = makeFakeClient(['prose, not json', VALID_REVIEW]);

    const findings = await runGuidelineComplianceCheck(
      client,
      'prov/model',
      'CTX',
      'guides',
      noLog,
    );

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /could not be parsed as JSON/);
    assert.equal(findings.length, 1);
  });

  it('fails open to zero findings when the repair re-prompt itself fails', async () => {
    const { client, prompts } = makeFakeClient(['prose', new Error('socket hang up')]);

    const findings = await runGuidelineComplianceCheck(
      client,
      'prov/model',
      'CTX',
      'guides',
      noLog,
    );

    assert.equal(prompts.length, 2);
    assert.deepEqual(findings, [], 'a repair transport failure must not escape the aux check');
  });

  it('fails open to zero findings when the repair response is also unparseable', async () => {
    const { client, prompts } = makeFakeClient(['prose one', 'prose two']);

    const findings = await runGuidelineComplianceCheck(
      client,
      'prov/model',
      'CTX',
      'guides',
      noLog,
    );

    assert.equal(prompts.length, 2, 'exactly one repair attempt before failing open');
    assert.deepEqual(findings, []);
  });
});

describe('runAddressedPriorCommentsCheck JSON repair loop', () => {
  it('repairs a malformed addressed-check response with one same-session re-prompt', async () => {
    const { client, prompts } = makeFakeClient(['prose, not json', VALID_ADDRESSED]);

    const addressed = await runAddressedPriorCommentsCheck(client, 'prov/model', 'CTX', noLog);

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /could not be parsed as JSON/);
    assert.deepEqual(addressed, [{ id: 'PRRT_abc', addressedByCommit: 'abc1234' }]);
  });

  it('does not send a repair prompt when the response parses', async () => {
    const { client, prompts } = makeFakeClient([VALID_ADDRESSED]);

    const addressed = await runAddressedPriorCommentsCheck(client, 'prov/model', 'CTX', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(addressed.length, 1);
  });

  it('fails open to no addressed comments when the repair response is also unparseable', async () => {
    const { client, prompts } = makeFakeClient(['prose one', 'prose two']);

    const addressed = await runAddressedPriorCommentsCheck(client, 'prov/model', 'CTX', noLog);

    assert.equal(prompts.length, 2, 'exactly one repair attempt before failing open');
    assert.deepEqual(addressed, []);
  });

  it('fails open to no addressed comments when the repair re-prompt itself fails', async () => {
    const { client, prompts } = makeFakeClient(['prose', new Error('socket hang up')]);

    const addressed = await runAddressedPriorCommentsCheck(client, 'prov/model', 'CTX', noLog);

    assert.equal(prompts.length, 2);
    assert.deepEqual(addressed, [], 'a repair transport failure must not escape the aux check');
  });
});

describe('Semaphore', () => {
  it('never exceeds the limit and wakes waiters in order', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => i).map(async (i) => {
        const release = await semaphore.acquire();
        active += 1;
        peak = Math.max(peak, active);
        order.push(i);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        release();
      }),
    );

    assert.equal(peak, 2);
    assert.equal(order.length, 6);
  });

  it('tolerates double release without freeing an extra slot', async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    first();
    first(); // double release must be a no-op

    const second = await semaphore.acquire();
    let thirdAcquired = false;
    const third = semaphore.acquire().then((release) => {
      thirdAcquired = true;
      release();
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(thirdAcquired, false); // limit 1 still enforced
    second();
    await third;
    assert.equal(thirdAcquired, true);
  });
});

describe('parsePortEnv', () => {
  const OLD_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it('rejects port 0 for fixed opencode listener configuration', () => {
    process.env.JBOT_OPENCODE_PORT = '0';

    assert.equal(parsePortEnv('JBOT_OPENCODE_PORT', 4096), 4096);
  });

  it('accepts valid fixed ports', () => {
    process.env.JBOT_OPENCODE_PORT = '4100';

    assert.equal(parsePortEnv('JBOT_OPENCODE_PORT', 4096), 4100);
  });
});

describe('buildConfig prompt caching', () => {
  function providerOptions(config: ReturnType<typeof buildConfig>) {
    return (config as { provider: Record<string, { options: Record<string, unknown> }> }).provider
      .openai.options;
  }

  it('enables setCacheKey by default', () => {
    const config = buildConfig('openai', 'gpt-5', 'key');
    assert.equal(providerOptions(config).setCacheKey, true);
    assert.equal(providerOptions(config).apiKey, 'key');
  });

  it('omits setCacheKey entirely when prompt caching is off', () => {
    // The off switch exists for providers that reject unknown option keys,
    // so disabled must send no key at all — not setCacheKey: false.
    const config = buildConfig('openai', 'gpt-5', 'key', undefined, false);
    assert.equal('setCacheKey' in providerOptions(config), false);
    assert.equal(providerOptions(config).apiKey, 'key');
  });

  it('keeps the read-only permission deny regardless of caching', () => {
    const config = buildConfig('openai', 'gpt-5', 'key', { reasoningEffort: 'high' }, true);
    const permission = (config as { permission: Record<string, string> }).permission;
    assert.equal(permission.edit, 'deny');
    assert.equal(permission.external_directory, 'deny');
  });

  it('embeds secondary provider keys for cross-provider aux models', () => {
    const config = buildConfig('openai', 'gpt-5', 'openai-key', undefined, true, [
      { providerID: 'openrouter', apiKey: 'openrouter-key' },
    ]);
    const providers = (config as { provider: Record<string, { options: Record<string, unknown> }> })
      .provider;

    assert.equal(providers.openai.options.apiKey, 'openai-key');
    assert.equal(providers.openrouter.options.apiKey, 'openrouter-key');
    assert.equal(providers.openrouter.options.setCacheKey, true);
  });

  it('omits setCacheKey for secondary providers that disable prompt caching', () => {
    const config = buildConfig('openai', 'gpt-5', 'openai-key', undefined, true, [
      { providerID: 'opencode-go', apiKey: 'opencode-key', promptCache: false },
    ]);
    const providers = (config as { provider: Record<string, { options: Record<string, unknown> }> })
      .provider;

    assert.equal(providers.openai.options.setCacheKey, true);
    assert.equal(providers['opencode-go'].options.apiKey, 'opencode-key');
    assert.equal('setCacheKey' in providers['opencode-go'].options, false);
  });
});

describe('formatTokenUsage', () => {
  it('summarizes input/output/reasoning/cache/cost', () => {
    const line = formatTokenUsage({
      cost: 0.0123,
      tokens: { input: 12000, output: 600, reasoning: 900, cache: { read: 11000, write: 1000 } },
    });

    assert.equal(
      line,
      'tokens: input=12000 output=600 reasoning=900 cache(read=11000 write=1000) cost=$0.0123',
    );
  });

  it('defaults missing counters to 0 and omits cost when absent', () => {
    assert.equal(
      formatTokenUsage({}),
      'tokens: input=0 output=0 reasoning=0 cache(read=0 write=0)',
    );
    assert.equal(
      formatTokenUsage({ tokens: { input: 5 } }),
      'tokens: input=5 output=0 reasoning=0 cache(read=0 write=0)',
    );
  });

  it('omits non-finite cost values from logs and usage records', () => {
    assert.equal(
      formatTokenUsage({ cost: Infinity, tokens: { input: 5 } }),
      'tokens: input=5 output=0 reasoning=0 cache(read=0 write=0)',
    );
    assert.deepEqual(extractPromptTokenUsage({ cost: Infinity, tokens: { input: 5 } }), {
      input: 5,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
