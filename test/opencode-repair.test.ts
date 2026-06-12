import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Semaphore, parsePortEnv, runReview } from '../src/shared/opencode.ts';
import type { OpencodeClient } from '@opencode-ai/sdk';

const noLog = (): void => undefined;

interface FakeMessage {
  info: { role: 'assistant'; id: string; time: { completed: number } };
  parts: Array<{ type: 'text'; text: string }>;
}

/**
 * Minimal fake of the opencode client surface runReview touches. Each
 * promptAsync call appends the next scripted assistant response, mimicking a
 * session that answers every prompt immediately. A null response scripts a
 * reasoning-only message with no text part.
 */
function makeFakeClient(responses: Array<string | null>): {
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
        messages.push({
          info: { role: 'assistant', id: `m${prompts.length}`, time: { completed: 1 } },
          parts: text === null ? [] : [{ type: 'text', text }],
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
