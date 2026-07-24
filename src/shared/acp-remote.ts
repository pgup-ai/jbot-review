/**
 * Drives review sessions on an agent hosted by a remote companion, through the
 * ACP gateway, instead of spawning a CLI locally. The frames and the session
 * logic are identical — only the transport differs — so this supplies
 * `driveAcpSession` with a network-backed stream pair and reuses everything
 * above it. Spec: docs/superpowers/specs/2026-07-24-acp-gateway-m2-design.md.
 */
import { randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';

import { createAcpReviewBackend, driveAcpSession } from './acp.ts';
import type { AckControl } from '../gateway/relay.ts';
import { parseRelayControl } from '../gateway/relay.ts';
import type { ReviewBackend } from './session-concurrency.ts';

const REMOTE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const OPEN_TIMEOUT_MS = 60_000;

export interface RemoteAcpConfig {
  gateway: string;
  token: string;
  endpoint: string;
  agent: string;
  /** Groups this run's sessions in the gateway journal and viewer. */
  runId: string;
  /** Checked out by the companion so the agent can explore the code it reviews. */
  repo?: string;
  ref?: string;
}

/** Present only when all three required vars are set; the agent comes from the
 * selected provider, so no separate agent var. */
export function remoteAcpConfigFromEnv(): Omit<RemoteAcpConfig, 'agent'> | undefined {
  const gateway = process.env.JBOT_ACP_GATEWAY_URL?.trim();
  const token = process.env.JBOT_ACP_GATEWAY_TOKEN?.trim();
  const endpoint = process.env.JBOT_ACP_GATEWAY_ENDPOINT?.trim();
  if (!gateway || !token || !endpoint) return undefined;
  const rawRun =
    process.env.JBOT_ACP_GATEWAY_RUN?.trim() || process.env.JBOT_OBSERVER_RUN?.trim() || 'jbot';
  return {
    gateway: gateway.replace(/\/+$/, ''),
    token,
    endpoint,
    runId: rawRun.replaceAll(/[^A-Za-z0-9._-]/g, '-').slice(0, 128),
    ...(process.env.JBOT_ACP_GATEWAY_REPO?.trim()
      ? { repo: process.env.JBOT_ACP_GATEWAY_REPO.trim() }
      : {}),
    ...(process.env.JBOT_ACP_GATEWAY_REF?.trim()
      ? { ref: process.env.JBOT_ACP_GATEWAY_REF.trim() }
      : {}),
  };
}

/** Session ids double as journal filenames, so keep them id-safe and unique. */
const sessionIdFor = (label: string): string =>
  `${label.replaceAll(/[^A-Za-z0-9._-]/g, '-')}-${randomBytes(4).toString('hex')}`.slice(0, 128);

export function createRemoteAcpBackend(config: RemoteAcpConfig): ReviewBackend {
  return createAcpReviewBackend(`acp-gateway:${config.agent}@${config.endpoint}`, (...args) =>
    runRemotePrompt(config, ...args),
  );
}

async function runRemotePrompt(
  config: RemoteAcpConfig,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = REMOTE_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const sessionId = sessionIdFor(label);
  const base = `${config.gateway}/api/sessions/${sessionId}`;
  const auth = { authorization: `Bearer ${config.token}` };
  const output = new PassThrough();
  const stream = new AbortController();
  let seq = 0;

  const post = (payload: Record<string, unknown>): Promise<Response> =>
    fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/x-ndjson' },
      body: `${JSON.stringify(payload)}\n`,
    });
  const sendFrame = (frame: Record<string, unknown>): Promise<Response> =>
    post({
      v: 1,
      runId: config.runId,
      sessionId,
      seq: (seq += 1),
      ts: Date.now(),
      agent: config.agent,
      label,
      model,
      dir: 'out',
      frame,
    });

  const acked = deferred<AckControl>();
  const closed = deferred<never>();

  const sse = await fetch(`${base}/stream?token=${encodeURIComponent(config.token)}`, {
    signal: stream.signal,
  });
  if (!sse.ok || !sse.body) {
    await sse.body?.cancel();
    throw new Error(`${label}: gateway stream refused (${sse.status})`);
  }
  // Agent frames feed the session's stdin-equivalent; controls resolve the
  // open handshake or fail the prompt.
  const reading = pump(sse.body, (message) => {
    const control = parseRelayControl(JSON.stringify(message));
    if (control?.kind === 'opened' || control?.kind === 'refused') {
      acked.resolve(control);
    } else if (control?.kind === 'close') {
      closed.reject(
        new Error(`${label}: session closed by gateway: ${control.reason ?? 'closed'}`),
      );
    } else if (message.frame) {
      output.write(`${JSON.stringify(message.frame)}\n`);
    }
  });

  const input = new Writable({
    write(chunk, _encoding, callback) {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(chunk)) as Record<string, unknown>;
      } catch (error) {
        callback(error as Error);
        return;
      }
      sendFrame(frame).then(
        (res) =>
          callback(res.ok ? null : new Error(`${label}: gateway rejected a frame (${res.status})`)),
        callback,
      );
    },
  });

  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label}: remote prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`,
          ),
        ),
      timeoutMs,
    );
    timer.unref();
  });

  try {
    await post({
      kind: 'open',
      sessionId,
      runId: config.runId,
      endpoint: config.endpoint,
      agent: config.agent,
      model,
      ...(config.repo ? { repo: config.repo } : {}),
      ...(config.ref ? { ref: config.ref } : {}),
    });
    const ack = await Promise.race([acked.promise, closed.promise, withTimeout(OPEN_TIMEOUT_MS)]);
    if (ack.kind === 'refused') {
      throw new Error(
        `${label}: endpoint ${config.endpoint} refused: ${ack.reason ?? 'no reason'}`,
      );
    }
    log(`Calling ${label} prompt (agent=${config.agent}@${config.endpoint}, model=${model})`);

    const result = await Promise.race([
      driveAcpSession(
        { input, output },
        {
          cwd: ack.workspace ?? '.',
          prompt,
          agent: config.agent,
          label,
          log,
          model,
          ...(ack.modelCandidates ? { configOptionModelIds: ack.modelCandidates } : {}),
          ...(ack.requirePlanMode ? { requirePlanMode: true } : {}),
        },
      ),
      closed.promise,
      deadline,
    ]);
    log(
      `${label} prompt complete via gateway: stopReason=${result.stopReason} last-message=${result.text.length} chars`,
    );
    if (!result.text) {
      throw new Error(
        `${label}: agent produced no assistant message (stopReason=${result.stopReason})`,
      );
    }
    return result.text;
  } finally {
    await post({ kind: 'close', sessionId, reason: 'prompt complete' }).catch(() => {});
    stream.abort();
    output.end();
    await reading.catch(() => {});
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const withTimeout = (ms: number): Promise<never> =>
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out awaiting the gateway')), ms);
    timer.unref();
  });

/** Reads an SSE body, handing each `data:` payload to `onMessage`. */
async function pump(
  body: ReadableStream<Uint8Array>,
  onMessage: (message: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data: ')) {
        try {
          onMessage(JSON.parse(line.slice(6)) as Record<string, unknown>);
        } catch {
          /* heartbeat or partial payload */
        }
      }
      nl = buffer.indexOf('\n');
    }
  }
}
