import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { JevVerifierShadow, observeVerifierPacket } from '../src/shared/jev-verifier-shadow.ts';
import { requestFindingVerdicts } from '../src/shared/runner.ts';
import { runFindingVerification, runReview } from '../src/shared/opencode.ts';
import { fakeOpencodeServer, fakeRuntime } from './support/opencode-fake.ts';
import { JEV_MODEL } from '../src/shared/prompt.ts';
import type { Finding } from '../src/shared/types.ts';

const targets: Finding[] = ['a.ts', 'b.ts'].map((path) => ({
  path,
  line: 1,
  title: 'Check condition',
  body: 'Verify the outcome',
  severity: 'P2',
}));

it('scores only the dispatched first packet and joins each score to the validated recheck decision', async (t) => {
  const rows: string[] = [];
  const shadow = new JevVerifierShadow('test-only', (s) => rows.push(s));
  let submitted = '';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    submitted = request.state.packet;
    assert.deepEqual(Object.keys(request.questions), ['f0', 'f1']);
    return Response.json({
      model: JEV_MODEL,
      answers: { f0: { type: 'noul', noul: 0.5 }, f1: { type: 'noul', noul: 0.49 } },
    });
  });
  const fake = fakeOpencodeServer((session) => ({
    text: JSON.stringify({
      verdicts:
        session.agent === 'jbot-closed-book'
          ? [
              { index: 0, verdict: 'confirmed', reason: 'source evidence' },
              { index: 1, verdict: 'uncertain', reason: 'lookup' },
            ]
          : [{ index: 0, verdict: 'refuted', reason: 'guard' }],
    }),
  }));
  const runtime = fakeRuntime(fake);
  const model = 'openai/gpt-5';
  const result = await requestFindingVerdicts({
    jevShadow: shadow,
    targets,
    workspace: '/unused',
    model,
    prContext: 'private-source-fixture',
    sourceContext: async () => '',
    toolLessFirst: true,
    log: () => {},
    backend: { runFindingVerification: (...args) => runFindingVerification(runtime, ...args) },
  });
  await setImmediate();
  assert.deepEqual(
    result.map((r) => r.verdict),
    ['confirmed', 'refuted'],
  );
  assert.equal(fake.prompts.length, 2);
  assert.equal(submitted, fake.prompts[0].body.text);
  assert.equal(rows.length, 2);
  const [a, b] = rows.map((s) => JSON.parse(s.slice(s.indexOf('{'))));
  assert.equal(a.batchId, b.batchId);
  assert.deepEqual(
    [a.model, a.sufficient, a.neededSecondPass, a.secondPassMs],
    [model, true, false, null],
  );
  assert.deepEqual(
    [b.model, b.sufficient, b.neededSecondPass, b.secondPassModel],
    [model, false, true, model],
  );
  assert.ok(b.firstPassMs >= 0 && b.secondPassMs >= 0 && b.jevMs >= 0);
  assert.ok(rows.every((s) => !s.includes('private-source-fixture') && !s.includes('test-only')));
});

it('isolates parallel model packets and reports single-pass outcomes when scoring fails', async (t) => {
  const requests: string[] = [];
  const rows: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).state.packet);
    return new Response(null, { status: 503 });
  });
  const shadow = new JevVerifierShadow('test-only', (s) => rows.push(s));
  await Promise.all(
    ['cli/a', 'acp/b'].map((model) =>
      requestFindingVerdicts({
        targets: targets.slice(0, 1),
        workspace: '/unused',
        jevShadow: shadow,
        model,
        prContext: 'ctx',
        sourceContext: async () => '',
        log: () => {},
        backend: {
          async runFindingVerification() {
            await Promise.resolve();
            observeVerifierPacket('finding-verification', model, model + ' final packet');
            observeVerifierPacket('finding-verification-repair', model, 'repair');
            return [{ index: 0, verdict: 'refuted' }];
          },
        },
      }),
    ),
  );
  await setImmediate();
  assert.deepEqual(requests.sort(), ['acp/b final packet', 'cli/a final packet']);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const r = JSON.parse(row.slice(row.indexOf('{')));
    assert.deepEqual([r.status, r.score, r.neededSecondPass], ['http-503', null, null]);
  }
});

it('returns the verifier verdict while Jev is stalled and cancels the request on shutdown', async (t) => {
  let signal: AbortSignal | undefined;
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
    signal = init.signal!;
    return new Promise<Response>((_, reject) =>
      signal!.addEventListener('abort', () => reject(signal!.reason)),
    );
  });
  const rows: string[] = [];
  const shadow = new JevVerifierShadow('test-only', (row) => rows.push(row));
  const verdicts = await requestFindingVerdicts({
    targets: targets.slice(0, 1),
    workspace: '/unused',
    jevShadow: shadow,
    model: 'test',
    prContext: 'ctx',
    sourceContext: async () => '',
    log: () => {},
    backend: {
      async runFindingVerification() {
        observeVerifierPacket('finding-verification', 'test', 'packet');
        return [{ index: 0, verdict: 'confirmed' }];
      },
    },
  });
  assert.equal(verdicts[0].verdict, 'confirmed');
  assert.equal(signal?.aborted, false);
  assert.equal(rows.length, 0);
  shadow.stop();
  assert.equal(signal?.aborted, true);
  await setImmediate();
  assert.match(rows[0], /"status":"cancelled"/);
});

it('distinguishes provider token limits, the local byte cap and undispatched rechecks', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: { error_type: 'max_tokens_exceeded' } }, { status: 400 }),
  );
  const rows: string[] = [];
  const shadow = new JevVerifierShadow('test-only', (row) => rows.push(row));
  const pass = { model: 'test', elapsedMs: 0 };
  await shadow.record(targets, { ...pass, prompt: 'provider token-limit fixture' }, pass, [
    targets[1],
  ]);
  await shadow.record(targets.slice(0, 1), { ...pass, prompt: 'a'.repeat(512 * 1024) }, pass);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(
    rows.map((row) => {
      const r = JSON.parse(row.slice(row.indexOf('{')));
      return [r.status, r.neededSecondPass, r.secondPassModel, r.secondPassMs];
    }),
    [
      ['oversize', false, null, null],
      ['oversize', null, null, null],
      ['oversize', null, null, null],
    ],
  );
});

it('excludes forked OpenCode packets and leaves rejected submissions unobserved', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('unexpected Jev request');
  });
  let rejectPrompt = false;
  const fake = fakeOpencodeServer((session) =>
    session.forkedFrom
      ? {
          rejectPrompt,
          text: '{"verdicts":[{"index":0,"verdict":"confirmed","reason":"inherited evidence"}]}',
        }
      : { text: '{"findings":[]}' },
  );
  const runtime = fakeRuntime(fake, { verifyFork: true });
  const model = 'openai/gpt-5';
  const rows: string[] = [];
  const shadow = new JevVerifierShadow('test-only', (row) => rows.push(row));
  const findings = targets.slice(0, 1);
  const log = () => {};
  await runReview(runtime, model, 'ctx', '', log);
  const submit = () => runFindingVerification(runtime, model, 'ctx', findings, log);
  const first = { model, elapsedMs: 0 };
  await shadow.time(first, submit);
  rejectPrompt = true;
  const rejected = { model, elapsedMs: 0 };
  await assert.rejects(shadow.time(rejected, submit));
  await shadow.record(findings, first, rejected, findings);
  await shadow.record(findings, rejected, rejected);
  assert.equal(fetch.mock.callCount(), 0);
  const observations = rows.map((row) => JSON.parse(row.slice(row.indexOf('{'))));
  assert.deepEqual(
    observations.map((r) => [r.status, r.neededSecondPass]),
    [
      ['inherited-context', null],
      ['unobserved', null],
    ],
  );
});
