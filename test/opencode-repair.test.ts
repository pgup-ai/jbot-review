import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { Semaphore, parsePortEnv, runReview } from '../src/shared/opencode.ts';
import type { OpencodeClient } from '@opencode-ai/sdk/v2';

const noLog = (): void => undefined;

interface FakeMessage {
  info: {
    role: 'assistant';
    id: string;
    parentID: string;
    time: { completed: number };
    structured?: unknown;
  };
  parts: Array<{ type: 'text'; text: string }>;
}

type FakeResponse =
  | string
  | string[]
  | null
  | { text?: string | string[] | null; structured?: unknown };

/**
 * Minimal fake of the opencode client surface runReview touches. Each
 * promptAsync call appends the next scripted assistant response, mimicking a
 * session that answers every prompt immediately. A null response scripts a
 * reasoning-only message with no text part.
 */
function makeFakeClient(
  responses: FakeResponse[],
  options: { emitMessageUpdated?: boolean; emitIdle?: boolean } = {},
): {
  client: OpencodeClient;
  prompts: string[];
  formats: unknown[];
} {
  const messages: FakeMessage[] = [];
  const prompts: string[] = [];
  const formats: unknown[] = [];
  const events: unknown[] = [];
  const waiters: Array<() => void> = [];

  const emit = (event: unknown) => {
    events.push(event);
    waiters.splice(0).forEach((resolve) => resolve());
  };

  const client = {
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          for (;;) {
            if (!events.length) await new Promise<void>((resolve) => waiters.push(resolve));
            while (events.length) yield events.shift();
          }
        })(),
      }),
    },
    session: {
      create: async () => ({ data: { id: 'session-1' } }),
      promptAsync: async (request: {
        messageID?: string;
        parts: Array<{ text: string }>;
        format?: unknown;
      }) => {
        prompts.push(request.parts[0].text);
        formats.push(request.format);
        // index access, not `??`: a scripted null means "no text part" and
        // must not fall back to '{}'.
        const index = prompts.length - 1;
        const id = request.messageID ?? `m${prompts.length}`;
        const scripted = index < responses.length ? responses[index] : '{}';
        const text = isStructuredResponse(scripted) ? scripted.text : scripted;
        const parts = Array.isArray(text)
          ? text.map((part) => ({ type: 'text' as const, text: part }))
          : text === null
            ? []
            : [{ type: 'text' as const, text }];
        const message = {
          info: {
            role: 'assistant' as const,
            id,
            parentID: id,
            time: { completed: 1 },
            ...(isStructuredResponse(scripted) ? { structured: scripted.structured } : {}),
          },
          parts,
        };
        messages.push(message);
        if (options.emitMessageUpdated !== false) {
          emit({
            type: 'message.updated',
            properties: {
              sessionID: 'session-1',
              info: message.info,
            },
          });
        }
        if (options.emitIdle) {
          emit({
            type: 'session.status',
            properties: { sessionID: 'session-1', status: { type: 'idle' } },
          });
        }
        return {};
      },
      message: async (request: { messageID: string }) => {
        const message = messages.find((item) => item.info.id === request.messageID);
        return message ? { data: message } : { error: { message: 'not found' } };
      },
      messages: async () => ({ data: [...messages] }),
      status: async () => ({ data: { 'session-1': { type: 'idle' } } }),
    },
  } as unknown as OpencodeClient;

  return { client, prompts, formats };
}

function isStructuredResponse(value: FakeResponse): value is {
  text?: string | string[] | null;
  structured?: unknown;
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    const { client, prompts, formats } = makeFakeClient([VALID_REVIEW]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal((formats[0] as { type?: unknown }).type, 'json_schema');
    assert.equal((formats[0] as { retryCount?: unknown }).retryCount, 1);
    assert.equal(result.summary, 'ok after repair');
  });

  it('requests native JSON schema output for initial and repair prompts', async () => {
    const { client, formats } = makeFakeClient(['garbage', VALID_REVIEW]);

    await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(formats.length, 2);
    for (const format of formats) {
      assert.equal((format as { type?: unknown }).type, 'json_schema');
      assert.equal((format as { retryCount?: unknown }).retryCount, 1);
      assert.deepEqual((format as { schema?: { required?: unknown } }).schema?.required, [
        'summary',
        'findings',
      ]);
    }
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

  it('uses native structured output when OpenCode stores it outside text parts', async () => {
    const { client, prompts } = makeFakeClient([
      { text: null, structured: JSON.parse(VALID_REVIEW) },
    ]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(result.summary, 'ok after repair');
    assert.equal(result.findings.length, 1);
  });

  it('fetches the assistant message on idle events even without message-updated completion', async () => {
    const { client, prompts } = makeFakeClient([VALID_REVIEW], {
      emitMessageUpdated: false,
      emitIdle: true,
    });

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
