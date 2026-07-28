import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { createAcpBackend } from '../src/shared/acp.ts';

const dir = mkdtempSync(join(tmpdir(), 'jbot-acp-backend-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const script = (name: string, body: string): string => {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
};

// Answers the ACP handshake and returns a review payload.
const AGENT = script(
  'agent.mjs',
  `
let buf = '';
process.stdin.setEncoding('utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const REVIEW = JSON.stringify({ summary: 'ok', findings: [], addressedPriorComments: [] });
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 's1' } });
    else if (m.method === 'session/prompt') {
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REVIEW } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    } else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  }
});
`,
);

const specFor = (path: string) =>
  ({
    id: 'probe',
    bin: process.execPath,
    args: () => [path],
    env: () => ({ env: { ...process.env } }),
  }) as never;

describe('acp review backend', () => {
  it('reports the agent stderr when it dies before responding', async () => {
    // The engine rejects on stdout end, which fires before the child's own
    // 'close' — so without the exit wait this surfaces as a bare transport
    // error and the reason (expired auth, missing binary) is lost.
    const crash = script(
      'crash.mjs',
      `process.stderr.write('probe: no auth\\n'); process.exit(3);`,
    );
    await assert.rejects(
      createAcpBackend(specFor(crash), dir).runReview('probe/default', 'CTX', '', () => {}, {
        label: 'review',
      }),
      /exited 3 before responding.*probe: no auth/s,
    );
  });

  it('tees frames to the observer', async () => {
    // observer.ts reads its config at import time, so the tee is exercised
    // through a child process rather than by mutating env here.
    const frames: { dir: string }[] = [];
    const ingest = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        for (const line of body.split('\n')) if (line.trim()) frames.push(JSON.parse(line));
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => ingest.listen(0, '127.0.0.1', resolve));
    const port = (ingest.address() as { port: number }).port;

    const driver = script(
      'driver.mjs',
      `
import { createAcpBackend } from '${join(process.cwd(), 'src/shared/acp.ts')}';
import { closeObserver } from '${join(process.cwd(), 'src/shared/observer.ts')}';
const spec = { id: 'probe', bin: process.execPath, args: () => ['${AGENT}'], env: () => ({ env: { ...process.env } }) };
await createAcpBackend(spec, '${dir}').runReview('probe/default', 'CTX', '', () => {}, { label: 'review' });
await closeObserver();
`,
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', driver], {
        env: {
          ...process.env,
          JBOT_OBSERVER_URL: `http://127.0.0.1:${port}`,
          JBOT_OBSERVER_RUN: 'tee-probe',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr?.on('data', (c) => (err += String(c)));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-600)))));
    });
    ingest.close();

    assert.ok(frames.length > 0, 'the local ACP path still tees to the observer');
    assert.ok(
      frames.some((f) => f.dir === 'out') && frames.some((f) => f.dir === 'in'),
      'both directions reach the journal',
    );
  });
});
