import { OpenCode, type OpenCodeClient } from '@opencode/client';

export interface FakeReply {
  /** Assistant text; omitted = reasoning-only turn. */
  text?: string;
  error?: string;
  /** Milliseconds before the turn completes (the wait call blocks this long). */
  delayMs?: number;
  /** Never complete until interrupted. */
  hang?: boolean;
  tools?: Array<{ name: string; input: Record<string, unknown>; output?: string }>;
}

export interface FakeSession {
  id: string;
  agent: string;
  model: unknown;
  permissions: unknown;
  environment?: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[];
  interrupted: number;
  /** Number of wait calls that were aborted by the client. */
  abortedWaits: number;
  forkedFrom?: string;
}

export interface FakeServer {
  client: OpenCodeClient;
  fetch: typeof fetch;
  sessions: Map<string, FakeSession>;
  /** `METHOD /path` in call order. */
  calls: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prompts: Array<{ sessionID: string; body: any }>;
  models: Array<{ providerID: string; id: string; variants?: Array<{ id: string }> }>;
  /** Push an event to every open `/api/event` subscriber. */
  emit(event: Record<string, unknown>): void;
}

let counter = 0;
const next = (prefix: string) => `${prefix}_${(++counter).toString().padStart(4, '0')}`;

/** A scripted V2 server behind `fetch`. `reply` decides each prompt's outcome. */
export function fakeOpencodeServer(
  reply: (session: FakeSession, text: string) => FakeReply,
  options: { models?: FakeServer['models'] } = {},
): FakeServer {
  const sessions = new Map<string, FakeSession>();
  const pending = new Map<string, { done: Promise<void>; finish: () => void }>();
  const subscribers = new Set<(chunk: string) => void>();
  const calls: string[] = [];
  const prompts: FakeServer['prompts'] = [];
  const models = options.models ?? [
    { providerID: 'openai', id: 'gpt-5', variants: [{ id: 'low' }, { id: 'jbot-verify' }] },
  ];

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const noContent = () => new Response(null, { status: 204 });

  const assistant = (session: FakeSession, r: FakeReply, completed: boolean) => ({
    id: next('msg'),
    type: 'assistant',
    agent: session.agent,
    model: session.model,
    time: { created: Date.now(), ...(completed ? { completed: Date.now() } : {}) },
    finish: r.error ? 'error' : 'stop',
    content: [
      ...(r.tools ?? []).map((t) => ({
        type: 'tool',
        id: next('tool'),
        name: t.name,
        state: {
          status: 'completed',
          input: t.input,
          content: [{ type: 'text', text: t.output ?? '' }],
        },
        time: { created: Date.now(), completed: Date.now() },
      })),
      ...(r.text === undefined
        ? [{ type: 'reasoning', text: 'thinking' }]
        : [{ type: 'text', text: r.text }]),
    ],
    tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
    cost: 0.001,
    ...(r.error ? { error: { message: r.error } } : {}),
  });

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const sid = /\/session\/(ses_[^/]+)/.exec(path)?.[1];
    const session = sid ? sessions.get(sid) : undefined;
    if (sid && !session) return json({ error: 'SessionNotFoundError' }, 404);

    if (method === 'GET' && path.endsWith('/api/model')) return json({ data: models });
    if (method === 'GET' && path.endsWith('/api/event')) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const push = (chunk: string) => controller.enqueue(encoder.encode(chunk));
          subscribers.add(push);
          push(': connected\n\n');
          init?.signal?.addEventListener('abort', () => {
            subscribers.delete(push);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    if (method === 'POST' && path.endsWith('/api/session')) {
      const created: FakeSession = {
        id: next('ses'),
        agent: body?.agent ?? 'build',
        model: body?.model,
        permissions: body?.permissions,
        messages: [],
        interrupted: 0,
        abortedWaits: 0,
      };
      sessions.set(created.id, created);
      return json({
        data: {
          id: created.id,
          agent: created.agent,
          model: created.model,
          title: body?.title,
          location: body?.location,
        },
      });
    }
    if (session && method === 'POST' && path.endsWith('/fork')) {
      const forked: FakeSession = {
        ...session,
        id: next('ses'),
        messages: [...session.messages],
        interrupted: 0,
        abortedWaits: 0,
        forkedFrom: session.id,
      };
      sessions.set(forked.id, forked);
      return json({ data: { id: forked.id, agent: forked.agent, model: forked.model } });
    }
    if (session && method === 'PUT' && path.endsWith('/environment')) {
      session.environment = body.variables;
      return noContent();
    }
    if (session && method === 'POST' && path.endsWith('/agent')) {
      session.agent = body.agent;
      return noContent();
    }
    if (session && method === 'POST' && path.endsWith('/model')) {
      session.model = body.model;
      return noContent();
    }
    if (session && method === 'POST' && path.endsWith('/prompt')) {
      prompts.push({ sessionID: session.id, body });
      session.messages.push({
        id: next('msg'),
        type: 'user',
        time: { created: Date.now() },
        content: [{ type: 'text', text: body.text }],
      });
      const r = reply(session, body.text);
      const draft = assistant(session, r, false);
      session.messages.push(draft);
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = () => {
          Object.assign(draft, assistant(session, r, true), { id: draft.id });
          resolve();
        };
      });
      pending.set(session.id, { done, finish });
      if (!r.hang) setTimeout(finish, r.delayMs ?? 0);
      return json({
        data: {
          id: next('inb'),
          sessionID: session.id,
          type: 'user',
          time: { created: Date.now() },
          payload: { text: body.text },
          delivery: 'queue',
        },
      });
    }
    if (session && method === 'POST' && path.endsWith('/wait')) {
      const p = pending.get(session.id);
      if (!p) return noContent();
      await new Promise<void>((resolve, reject) => {
        p.done.then(resolve);
        init?.signal?.addEventListener('abort', () => {
          session.abortedWaits += 1;
          reject(init.signal!.reason ?? new Error('aborted'));
        });
      });
      return noContent();
    }
    if (session && method === 'POST' && path.endsWith('/interrupt')) {
      session.interrupted += 1;
      const p = pending.get(session.id);
      if (p) p.finish();
      return json({ interrupted: Boolean(p) });
    }
    if (session && method === 'GET' && path.endsWith('/message')) {
      const type = url.searchParams.get('type');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      let data = session.messages.filter((m) => !type || m.type === type);
      if (url.searchParams.get('order') === 'desc') data = [...data].reverse();
      return json({ data: data.slice(0, limit), cursor: {} });
    }
    if (session && method === 'GET' && path.endsWith('/export')) {
      return json({
        data: { info: { id: session.id, agent: session.agent }, messages: session.messages },
      });
    }
    if (method === 'GET' && path.endsWith('/stats')) {
      return json({
        data: {
          sessions: sessions.size,
          prompts: prompts.length,
          steps: prompts.length,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: 0,
          tools: {},
        },
      });
    }
    if (method === 'GET' && path.endsWith('/plugin')) return json({ data: [] });
    if (/\/mcp\//.test(path)) return noContent();
    if (method === 'GET' && path.endsWith('/mcp')) return json({ data: [] });
    return json({ error: `unhandled ${method} ${path}` }, 404);
  };

  const client = OpenCode.make({
    baseUrl: 'http://fake.local',
    fetch: fakeFetch,
    headers: { authorization: 'Basic x' },
  });
  const emit = (event: Record<string, unknown>) => {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    for (const push of subscribers) push(chunk);
  };
  return { client, fetch: fakeFetch, sessions, calls, prompts, models, emit };
}
