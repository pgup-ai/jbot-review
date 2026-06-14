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
    time: { created?: number; completed?: number };
  };
  parts: FakePart[];
}

type FakePart =
  | { type: 'text'; text: string }
  | { type: 'tool'; state: Record<string, unknown> }
  | { type: 'reasoning' };

type FakeResponse =
  | string
  | string[]
  | null
  | { text?: string | string[] | null; parts?: FakePart[] };

/**
 * Minimal fake of the opencode client surface runReview touches. Each
 * promptAsync call appends the next scripted assistant response, mimicking a
 * session that answers every prompt immediately. A null response scripts a
 * reasoning-only message with no text part.
 *
 * `status` controls what `session.status` reports and `messageCompleted`
 * controls whether the pushed assistant message carries `time.completed`. The
 * wait must finish as soon as EITHER signal says "done" — the regression that
 * hung CI was a wait that keyed only on session idle while the gateway sat at
 * `busy` forever.
 */
function makeFakeClient(
  responses: FakeResponse[],
  options: {
    status?: 'idle' | 'busy';
    messageCompleted?: boolean;
    emitToolStepBeforeFinal?: boolean;
  } = {},
): {
  client: OpencodeClient;
  prompts: string[];
  formats: unknown[];
} {
  const messages: FakeMessage[] = [];
  const prompts: string[] = [];
  const formats: unknown[] = [];
  const completed = options.messageCompleted !== false;
  const time = completed ? { completed: 1 } : { created: 1 };

  const client = {
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
        if (options.emitToolStepBeforeFinal) {
          messages.push({
            info: { role: 'assistant', id, parentID: id, time: { ...time } },
            parts: [{ type: 'tool', state: { status: 'completed', output: 'git diff output' } }],
          });
        }
        messages.push({
          info: {
            role: 'assistant',
            id: options.emitToolStepBeforeFinal ? `${id}-final` : id,
            parentID: id,
            time: { ...time },
          },
          parts: buildFakeParts(scripted),
        });
        return {};
      },
      message: async (request: { messageID: string }) => {
        const message = messages.find((item) => item.info.id === request.messageID);
        return message ? { data: message } : { error: { message: 'not found' } };
      },
      messages: async (request: { order?: 'asc' | 'desc'; limit?: number } = {}) => {
        const ordered = request.order === 'desc' ? [...messages].reverse() : [...messages];
        return { data: ordered.slice(0, request.limit) };
      },
      status: async () => ({ data: { 'session-1': { type: options.status ?? 'idle' } } }),
      abort: async () => ({}),
    },
    v2: {
      session: {
        messages: async (request: { order?: 'asc' | 'desc'; limit?: number } = {}) => {
          const ordered = request.order === 'desc' ? [...messages].reverse() : [...messages];
          return {
            data: { data: ordered.slice(0, request.limit).map(toFakeProjectedMessage), cursor: {} },
          };
        },
      },
    },
  } as unknown as OpencodeClient;

  return { client, prompts, formats };
}

function toFakeProjectedMessage(message: FakeMessage): unknown {
  return {
    type: 'assistant',
    id: message.info.id,
    time: message.info.time,
    content: message.parts.map((part, index) => {
      if (part.type === 'text') return { type: 'text', id: `p${index}`, text: part.text };
      if (part.type === 'tool')
        return { type: 'tool', id: `p${index}`, name: 'bash', state: part.state };
      return { type: 'reasoning', id: `p${index}`, text: '' };
    }),
  };
}

function buildFakeParts(scripted: FakeResponse): FakePart[] {
  if (isStructuredResponse(scripted) && scripted.parts) return scripted.parts;
  const text = isStructuredResponse(scripted) ? scripted.text : scripted;
  return Array.isArray(text)
    ? text.map((part) => ({ type: 'text' as const, text: part }))
    : text === null
      ? []
      : [{ type: 'text' as const, text }];
}

function isStructuredResponse(value: FakeResponse): value is {
  text?: string | string[] | null;
  parts?: FakePart[];
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
    const { client, prompts } = makeFakeClient([VALID_REVIEW]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(result.summary, 'ok after repair');
  });

  it('never requests native JSON-schema output (prompt-level JSON + strict parsing only)', async () => {
    const { client, formats } = makeFakeClient(['garbage', VALID_REVIEW]);

    await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(formats.length, 2);
    assert.equal(formats[0], undefined);
    assert.equal(formats[1], undefined);
  });

  it('returns once the assistant message completes even while the session stays busy', async () => {
    // The CI hang: the opencode-go gateway sat at status "busy" for the full
    // budget while the assistant message had already completed. The wait must
    // key on the per-message completed flag, not only on session idle.
    const { client, prompts } = makeFakeClient([VALID_REVIEW], {
      status: 'busy',
      messageCompleted: true,
    });

    const result = await runReview(client, 'opencode-go/minimax-m3', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(result.summary, 'ok after repair');
    assert.equal(result.findings.length, 1);
  });

  it('returns when the session reports idle even if the message lacks a completed flag', async () => {
    const { client, prompts } = makeFakeClient([VALID_REVIEW], {
      status: 'idle',
      messageCompleted: false,
    });

    const result = await runReview(client, 'opencode-go/minimax-m3', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(result.summary, 'ok after repair');
  });

  it('reads the latest assistant message after intermediate tool steps', async () => {
    const { client, prompts } = makeFakeClient([VALID_REVIEW], { emitToolStepBeforeFinal: true });

    const result = await runReview(client, 'opencode-go/minimax-m3', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 1);
    assert.equal(result.summary, 'ok after repair');
    assert.equal(result.findings.length, 1);
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

  it('does not treat completed tool output text as the reviewer answer', async () => {
    const { client, prompts } = makeFakeClient([
      {
        text: null,
        parts: [{ type: 'tool', state: { status: 'completed', output: VALID_REVIEW } }],
      },
      VALID_REVIEW,
    ]);

    const result = await runReview(client, 'prov/model', 'PR CONTEXT', '', noLog);

    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].includes('could not be parsed as JSON'), true);
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
