import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { listRuns, readJournalLines, type ObserverEnvelope } from '../src/gateway/journal.ts';

// The observer reads its config at import time, so it is exercised end-to-end
// through a child process rather than by re-importing with mutated env.
const driverSource = (url: string): string => `
import { makeSessionTee, observeFrame, closeObserver } from '${join(process.cwd(), 'src/shared/observer.ts')}';
const tee = makeSessionTee('kilo', 'review');
if (!tee) throw new Error('tee should be enabled');
tee('out', { jsonrpc: '2.0', id: 1, method: 'session/prompt' });
tee('in', { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
tee('in', { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
await closeObserver();
void observeFrame; void '${url}';
`;

describe('observer tee', () => {
  it('is a no-op with zero overhead when JBOT_OBSERVER_URL is unset', async () => {
    const mod = await import(`../src/shared/observer.ts?nocfg=${Date.now()}`);
    assert.equal(mod.observerEnabled, false);
    assert.equal(mod.makeSessionTee('kilo', 'review'), undefined);
    // Disabled path must never throw or attempt any I/O.
    mod.observeFrame({
      sessionId: 'x-1',
      seq: 1,
      agent: 'kilo',
      label: 'review',
      dir: 'in',
      frame: {},
    });
    await mod.closeObserver();
  });

  it('streams real frames into a gateway that journals them', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jbot-obs-int-'));
    const port = 18500 + Math.floor(Math.random() * 1000);
    const base = `http://127.0.0.1:${port}`;
    let gateway: ChildProcess | undefined;
    try {
      gateway = spawn(process.execPath, ['--import', 'tsx', 'src/gateway/server.ts'], {
        env: { ...process.env, JBOT_GATEWAY_PORT: String(port), JBOT_GATEWAY_DATA: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('gateway did not start')), 15_000);
        gateway?.stdout?.on('data', (chunk: Buffer) => {
          if (String(chunk).includes('listening')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      // The tee runs in its own process (config is import-time) and streams to
      // the gateway, exactly as a real review does.
      await new Promise<void>((resolve, reject) => {
        const driver = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-'], {
          env: { ...process.env, JBOT_OBSERVER_URL: base, JBOT_OBSERVER_RUN: 'run-test' },
          stdio: ['pipe', 'ignore', 'inherit'],
        });
        driver.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`driver exited ${code}`)),
        );
        driver.stdin?.end(driverSource(base));
      });

      const runs = listRuns(dataDir);
      assert.equal(runs.length, 1);
      assert.equal(runs[0].runId, 'run-test');
      assert.deepEqual(runs[0].sessions, ['review']);
      const frames = readJournalLines(dataDir, 'run-test', 'review').map(
        (line) => JSON.parse(line) as ObserverEnvelope,
      );
      assert.equal(frames.length, 3);
      // Order and direction preserved end to end.
      assert.deepEqual(
        frames.map((f) => [f.dir, f.seq]),
        [
          ['out', 1],
          ['in', 2],
          ['in', 3],
        ],
      );
      assert.equal(
        frames[2].frame.result && (frames[2].frame.result as { stopReason: string }).stopReason,
        'end_turn',
      );
    } finally {
      gateway?.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
