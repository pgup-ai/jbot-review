import assert from 'node:assert/strict';
import { it } from 'node:test';

import { benchmarkArgument } from '../scripts/benchmark-args.ts';

it('parses split and equals-style benchmark arguments without consuming another flag', () => {
  assert.equal(benchmarkArgument('output', ['node', 'script', '--output', 'result']), 'result');
  assert.equal(benchmarkArgument('output', ['node', 'script', '--output=result']), 'result');
  assert.equal(benchmarkArgument('output', ['node', 'script']), undefined);
  assert.equal(
    benchmarkArgument('output', ['node', 'script', '--output', '--subset', 'smoke']),
    undefined,
  );
});
