/**
 * Companion: dials OUT to the gateway (no listeners) and bridges local ACP
 * agent binaries — with the machine's own ambient auth — to relayed sessions.
 * Frames pass verbatim; the only local interception is the permission
 * deny-floor, enforced here independently of any client so a remote party can
 * never authorize writes on this machine.
 * Spec: docs/superpowers/specs/2026-07-24-acp-gateway-m2-design.md (M2a).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  codexAcpSpec,
  createNdjsonReader,
  cursorAcpSpec,
  devinAcpSpec,
  kiloAcpSpec,
  respondToPermissionRequest,
  type AcpAgentSpec,
} from '../shared/acp.ts';
import { codexAuthPath } from '../shared/codex.ts';
import { devinCredentialsPath } from '../shared/devin.ts';
import type { ObserverEnvelope } from '../gateway/journal.ts';
import type { HelloControl, OpenControl, RelayControl } from '../gateway/relay.ts';
import { parseRelayControl } from '../gateway/relay.ts';
import { terminateProcessTree } from '../shared/cli-process.ts';

const KILL_GRACE_MS = 2_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// Must-deliver buffer while the gateway is away; overflow fails sessions loud.
const MAX_OUTBOX_LINES = 10_000;

const gatewayUrl = (process.env.JBOT_COMPANION_GATEWAY ?? '').trim().replace(/\/+$/, '');
const token = (process.env.JBOT_COMPANION_TOKEN ?? '').trim();
const endpointId = (process.env.JBOT_COMPANION_ENDPOINT ?? '').trim();
const device = (process.env.JBOT_COMPANION_DEVICE ?? '').trim() || hostname();
const agentNames = (process.env.JBOT_COMPANION_AGENTS ?? 'kilo')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const maxSessions =
  Number(process.env.JBOT_COMPANION_MAX_SESSIONS) > 0
    ? Number(process.env.JBOT_COMPANION_MAX_SESSIONS)
    : 2;

const log = (msg: string): void => {
  console.log(`[jbot-companion] ${msg}`);
};

if (!gatewayUrl || !token || !endpointId) {
  console.error('Set JBOT_COMPANION_GATEWAY, JBOT_COMPANION_TOKEN, and JBOT_COMPANION_ENDPOINT.');
  process.exit(1);
}

/** Built-ins use the machine's ambient auth; `name=cmd arg…` entries add any
 * ACP binary (also the test seam). Returns an error string when auth is absent. */
function resolveAgent(entry: string): { name: string; spec: AcpAgentSpec } | string {
  const eq = entry.indexOf('=');
  if (eq !== -1) {
    const name = entry.slice(0, eq).trim();
    const [bin, ...args] = entry
      .slice(eq + 1)
      .trim()
      .split(/\s+/);
    if (!name || !bin) return `invalid custom agent entry: ${entry}`;
    return {
      name,
      spec: { id: name, bin, args: () => args, env: () => ({ env: { ...process.env } }) },
    };
  }
  switch (entry) {
    case 'kilo': {
      const path = join(homedir(), '.local', 'share', 'kilo', 'auth.json');
      if (!existsSync(path)) return `kilo: no auth at ${path} (run kilo login)`;
      return { name: entry, spec: kiloAcpSpec(readFileSync(path, 'utf8').trim()) };
    }
    case 'codex': {
      const home = join(homedir(), '.codex');
      if (!existsSync(codexAuthPath(home))) return `codex: no auth at ${codexAuthPath(home)}`;
      return { name: entry, spec: codexAcpSpec(home) };
    }
    case 'devin': {
      if (!existsSync(devinCredentialsPath(homedir())))
        return `devin: no credentials at ${devinCredentialsPath(homedir())}`;
      return { name: entry, spec: devinAcpSpec() };
    }
    case 'cursor': {
      const key = (process.env.CURSOR_API_KEY ?? '').trim();
      if (!key) return 'cursor: CURSOR_API_KEY not set';
      return { name: entry, spec: cursorAcpSpec(key) };
    }
    default:
      return `unknown agent: ${entry}`;
  }
}

const agents = new Map<string, AcpAgentSpec>();
for (const entry of agentNames) {
  const resolved = resolveAgent(entry);
  if (typeof resolved === 'string') log(`skipping agent — ${resolved}`);
  else agents.set(resolved.name, resolved.spec);
}
if (agents.size === 0) {
  console.error('No usable agents; check JBOT_COMPANION_AGENTS and local auth.');
  process.exit(1);
}

interface LiveSession {
  child: ChildProcess;
  runId: string;
  agent: string;
  model?: string;
  seq: number;
  workspace: string;
  cleanup?: () => void;
}

const sessions = new Map<string, LiveSession>();
const encoder = new TextEncoder();
let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
const outbox: string[] = [];

function sendLine(line: string): void {
  if (upstream) {
    try {
      upstream.enqueue(encoder.encode(`${line}\n`));
      return;
    } catch {
      upstream = undefined;
    }
  }
  outbox.push(line);
  if (outbox.length > MAX_OUTBOX_LINES) {
    log('outbox overflow; failing live sessions');
    outbox.length = 0;
    for (const sessionId of sessions.keys()) {
      endSession(sessionId, 'companion buffer overflow', true);
    }
  }
}

function sendControl(control: RelayControl): void {
  sendLine(JSON.stringify(control));
}

function hello(): HelloControl {
  return {
    kind: 'hello',
    endpoint: endpointId,
    device,
    agents: [...agents.keys()].map((agent) => ({ agent })),
    maxSessions,
  };
}

function endSession(sessionId: string, reason: string, notify: boolean): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  terminateProcessTree(session.child, KILL_GRACE_MS);
  session.cleanup?.();
  rmSync(session.workspace, { recursive: true, force: true });
  if (notify) sendControl({ kind: 'close', sessionId, reason });
  log(`session ${sessionId} ended: ${reason}`);
}

/** argv-only git (the ref is remote-controlled input); best-effort — a fetch
 * failure refuses the session rather than running the agent on nothing. */
function fetchWorkspace(workspace: string, repo: string, ref?: string): string | undefined {
  const run = (args: string[]): string | undefined => {
    const result = spawnSync('git', args, { encoding: 'utf8', timeout: 120_000 });
    return result.status === 0
      ? undefined
      : `git ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 300)}`;
  };
  // `--` so a repo/ref starting with `-` can never become a git flag.
  const clone = run(['clone', '--depth', '1', '--no-tags', '--', repo, workspace]);
  if (clone) return clone;
  if (!ref) return undefined;
  return (
    run(['-C', workspace, 'fetch', '--depth', '1', 'origin', '--', ref]) ??
    run(['-C', workspace, 'checkout', '--detach', 'FETCH_HEAD'])
  );
}

function openSession(control: OpenControl): void {
  const refuse = (reason: string): void => {
    sendControl({ kind: 'refused', sessionId: control.sessionId, reason });
    log(`refused ${control.sessionId}: ${reason}`);
  };
  if (sessions.size >= maxSessions) return refuse('at capacity');
  if (sessions.has(control.sessionId)) return refuse('session id in use');
  const spec = agents.get(control.agent);
  if (!spec) return refuse(`agent ${control.agent} not offered`);

  const model = control.model ?? 'default';
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-companion-'));
  if (control.repo) {
    const failure = fetchWorkspace(workspace, control.repo, control.ref);
    if (failure) {
      rmSync(workspace, { recursive: true, force: true });
      return refuse(failure);
    }
  }

  let env: NodeJS.ProcessEnv;
  let cleanup: (() => void) | undefined;
  try {
    ({ env, cleanup } = spec.env(model));
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    return refuse(`agent setup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const child = spawn(spec.bin, spec.args(model), { cwd: workspace, env, stdio: 'pipe' });
  const session: LiveSession = {
    child,
    runId: control.runId,
    agent: control.agent,
    ...(control.model ? { model: control.model } : {}),
    seq: 0,
    workspace,
    cleanup,
  };
  sessions.set(control.sessionId, session);

  const read = createNdjsonReader((frame) => {
    // Deny-floor: permission requests are answered HERE with the read-only
    // policy and never forwarded — a remote client cannot grant writes.
    if (frame.method === 'session/request_permission' && frame.id !== undefined) {
      const response = respondToPermissionRequest(
        (frame.params ?? {}) as Parameters<typeof respondToPermissionRequest>[0],
      );
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: response })}\n`);
      return;
    }
    const envelope: ObserverEnvelope = {
      v: 1,
      runId: session.runId,
      sessionId: control.sessionId,
      seq: (session.seq += 1),
      ts: Date.now(),
      agent: session.agent,
      label: session.agent,
      ...(session.model ? { model: session.model } : {}),
      dir: 'in',
      frame,
    };
    sendLine(JSON.stringify(envelope));
  });
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (!read(chunk)) endSession(control.sessionId, 'agent frame exceeded budget', true);
  });
  child.on('error', (error) =>
    endSession(control.sessionId, `spawn failed: ${error.message}`, true),
  );
  child.on('exit', (code) => {
    if (sessions.has(control.sessionId))
      endSession(control.sessionId, `agent exited ${code ?? 'by signal'}`, true);
  });
  sendControl({ kind: 'opened', sessionId: control.sessionId });
  log(`session ${control.sessionId} opened (agent=${control.agent})`);
}

function handleWireLine(line: string): void {
  const control = parseRelayControl(line);
  if (control) {
    if (control.kind === 'open') openSession(control);
    else if (control.kind === 'close')
      endSession(control.sessionId, control.reason ?? 'closed', false);
    return;
  }
  try {
    const envelope = JSON.parse(line) as ObserverEnvelope;
    if (envelope.dir !== 'out' || !envelope.sessionId || !envelope.frame) return;
    sessions.get(envelope.sessionId)?.child.stdin?.write(`${JSON.stringify(envelope.frame)}\n`);
  } catch {
    /* not a frame line */
  }
}

/** One connection epoch: SSE down + streaming NDJSON up. Resolves when the
 * downstream ends; live sessions survive into the next epoch. */
async function connectOnce(): Promise<void> {
  const headers = { authorization: `Bearer ${token}` };
  const down = await fetch(`${gatewayUrl}/api/endpoints/${endpointId}/stream`, { headers });
  if (down.status !== 200 || !down.body) throw new Error(`stream connect ${down.status}`);

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      upstream = controller;
    },
  });
  const up = fetch(`${gatewayUrl}/api/endpoints/${endpointId}/ingest`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit).catch(() => {
    upstream = undefined;
  });
  sendControl(hello());
  while (outbox.length > 0 && upstream) sendLine(outbox.shift()!);
  log(`attached to ${gatewayUrl} as ${endpointId} (${[...agents.keys()].join(', ')})`);

  const reader = down.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.startsWith('data: ')) handleWireLine(line.slice(6));
      nl = buffer.indexOf('\n');
    }
  }
  try {
    upstream?.close();
  } catch {
    /* already closed */
  }
  upstream = undefined;
  await up;
}

async function main(): Promise<void> {
  let backoff = BACKOFF_MIN_MS;
  for (;;) {
    try {
      await connectOnce();
      backoff = BACKOFF_MIN_MS;
      log('gateway stream ended; reconnecting');
    } catch (error) {
      log(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const sessionId of sessions.keys()) endSession(sessionId, 'companion shutdown', true);
    process.exit(0);
  });
}

await main();
