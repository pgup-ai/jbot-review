import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';

import {
  appendEnvelope,
  isSafeId,
  listRuns,
  parseEnvelope,
  readJournalLines,
  type ObserverEnvelope,
} from './journal.ts';
import { VIEWER_HTML } from './viewer.ts';

// SSE comment ping; keeps idle viewer connections alive through proxies.
const HEARTBEAT_MS = 25_000;

const port =
  Number(process.env.JBOT_GATEWAY_PORT) > 0 ? Number(process.env.JBOT_GATEWAY_PORT) : 8790;
const dataDir = process.env.JBOT_GATEWAY_DATA?.trim() || 'gateway-data';
const token = process.env.JBOT_GATEWAY_TOKEN?.trim() || '';
// No token = local mode: loopback bind only, no auth. A token flips the bind
// to all interfaces — the token IS the decision to be reachable.
const host = token ? '0.0.0.0' : '127.0.0.1';

const log = (msg: string): void => {
  console.log(`[jbot-gateway] ${msg}`);
};

const subscribers = new Map<string, Set<ServerResponse>>();
const journalKey = (runId: string, sessionId: string): string => `${runId}/${sessionId}`;

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!token) return true;
  if (req.headers.authorization === `Bearer ${token}`) return true;
  // EventSource cannot set headers, so viewers pass the token as a query param.
  return url.searchParams.get('token') === token;
}

function sseWrite(res: ServerResponse, line: string): void {
  res.write(`data: ${line}\n\n`);
}

function fanOut(envelope: ObserverEnvelope, line: string): void {
  const subs = subscribers.get(journalKey(envelope.runId, envelope.sessionId));
  if (!subs) return;
  for (const res of subs) sseWrite(res, line);
}

async function handleIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // NDJSON stream: one envelope per line, appended and fanned out as it
  // arrives, so live viewers track an in-flight review. Invalid lines are
  // counted and dropped — ingest is a trust boundary, not a crash surface.
  let accepted = 0;
  let rejected = 0;
  const lines = createInterface({ input: req });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const envelope = parseEnvelope(line);
    if (!envelope) {
      rejected += 1;
      continue;
    }
    appendEnvelope(dataDir, envelope);
    fanOut(envelope, JSON.stringify(envelope));
    accepted += 1;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ accepted, rejected }));
}

function handleStream(res: ServerResponse, runId: string, sessionId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  // Replay the journal first, then follow live; the viewer dedupes nothing —
  // replay and live are strictly ordered because appends happen before fanout.
  for (const line of readJournalLines(dataDir, runId, sessionId)) sseWrite(res, line);
  const key = journalKey(runId, sessionId);
  let subs = subscribers.get(key);
  if (!subs) {
    subs = new Set();
    subscribers.set(key, subs);
  }
  subs.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();
  const cleanup = (): void => {
    clearInterval(heartbeat);
    subs.delete(res);
    if (subs.size === 0) subscribers.delete(key);
  };
  res.on('close', cleanup);
  // An abrupt disconnect can surface as a stream 'error'; without a listener
  // that becomes an uncaught exception and takes the whole gateway down.
  res.on('error', cleanup);
}

const server = createServer((req, res) => {
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
    res.writeHead(200, { 'content-type': 'application/json' });
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
});

server.listen(port, host, () => {
  log(`listening on http://${host}:${port} (data: ${dataDir})`);
  log(
    token
      ? 'token auth enabled; ingest needs Authorization: Bearer, viewers ?token='
      : 'local mode: loopback only, no auth (set JBOT_GATEWAY_TOKEN to expose)',
  );
});
