import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { checkGatewayEndpointReady as checkEndpointReady } from '../src/shared/acp-remote.ts';
import {
  createRemoteAcpBackend,
  gatewaySessionCap,
  gatewayRoutedModels,
  localRunId,
  remoteAcpConfigFromEnv,
} from '../src/shared/acp-remote.ts';
import { readJournalLines } from '../src/gateway/journal.ts';

describe('gatewaySessionCap', () => {
  it('caps configured concurrency and rejects an endpoint with no capacity', () => {
    assert.equal(gatewaySessionCap(0, 2), 2);
    assert.equal(gatewaySessionCap(3, 2), 2);
    assert.equal(gatewaySessionCap(1, 2), 1);
    assert.throws(() => gatewaySessionCap(3, 0), /no free session capacity/);
  });
});

// Answers the ACP handshake and returns a review payload, so the backend is
// exercised over the real gateway + companion rather than a stub transport.
const REVIEW_AGENT = `
let buf = '';
process.stdin.setEncoding('utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const REVIEW = JSON.stringify({
  summary: 'remote review ok',
  findings: [{ path: 'src/a.ts', line: 1, severity: 'P2', title: 'remote finding', body: 'b' }],
  addressedPriorComments: [],
});
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    if (m.method === 'session/new') out({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'a1' } });
    else if (m.method === 'session/prompt') {
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'a1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REVIEW } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    } else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  }
});
`;

async function waitFor<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('remote acp backend', () => {
  it('uses the gateway URL as the remote-routing switch', () => {
    const saved = { ...process.env };
    try {
      delete process.env.JBOT_ACP_GATEWAY_URL;
      assert.equal(remoteAcpConfigFromEnv(), undefined);
      process.env.JBOT_ACP_GATEWAY_URL = 'https://gw.example/';
      assert.throws(
        () => remoteAcpConfigFromEnv(),
        /also set JBOT_ACP_GATEWAY_TOKEN and JBOT_ACP_GATEWAY_ENDPOINT/,
      );
      process.env.JBOT_ACP_GATEWAY_TOKEN = 't';
      process.env.JBOT_ACP_GATEWAY_ENDPOINT = 'laptop';
      process.env.JBOT_ACP_GATEWAY_RUN = 'pr/42 run';
      const config = remoteAcpConfigFromEnv();
      assert.equal(config?.gateway, 'https://gw.example', 'trailing slash trimmed');
      assert.equal(config?.runId, 'pr-42-run', 'run id sanitized for journal paths');
    } finally {
      process.env = saved;
    }
  });

  it('runs a review through gateway + companion and journals the session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jbot-remote-'));
    const agentPath = join(dataDir, 'review-agent.mjs');
    writeFileSync(agentPath, REVIEW_AGENT);
    const port = 24000 + Math.floor(Math.random() * 2000);
    const base = `http://127.0.0.1:${port}`;
    let gateway: ChildProcess | undefined;
    let companion: ChildProcess | undefined;
    try {
      gateway = spawn(process.execPath, ['--import', 'tsx', 'src/gateway/server.ts'], {
        env: {
          ...process.env,
          JBOT_GATEWAY_PORT: String(port),
          JBOT_GATEWAY_DATA: dataDir,
          JBOT_GATEWAY_TOKEN: 'client-tok',
          JBOT_GATEWAY_HOST: '127.0.0.1',
          JBOT_GATEWAY_ENDPOINTS: 'box:endpoint-tok',
        },
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
      companion = spawn(process.execPath, ['--import', 'tsx', 'src/companion/index.ts'], {
        env: {
          ...process.env,
          JBOT_COMPANION_GATEWAY: base,
          JBOT_COMPANION_TOKEN: 'endpoint-tok',
          JBOT_COMPANION_ENDPOINT: 'box',
          JBOT_COMPANION_AGENTS: `probe=${process.execPath} ${agentPath}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await waitFor(async () => {
        const listed = (await (
          await fetch(`${base}/api/endpoints`, { headers: { authorization: 'Bearer client-tok' } })
        ).json()) as { endpoint: string; online: boolean }[];
        return listed.find((entry) => entry.endpoint === 'box' && entry.online);
      }, 'endpoint presence');

      // Preflight: ready for the offered agent, loud for anything it can't serve.
      const config = { gateway: base, token: 'client-tok', endpoint: 'box', runId: 'run-remote' };
      assert.equal((await checkEndpointReady(config, 'probe')).freeSessions, 2, 'idle: all free');
      await assert.rejects(() => checkEndpointReady(config, 'kilo'), /does not offer agent "kilo"/);
      await assert.rejects(
        () => checkEndpointReady({ ...config, endpoint: 'ghost' }, 'probe'),
        /is offline/,
      );
      await assert.rejects(
        () => checkEndpointReady({ ...config, token: 'wrong' }, 'probe'),
        /rejected the endpoint listing.*JBOT_ACP_GATEWAY_TOKEN/s,
      );

      const backend = createRemoteAcpBackend({
        gateway: base,
        token: 'client-tok',
        endpoint: 'box',
        agent: 'probe',
        runId: 'run-remote',
      });
      assert.equal(backend.name, 'acp-gateway:probe@box');
      const result = await backend.runReview('probe/default', 'PR CONTEXT', '', () => {}, {
        label: 'review',
      });
      assert.equal(result.summary, 'remote review ok');
      assert.equal(result.findings[0]?.title, 'remote finding');

      // The prompt reached the agent and the reply came back over the relay,
      // both directions journaled under the client's run id.
      const runDir = (await (await fetch(`${base}/api/runs?token=client-tok`)).json()) as {
        runId: string;
        sessions: string[];
      }[];
      const run = runDir.find((entry) => entry.runId === 'run-remote');
      assert.ok(run && run.sessions.length === 1, 'one journaled session for the prompt');
      const lines = readJournalLines(dataDir, 'run-remote', run!.sessions[0]).map(
        (line) => JSON.parse(line) as { dir: string; frame: { method?: string } },
      );
      assert.ok(lines.some((l) => l.dir === 'out' && l.frame.method === 'session/prompt'));
      assert.ok(lines.some((l) => l.dir === 'in'));
    } finally {
      companion?.kill('SIGKILL');
      gateway?.kill('SIGKILL');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('gatewayRoutedModels', () => {
  it('is true only when a model resolves to a provider the gateway serves', () => {
    assert.equal(gatewayRoutedModels(['devin/glm-5.2', undefined]), true);
    // Aux alone is enough: the runner routes either role.
    assert.equal(gatewayRoutedModels(['opencode/grok-code', 'kilo/kilo-auto']), true);
    // Configured-but-unrouted — local review must keep reviewing the worktree.
    assert.equal(gatewayRoutedModels(['opencode/grok-code', undefined]), false);
    assert.equal(gatewayRoutedModels([undefined, undefined]), false);
  });
});

describe('localRunId', () => {
  const when = new Date('2026-07-27T01:00:29.123Z');

  it('keeps the timestamp whatever the branch costs', () => {
    assert.equal(localRunId('main', when), 'local-main-20260727-010029-123');

    // The clamp truncates the tail, so a long branch must yield first — losing
    // the stamp would merge every attempt on that branch into one entry again.
    const long = localRunId('b'.repeat(400), when);
    // Derived, not literal: this pins that the suffix survives, which is the
    // invariant — the exact format is asserted once above.
    const stamp = localRunId('x', when).slice('local-x'.length);
    assert.ok(long.endsWith(stamp), 'stamp survives a long branch');
    assert.ok(long.length <= 128, 'stays inside the clamp');

    // Attempts stay distinct a second apart and within the same second.
    assert.notEqual(localRunId('main', when), localRunId('main', new Date('2026-07-27T01:00:30Z')));
    assert.notEqual(
      localRunId('main', when),
      localRunId('main', new Date('2026-07-27T01:00:29.124Z')),
    );
  });
});
