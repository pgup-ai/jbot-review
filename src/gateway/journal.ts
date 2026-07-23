import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type RunStatus = 'reviewing' | 'completed' | 'failed';
const RUN_STATUSES: RunStatus[] = ['reviewing', 'completed', 'failed'];

/** Run-level lifecycle control (the jbot verdict), sent on the ingest stream
 * alongside frames but stored per-run, not per-session. */
export interface RunControl {
  v: 1;
  kind: 'run';
  runId: string;
  status: RunStatus;
  ts: number;
}

/**
 * One observed ACP frame, as sent by the jbot-side tee (or the demo feeder).
 * `dir` is the frame's direction on the original stdio pair: `out` =
 * client→agent, `in` = agent→client. The gateway treats `frame` opaquely —
 * rendering is the viewer's job, so protocol evolution never breaks ingest.
 */
export interface ObserverEnvelope {
  v: 1;
  runId: string;
  sessionId: string;
  seq: number;
  ts: number;
  agent: string;
  label: string;
  dir: 'out' | 'in';
  frame: Record<string, unknown>;
  /** jbot model string for this session (`<provider>/<id>`), for viewer meta. */
  model?: string;
}

// Run/session ids become file names; the allowlist is the path-traversal
// guard (leading alphanumeric also rules out "." / ".." / dotfiles).
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id);
}

/** Validates an ingest line just enough to store and replay it faithfully. */
export function parseEnvelope(line: string): ObserverEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const e = value as Record<string, unknown>;
  if (e.v !== 1) return undefined;
  if (!isSafeId(e.runId) || !isSafeId(e.sessionId)) return undefined;
  if (typeof e.seq !== 'number' || typeof e.ts !== 'number') return undefined;
  if (typeof e.agent !== 'string' || typeof e.label !== 'string') return undefined;
  if (e.dir !== 'out' && e.dir !== 'in') return undefined;
  if (typeof e.frame !== 'object' || e.frame === null) return undefined;
  return e as unknown as ObserverEnvelope;
}

export function journalPath(dataDir: string, runId: string, sessionId: string): string {
  return join(dataDir, runId, `${sessionId}.ndjson`);
}

/** Parse a run-status control line (distinct from a frame envelope). */
export function parseRunControl(line: string): RunControl | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const c = value as Record<string, unknown>;
  if (c.v !== 1 || c.kind !== 'run' || !isSafeId(c.runId)) return undefined;
  if (!RUN_STATUSES.includes(c.status as RunStatus) || typeof c.ts !== 'number') return undefined;
  return c as unknown as RunControl;
}

export function writeRunStatus(dataDir: string, control: RunControl): void {
  const dir = join(dataDir, control.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status'), control.status);
}

export function readRunStatus(dataDir: string, runId: string): RunStatus | undefined {
  const path = join(dataDir, runId, 'status');
  if (!existsSync(path)) return undefined;
  const value = readFileSync(path, 'utf8').trim();
  return RUN_STATUSES.includes(value as RunStatus) ? (value as RunStatus) : undefined;
}

export function appendEnvelope(dataDir: string, envelope: ObserverEnvelope): void {
  const dir = join(dataDir, envelope.runId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    journalPath(dataDir, envelope.runId, envelope.sessionId),
    `${JSON.stringify(envelope)}\n`,
  );
}

export interface RunSummary {
  runId: string;
  sessions: string[];
  updatedAt: number;
  status?: RunStatus;
}

/** Newest-first run listing from the plain directory layout — no index, no DB. */
export function listRuns(dataDir: string): RunSummary[] {
  if (!existsSync(dataDir)) return [];
  const runs: RunSummary[] = [];
  for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSafeId(entry.name)) continue;
    const runDir = join(dataDir, entry.name);
    const sessions: string[] = [];
    let updatedAt = 0;
    for (const file of readdirSync(runDir)) {
      if (!file.endsWith('.ndjson')) continue;
      const sessionId = file.slice(0, -'.ndjson'.length);
      if (!isSafeId(sessionId)) continue;
      sessions.push(sessionId);
      updatedAt = Math.max(updatedAt, statSync(join(runDir, file)).mtimeMs);
    }
    if (sessions.length > 0) {
      const status = readRunStatus(dataDir, entry.name);
      runs.push({
        runId: entry.name,
        sessions: sessions.sort(),
        updatedAt,
        ...(status ? { status } : {}),
      });
    }
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Journal replay as raw NDJSON lines (already-validated envelopes). */
export function readJournalLines(dataDir: string, runId: string, sessionId: string): string[] {
  const path = journalPath(dataDir, runId, sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}
