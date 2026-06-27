import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octokitForToken, runJob } from '../src/worker/run-job.ts';

test('octokitForToken builds a REST-capable client', () => {
  const o = octokitForToken('t');
  assert.equal(typeof o.rest.pulls.get, 'function');
});

test('runJob returns failed (never throws) on a malformed repoFullName', async () => {
  const result = await runJob(
    {
      jobId: '1',
      repoFullName: 'noslash',
      prNumber: 1,
      model: 'opencode/x',
      auxModel: null,
      apiKey: 'k',
      auxApiKey: null,
      installationToken: 't',
      claimToken: 'fence-uuid',
    },
    () => {},
  );
  assert.equal(result.status, 'failed');
  // The fence token must be echoed back on every update, terminal ones included.
  assert.equal(result.claimToken, 'fence-uuid');
});
