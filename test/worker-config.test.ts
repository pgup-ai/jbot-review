import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkerConfig } from '../src/worker/config.ts';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = { ...process.env };
  Object.assign(process.env, { CONTROL_PLANE_URL: 'https://cp', WORKER_SHARED_SECRET: 's' });
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    process.env = saved;
  }
}

test('WORKER_POLL_MS: only an explicit positive number is honored; else 5000', () => {
  const cases: Array<[string | undefined, number]> = [
    [undefined, 5000],
    ['0', 5000],
    ['-100', 5000],
    ['abc', 5000],
    ['2000', 2000],
  ];
  for (const [val, expected] of cases) {
    withEnv({ WORKER_POLL_MS: val }, () => {
      assert.equal(loadWorkerConfig().pollMs, expected, `WORKER_POLL_MS=${val}`);
    });
  }
});

test('CONTROL_PLANE_URL: non-https is rejected (localhost allowed)', () => {
  withEnv({ CONTROL_PLANE_URL: 'http://evil.com' }, () => {
    assert.throws(() => loadWorkerConfig(), /https/);
  });
  withEnv({ CONTROL_PLANE_URL: 'http://localhost:3001' }, () => {
    assert.equal(loadWorkerConfig().controlPlaneUrl, 'http://localhost:3001');
  });
});
