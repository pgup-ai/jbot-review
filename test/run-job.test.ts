import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octokitForToken } from '../src/worker/run-job.ts';

test('octokitForToken builds a REST-capable client', () => {
  const o = octokitForToken('t');
  assert.equal(typeof o.rest.pulls.get, 'function');
});
