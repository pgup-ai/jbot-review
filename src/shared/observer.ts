/**
 * Optional, env-gated tee that copies ACP frames from a review session out to
 * an observer gateway (src/gateway) for live watching + durable journals.
 *
 * Enabled only when `JBOT_OBSERVER_URL` is set — otherwise every export here is
 * a no-op with zero overhead, so production reviews are untouched. Everything
 * is FAIL-OPEN: the tee never blocks, slows, or fails a review. Frames carry
 * prompt/diff content but never credentials (auth is materialized into
 * env/files and never crosses the ACP wire).
 */
const rawUrl = process.env.JBOT_OBSERVER_URL?.trim();
const token = process.env.JBOT_OBSERVER_TOKEN?.trim();
export const observerEnabled = Boolean(rawUrl);
const ingestUrl = rawUrl ? `${rawUrl.replace(/\/+$/, '')}/api/ingest` : '';
// One run per process; a review:local invocation or an Action run is one run.
const runId = observerEnabled
  ? process.env.JBOT_OBSERVER_RUN?.trim() ||
    `run-${new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)}`
  : '';

interface ObservedFrame {
  sessionId: string;
  seq: number;
  agent: string;
  label: string;
  model?: string;
  dir: 'out' | 'in';
  frame: Record<string, unknown>;
}

// One streaming POST for the whole process: the gateway demuxes by
// runId/sessionId, and a single ordered connection keeps each session's frames
// in order without any batching bookkeeping here.
const encoder = new TextEncoder();
let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
let sending: Promise<unknown> | undefined;
let dead = false;

function ensureStream(): void {
  if (sending || dead) return;
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c;
    },
  });
  sending = fetch(ingestUrl, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body,
    // Node's fetch requires half-duplex to be explicit for a streamed body.
    duplex: 'half',
  } as RequestInit).catch(() => {
    // Gateway unreachable: stop buffering so an offline gateway can't grow
    // memory. Observability is lost; the review is unaffected.
    dead = true;
    controller = undefined;
  });
}

/** Copy one frame to the gateway. No-op unless the observer is enabled. */
export function observeFrame(observed: ObservedFrame): void {
  if (!observerEnabled || dead) return;
  ensureStream();
  try {
    controller?.enqueue(
      encoder.encode(`${JSON.stringify({ v: 1, runId, ts: Date.now(), ...observed })}\n`),
    );
  } catch {
    // enqueue-after-close or any failure: drop the frame, never throw.
  }
}

let sessionCounter = 0;

/**
 * A per-session tee bound to a session id (`<label>-<n>`, unique across shards)
 * and a monotonic seq. Returns undefined when the observer is disabled, so the
 * hot path pays nothing.
 */
export function makeSessionTee(
  agent: string,
  label: string,
  model?: string,
): ((dir: 'out' | 'in', frame: Record<string, unknown>) => void) | undefined {
  if (!observerEnabled) return undefined;
  const sessionId = `${label}-${(sessionCounter += 1)}`;
  let seq = 0;
  return (dir, frame) =>
    observeFrame({ sessionId, seq: (seq += 1), agent, label, model, dir, frame });
}

/** Close the stream so the last buffered frames flush before the process exits. */
export async function closeObserver(timeoutMs = 2000): Promise<void> {
  if (!observerEnabled || !controller) return;
  try {
    controller.close();
  } catch {
    /* already closed */
  }
  controller = undefined;
  await Promise.race([sending, new Promise((resolve) => setTimeout(resolve, timeoutMs))]).catch(
    () => undefined,
  );
}

// Self-wire the tail flush: beforeExit fires when the loop drains (the review
// is done) and may run async work, so no entry point needs to know we exist.
if (observerEnabled) {
  let closed = false;
  process.once('beforeExit', () => {
    if (closed) return;
    closed = true;
    void closeObserver();
  });
}
