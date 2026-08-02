import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { respondToPermissionRequest } from '@symma/protocol';

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

// An agent whose FIRST spawn answers `firstTurn` and later spawns answer with
// the review JSON, capturing the follow-up prompt. Sessions are one-shot
// processes, so cross-spawn state lives in a counter file.
const recoveringAgent = (name: string, firstTurn: string): { path: string; capture: string } => {
  const state = join(dir, `${name}.count`);
  const capture = join(dir, `${name}.prompt`);
  const path = script(
    `${name}.mjs`,
    `
import { readFileSync, writeFileSync } from 'node:fs';
let n = 0; try { n = Number(readFileSync(${JSON.stringify(state)}, 'utf8')); } catch {}
writeFileSync(${JSON.stringify(state)}, String(n + 1));
let buf = '';
process.stdin.setEncoding('utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const REVIEW = JSON.stringify({ summary: 'recovered', findings: [{ path: 'a.ts', line: 1, severity: 'P2', title: 'recovered finding', body: 'b' }], addressedPriorComments: [] });
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
      if (n === 0) {
        ${firstTurn}
      } else {
        writeFileSync(${JSON.stringify(capture)}, JSON.stringify(m.params));
        out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: REVIEW } } } });
        out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
      }
    } else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  }
});
`,
  );
  return { path, capture };
};

describe('acp review backend', () => {
  it('recovers a plan-then-stop turn with one continuation prompt', async () => {
    // The devin/glm failure mode: the model announces its plan, calls no
    // tools, and ends the turn. A reformat repair cannot help (there is
    // nothing to reformat); the recovery is a continuation instruction.
    const { path, capture } = recoveringAgent(
      'plan-then-json',
      `out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll investigate this PR thoroughly before producing the review." } } } });
       out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });`,
    );
    const result = await createAcpBackend(specFor(path), dir).runReview(
      'probe/default',
      'CTX',
      '',
      () => {},
      { label: 'review' },
    );
    assert.equal(result.summary, 'recovered');
    const followup = readFileSync(capture, 'utf8');
    assert.match(followup, /Previous attempt/);
    assert.match(followup, /I'll investigate/, 'the announcement is quoted back');
    assert.match(followup, /within this single turn/i);
  });

  it('diagnoses a model that ignores the continuation too, instead of a generic parse error', async () => {
    const alwaysPlans = script(
      'always-plans.mjs',
      `
let buf = '';
process.stdin.setEncoding('utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
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
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "I'll investigate first." } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    } else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  }
});
`,
    );
    await assert.rejects(
      createAcpBackend(specFor(alwaysPlans), dir).runReview('probe/default', 'CTX', '', () => {}, {
        label: 'review',
      }),
      /twice ended its turn without attempting/,
    );
  });

  it('recovers a turn that produced no assistant message at all', async () => {
    const { path } = recoveringAgent(
      'empty-then-json',
      `out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });`,
    );
    const findings = await createAcpBackend(specFor(path), dir).runGuidelineComplianceCheck(
      'probe/default',
      'CTX',
      'GUIDELINES',
      () => {},
    );
    // The finding proves the CONTINUATION spawn answered: a non-strict parse
    // of the empty first turn alone would yield [] and hide a broken recovery.
    assert.equal(findings.length, 1);
    assert.equal(findings[0].title, 'recovered finding');
  });

  it('treats an array-shaped reply as an attempt, not an abandoned turn', async () => {
    // '[]' is invalid for every parser (all demand an object) but it IS an
    // attempt: verification fails open to undefined with no follow-up session.
    const state = join(dir, 'array-reply.count');
    const arrayReply = script(
      'array-reply.mjs',
      `
import { readFileSync, writeFileSync } from 'node:fs';
let n = 0; try { n = Number(readFileSync(${JSON.stringify(state)}, 'utf8')); } catch {}
writeFileSync(${JSON.stringify(state)}, String(n + 1));
let buf = '';
process.stdin.setEncoding('utf8');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
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
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[]' } } } });
      out({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    } else out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  }
});
`,
    );
    const verdicts = await createAcpBackend(specFor(arrayReply), dir).runFindingVerification(
      'probe/default',
      'CTX',
      [{ path: 'a.ts', line: 1, severity: 'P1', title: 't', body: 'b' }],
      () => {},
    );
    assert.equal(verdicts, undefined, 'verification fails open on an unusable attempt');
    assert.equal(readFileSync(state, 'utf8'), '1', 'no continuation session was spawned');
  });

  it('reports the agent stderr when it dies before responding', async () => {
    // Pins the outcome, not which racer produces it: whatever wins, the
    // operator must see why the agent died. Without it the transport error can
    // surface alone and the reason — expired auth, missing binary — is lost.
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
    const frames: { dir: string; agent: string; label: string; model?: string }[] = [];
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
    // The call site passes agent, label and model positionally; transposing
    // them would still tee, just mislabelled.
    assert.deepEqual(
      [...new Set(frames.map((f) => `${f.agent}/${f.label}/${f.model ?? '-'}`))],
      ['probe/review/probe/default'],
    );
  });
});

// The floor is @symma/protocol's code, but the read-only guarantee is invariant
// #8 and it is jbot's to hold. The pin is exact, so this fails on the bump that
// loosens it rather than after the review that wrote to a repo.
describe('read-only permission floor', () => {
  it('answers permission requests read-only: mutations rejected, reads/exec allowed', () => {
    const options = [
      { optionId: 'aa', kind: 'allow_always' },
      { optionId: 'ao', kind: 'allow_once' },
      { optionId: 'ro', kind: 'reject_once' },
    ];
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'execute' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ao' },
    });
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'edit' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ro' },
    });
    // Hyphenated kinds (cursor) normalize; *_always is the same-direction fallback.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: { kind: 'delete' },
        options: [
          { optionId: 'ra', kind: 'reject-always' },
          { optionId: 'aa', kind: 'allow-always' },
        ],
      }),
      { outcome: { outcome: 'selected', optionId: 'ra' } },
    );
    // Missing kind defaults to allow — read tools commonly ship kind "other" or none.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: {},
        options: [{ optionId: 'ao', kind: 'allow_once' }],
      }),
      { outcome: { outcome: 'selected', optionId: 'ao' } },
    );
    // switch_mode is denied: jbot sets the session mode; approving one would
    // let a prompt-injected switch escape the plan-mode read-only layer.
    assert.deepEqual(respondToPermissionRequest({ toolCall: { kind: 'switch_mode' }, options }), {
      outcome: { outcome: 'selected', optionId: 'ro' },
    });
    // A denied tool with only allow options gets the cancelled outcome, never an allow.
    assert.deepEqual(
      respondToPermissionRequest({
        toolCall: { kind: 'edit' },
        options: [{ optionId: 'aa', kind: 'allow_always' }],
      }),
      { outcome: { outcome: 'cancelled' } },
    );
  });
});
