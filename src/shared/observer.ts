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

export type RunStatus = 'reviewing' | 'completed' | 'failed';

// A run = one process (a review:local invocation, an Action run). The name is
// resolved lazily so an entry point can set JBOT_OBSERVER_RUN (or setRunName)
// before the first frame; ids double as file/route components, hence the
// sanitizing. Default is a sortable timestamp.
let cachedRunId = '';
function runId(): string {
  if (!cachedRunId) {
    // A random suffix keeps the DEFAULT id process-unique so two runs started
    // the same second (or sharing nothing but the clock) never merge journals.
    const stamp = `run-${new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`;
    const raw = process.env.JBOT_OBSERVER_RUN?.trim() || stamp;
    // Cap to the gateway's SAFE_ID limit (128) so a long branch name doesn't
    // produce an id the gateway rejects (which would drop every frame).
    cachedRunId =
      raw
        .replaceAll(/[^A-Za-z0-9._-]/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, 128) || 'run';
  }
  return cachedRunId;
}

/** Name this run before it starts (entry points; slashes etc. are sanitized).
 * First name wins, so a specific caller (`local-<branch>`) beats a generic one. */
export function setRunName(name: string): void {
  if (observerEnabled && !cachedRunId && !process.env.JBOT_OBSERVER_RUN && name.trim()) {
    process.env.JBOT_OBSERVER_RUN = name.trim();
  }
}

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
// in order without any batching bookkeeping here. The stream's queue is bounded
// so a slow-but-connected gateway drops frames instead of growing the review's
// memory — fail-open observability, never review impact.
const OBSERVER_QUEUE_LIMIT = 2000;
const encoder = new TextEncoder();
let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
let sending: Promise<unknown> | undefined;
let dead = false;

function ensureStream(): void {
  if (sending || dead) return;
  const body = new ReadableStream<Uint8Array>(
    {
      start: (c) => {
        controller = c;
      },
    },
    new CountQueuingStrategy({ highWaterMark: OBSERVER_QUEUE_LIMIT }),
  );
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

function enqueueLine(payload: Record<string, unknown>): void {
  ensureStream();
  // Backpressure: once the queue is full (slow consumer), drop rather than
  // buffer without bound.
  if (!controller || (controller.desiredSize ?? 1) <= 0) return;
  try {
    controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
  } catch {
    // enqueue-after-close or any failure: drop it, never throw.
  }
}

/** Copy one frame to the gateway. No-op unless the observer is enabled. */
export function observeFrame(observed: ObservedFrame): void {
  if (!observerEnabled || dead) return;
  enqueueLine({ v: 1, runId: runId(), ts: Date.now(), ...observed });
}

/** Report the review run's terminal outcome (the jbot-level verdict), so the
 * viewer can show completed/failed authoritatively instead of guessing from
 * the last ACP frame. No-op unless enabled. */
export function reportRun(status: RunStatus): void {
  if (!observerEnabled || dead) return;
  enqueueLine({ v: 1, kind: 'run', runId: runId(), status, ts: Date.now() });
}

// Per-label ordinal: the first `review` is `review`, the next `review-2`, etc.
// — readable session ids that never collide across shards or retries.
const labelCounts = new Map<string, number>();

/**
 * A per-session tee bound to a session id and a monotonic seq. Returns
 * undefined when the observer is disabled, so the hot path pays nothing.
 */
export function makeSessionTee(
  agent: string,
  label: string,
  model?: string,
): ((dir: 'out' | 'in', frame: Record<string, unknown>) => void) | undefined {
  if (!observerEnabled) return undefined;
  const n = (labelCounts.get(label) ?? 0) + 1;
  labelCounts.set(label, n);
  const sessionId = n === 1 ? label : `${label}-${n}`;
  let seq = 0;
  return (dir, frame) =>
    observeFrame({ sessionId, seq: (seq += 1), agent, label, model, dir, frame });
}

// MUST be called at a completion point (see runPrReview / review:local): the
// streaming POST keeps the event loop alive, so `beforeExit` can't be relied on
// to flush — and without this close the process would hang after the review.
export async function closeObserver(timeoutMs = 2000): Promise<void> {
  if (!observerEnabled || !controller) return;
  try {
    controller.close();
  } catch {
    /* already closed */
  }
  controller = undefined;
  // sending and the timeout both only ever resolve, so no catch is needed.
  await Promise.race([sending, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
