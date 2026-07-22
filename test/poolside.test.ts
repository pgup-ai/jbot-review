import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertPoolsideApiKey,
  isPoolsideProvider,
  mapPoolsideUsage,
  poolsideReasoningEffort,
  runPoolsideReview,
} from '../src/shared/poolside.ts';

const noop = () => {};

function streamResponse(content: string | string[], usage?: Record<string, unknown>): Response {
  const chunks = Array.isArray(content) ? content : [content];
  const events = [
    ...chunks.map((chunk) => ({ choices: [{ delta: { content: chunk } }] })),
    ...(usage ? [{ choices: [], usage }] : []),
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('Poolside API backend', () => {
  it('recognizes the provider and defaults to no hidden reasoning', () => {
    assert.equal(isPoolsideProvider('poolside'), true);
    assert.equal(isPoolsideProvider('Poolside'), false);
    assert.equal(assertPoolsideApiKey('  sky_test  '), 'sky_test');
    assert.throws(() => assertPoolsideApiKey('  '), /Missing Poolside API key/);
    assert.equal(poolsideReasoningEffort(), 'none');
    assert.equal(poolsideReasoningEffort({ reasoningEffort: 'medium' }), 'medium');
    assert.equal(poolsideReasoningEffort({ reasoningEffort: '  ' }), 'none');
  });

  it('maps OpenAI-compatible usage without double-counting reasoning', () => {
    assert.deepEqual(
      mapPoolsideUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 40 },
      }),
      {
        input: 100,
        output: 10,
        reasoning: 40,
        cacheRead: 20,
        cacheWrite: 0,
      },
    );
    assert.equal(mapPoolsideUsage(undefined), undefined);
  });

  it('sends one full-budget chat completion and records usage', async () => {
    const originalFetch = globalThis.fetch;
    let request: RequestInit | undefined;
    let usage: unknown;
    globalThis.fetch = async (_input, init) => {
      request = init;
      return streamResponse(['{"summary":"clean",', '"findings":[]}'], {
        prompt_tokens: 12,
        completion_tokens: 4,
      });
    };
    try {
      const result = await runPoolsideReview(
        'sky_test',
        'none',
        'poolside/laguna-s-2.1',
        'complete diff',
        '',
        noop,
        {
          onTokenUsage: (value, model, label) => {
            usage = { value, model, label };
          },
        },
      );
      assert.equal(result.summary, 'clean');
      assert.deepEqual(result.findings, []);
      assert.ok(request);
      assert.equal(request.method, 'POST');
      assert.equal((request.headers as Record<string, string>).authorization, 'Bearer sky_test');
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      assert.equal(body.model, 'poolside/laguna-s-2.1');
      assert.equal(body.max_completion_tokens, 32_768);
      assert.deepEqual(body.reasoning, { effort: 'none' });
      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
      assert.match(
        (body.messages as Array<{ content: string }>)[0]?.content ?? '',
        /^## Tool use disabled\n\nUse no tools for this review/,
      );
      assert.deepEqual(usage, {
        value: {
          input: 12,
          output: 4,
          reasoning: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        model: 'poolside/laguna-s-2.1',
        label: 'review',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('makes only one bounded repair request after malformed output', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return streamResponse(calls === 1 ? 'not json' : '{"summary":"repaired","findings":[]}');
    };
    try {
      const result = await runPoolsideReview(
        'sky_test',
        'none',
        'poolside/laguna-s-2.1',
        'complete diff',
        '',
        noop,
      );
      assert.equal(result.summary, 'repaired');
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
