import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  appendEnvelope,
  isSafeId,
  listRuns,
  parseEnvelope,
  parseRunControl,
  readJournalLines,
  readRunStatus,
  writeRunStatus,
  type ObserverEnvelope,
  type RunControl,
} from './journal.ts';
import { VIEWER_HTML } from './viewer.ts';

// SSE comment ping; keeps idle viewer connections alive through proxies.
const HEARTBEAT_MS = 25_000;
// Ingest caps: one NDJSON frame, and one whole POST (a run's frame stream).
// Both fail closed (413) so an oversized/never-terminated line can't OOM. The
// per-line cap sits above the ACP frame budget (32MB) so a legitimate large
// frame passes; it only stops a line that never terminates.
const MAX_LINE_BYTES = 48 * 1024 * 1024;
const MAX_BODY_BYTES = 1024 * 1024 * 1024;

const port =
  Number(process.env.JBOT_GATEWAY_PORT) > 0 ? Number(process.env.JBOT_GATEWAY_PORT) : 8790;
const dataDir = process.env.JBOT_GATEWAY_DATA?.trim() || 'gateway-data';
const token = process.env.JBOT_GATEWAY_TOKEN?.trim() || '';
// No token = local mode: loopback bind only, no auth — JBOT_GATEWAY_HOST
// cannot override that. With a token the default is all interfaces; behind a
// local TLS proxy (deploy/observer), JBOT_GATEWAY_HOST=127.0.0.1 keeps token
// auth while making the proxy the only public door, firewall or not.
const host = token ? process.env.JBOT_GATEWAY_HOST?.trim() || '0.0.0.0' : '127.0.0.1';

const log = (msg: string): void => {
  console.log(`[jbot-gateway] ${msg}`);
};

const subscribers = new Map<string, Set<ServerResponse>>();
const journalKey = (runId: string, sessionId: string): string => `${runId}/${sessionId}`;

// Constant-time compare so the token (which also decides public exposure)
// can't be recovered by timing. Length is not secret; unequal lengths short out.
function tokenMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ') && tokenMatches(header.slice(7))) {
    return true;
  }
  // Query token is for EventSource/browser GETs only (they cannot set headers);
  // ingest (POST) must use the Authorization header so the token never lands in
  // access logs or proxy caches.
  if (req.method === 'GET') {
    const q = url.searchParams.get('token');
    if (q && tokenMatches(q)) return true;
  }
  return false;
}

// SSE writes must never throw: a subscriber can disconnect between the
// membership check and the write, and an unhandled error would crash the
// long-lived gateway. Fail open per subscriber.
function sseSend(res: ServerResponse, payload: string): void {
  try {
    res.write(payload);
  } catch {
    /* subscriber gone; cleanup runs on its close/error */
  }
}
function sseWrite(res: ServerResponse, line: string): void {
  sseSend(res, `data: ${line}\n\n`);
}

function fanOut(envelope: ObserverEnvelope, line: string): void {
  const subs = subscribers.get(journalKey(envelope.runId, envelope.sessionId));
  if (!subs) return;
  for (const res of subs) sseWrite(res, line);
}

// A run-status control targets no single session, so it reaches every viewer
// of any session in that run.
function fanRunControl(control: RunControl, line: string): void {
  const prefix = `${control.runId}/`;
  for (const [key, subs] of subscribers) {
    if (!key.startsWith(prefix)) continue;
    for (const res of subs) sseWrite(res, line);
  }
}

/** Store + fan one ingest line. Returns whether it was a recognized message. */
function acceptLine(line: string): boolean {
  const control = parseRunControl(line);
  if (control) {
    writeRunStatus(dataDir, control);
    fanRunControl(control, JSON.stringify(control));
    return true;
  }
  const envelope = parseEnvelope(line);
  if (!envelope) return false;
  appendEnvelope(dataDir, envelope);
  fanOut(envelope, JSON.stringify(envelope));
  return true;
}

async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Bounded NDJSON: one envelope per line, appended and fanned out as it
  // arrives so live viewers track an in-flight review. Byte-capped per line
  // and per body — ingest is a trust boundary, not a crash surface.
  let accepted = 0;
  let rejected = 0;
  let total = 0;
  // Carries only the current incomplete line. Newlines are searched within
  // each incoming chunk (never a re-scan of the whole buffer), so an
  // unterminated line stays O(total) instead of O(total²). partialBytes tracks
  // the line's ENCODED size so the cap stays byte-accurate for non-ASCII.
  let partial = '';
  let partialBytes = 0;
  let overflow = false;
  const take = (line: string): void => {
    if (!line.trim()) return;
    if (acceptLine(line)) accepted += 1;
    else rejected += 1;
  };
  req.setEncoding('utf8');
  for await (const chunk of req as AsyncIterable<string>) {
    total += Buffer.byteLength(chunk);
    if (total > MAX_BODY_BYTES) {
      overflow = true;
      break;
    }
    let start = chunk.indexOf('\n');
    if (start === -1) {
      partial += chunk;
      partialBytes += Buffer.byteLength(chunk);
      if (partialBytes > MAX_LINE_BYTES) {
        overflow = true;
        break;
      }
      continue;
    }
    take(partial + chunk.slice(0, start));
    let nl = chunk.indexOf('\n', start + 1);
    while (nl !== -1) {
      take(chunk.slice(start + 1, nl));
      start = nl;
      nl = chunk.indexOf('\n', start + 1);
    }
    partial = chunk.slice(start + 1);
    partialBytes = Buffer.byteLength(partial);
    if (partialBytes > MAX_LINE_BYTES) {
      overflow = true;
      break;
    }
  }
  if (overflow) {
    res.writeHead(413, { 'content-type': 'text/plain' });
    res.end('payload too large');
    req.destroy();
    return;
  }
  take(partial);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accepted, rejected }));
}

function handleStream(res: ServerResponse, runId: string, sessionId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  // Send the run status FIRST, so a viewer opening a finished run sees the
  // terminal verdict before the replayed frames and never flashes "reviewing".
  const status = readRunStatus(dataDir, runId);
  if (status) sseWrite(res, JSON.stringify({ v: 1, kind: 'run', runId, status, ts: Date.now() }));
  // Then replay the journal. Replay + subscribe is one synchronous block, so no
  // live frame slips through the gap; the viewer also de-dupes by seq, which
  // tolerates the EventSource auto-reconnect replay.
  for (const line of readJournalLines(dataDir, runId, sessionId)) sseWrite(res, line);
  const key = journalKey(runId, sessionId);
  let subs = subscribers.get(key);
  if (!subs) {
    subs = new Set();
    subscribers.set(key, subs);
  }
  subs.add(res);
  const heartbeat = setInterval(() => sseSend(res, ': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  // close and error can both fire; run once, and only drop the key if this is
  // still the set the map holds (a concurrent reconnect may have replaced it).
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    subs.delete(res);
    if (subs.size === 0 && subscribers.get(key) === subs) subscribers.delete(key);
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!authorized(req, url)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(VIEWER_HTML);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/runs') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(listRuns(dataDir)));
    return;
  }
  const stream = url.pathname.match(/^\/api\/runs\/([^/]+)\/sessions\/([^/]+)\/stream$/);
  if (req.method === 'GET' && stream) {
    const [, runId, sessionId] = stream;
    if (!isSafeId(runId) || !isSafeId(sessionId)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad id');
      return;
    }
    handleStream(res, runId, sessionId);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/ingest') {
    void handleIngest(req, res).catch(() => {
      // The socket may already be gone; nothing useful left to do.
      res.destroy();
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

const server = createServer((req, res) => {
  // The handlers do synchronous fs reads (journals, run status, listing); a
  // corrupt file or permission/disk error must return 500, never crash the
  // long-lived gateway out of the request listener.
  try {
    route(req, res);
  } catch (error) {
    log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  }
});

server.listen(port, host, () => {
  log(`listening on http://${host}:${port} (data: ${dataDir})`);
  log(
    token
      ? 'token auth enabled; ingest needs Authorization: Bearer, viewers ?token='
      : 'local mode: loopback only, no auth (set JBOT_GATEWAY_TOKEN to expose)',
  );
});
