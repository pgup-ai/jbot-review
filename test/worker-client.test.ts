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

test('update throws on non-2xx', async () => {
  const fetchImpl = async () => new Response('nope', { status: 404 });
  const c = makeClient(cfg, fetchImpl as typeof fetch);
  await assert.rejects(() => c.update('1', { status: 'success' }), /404/);
});
