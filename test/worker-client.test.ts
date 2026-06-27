import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient } from '../src/worker/client.ts';

const cfg = { controlPlaneUrl: 'https://cp', sharedSecret: 's', pollMs: 1 };

test('claim returns null on 204 (empty queue)', async () => {
  const fetchImpl = async () => new Response(null, { status: 204 });
  const c = makeClient(cfg, fetchImpl as typeof fetch);
  assert.equal(await c.claim(), null);
});

test('claim returns the job on 200', async () => {
  const job = {
    jobId: '1',
    repoFullName: 'o/r',
    prNumber: 2,
    model: 'opencode/x',
    auxModel: null,
    apiKey: 'k',
    installationToken: 't',
    claimToken: 'fence-uuid',
  };
  const fetchImpl = async () =>
    new Response(JSON.stringify(job), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const c = makeClient(cfg, fetchImpl as typeof fetch);
  assert.deepEqual(await c.claim(), job);
});

test('claim throws on a non-204 error status', async () => {
  const fetchImpl = async () => new Response('boom', { status: 500 });
  const c = makeClient(cfg, fetchImpl as typeof fetch);
  await assert.rejects(() => c.claim(), /claim -> 500/);
});

test('claim throws when the 200 response is missing claimToken (fence absent)', async () => {
  // A control plane without the claim_token fence would omit the field; echoing
  // an absent token silently stalls the job, so we fail fast and loud instead.
  const noToken = {
    jobId: '1',
    repoFullName: 'o/r',
    prNumber: 2,
    model: 'opencode/x',
    auxModel: null,
    apiKey: 'k',
    installationToken: 't',
  };
  const fetchImpl = async () =>
    new Response(JSON.stringify(noToken), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const c = makeClient(cfg, fetchImpl as typeof fetch);
  await assert.rejects(() => c.claim(), /missing claimToken/);
});

test('update throws on non-2xx', async () => {
  const fetchImpl = async () => new Response('nope', { status: 404 });
  const c = makeClient(cfg, fetchImpl as typeof fetch);
  await assert.rejects(() => c.update('1', { claimToken: 'f', status: 'success' }), /404/);
});

test('update PATCHes the claimToken fence in the body', async () => {
  let sentBody: unknown;
  const fetchImpl = async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return new Response(null, { status: 204 });
  };
  const c = makeClient(cfg, fetchImpl as unknown as typeof fetch);
  await c.update('1', { claimToken: 'fence-uuid', status: 'success' });
  assert.deepEqual(sentBody, { claimToken: 'fence-uuid', status: 'success' });
});
