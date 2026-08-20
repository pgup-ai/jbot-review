import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { benchmarkArgument, readJsonLines } from '../scripts/benchmark-args.ts';

it('parses split and equals-style benchmark arguments without consuming another flag', () => {
  assert.equal(benchmarkArgument('output', ['node', 'script', '--output', 'result']), 'result');
  assert.equal(benchmarkArgument('output', ['node', 'script', '--output=result']), 'result');
  assert.equal(benchmarkArgument('output', ['node', 'script', '--output=']), undefined);
  assert.equal(benchmarkArgument('output', ['node', 'script', '--output=--subset']), undefined);
  assert.equal(benchmarkArgument('output', ['node', 'script']), undefined);
  assert.equal(
    benchmarkArgument('output', ['node', 'script', '--output', '--subset', 'smoke']),
    undefined,
  );
});

it('reads nonblank JSONL records and reports malformed line locations', () => {
  const root = mkdtempSync(join(tmpdir(), 'jbot-benchmark-args-'));
  const path = join(root, 'rows.jsonl');
  try {
    writeFileSync(path, '{"id":1}\r\n  \r\n{"id":2}\n');
    assert.deepEqual(readJsonLines(path), [{ id: 1 }, { id: 2 }]);
    writeFileSync(path, '{"id":1}\ninvalid\n');
    assert.throws(() => readJsonLines(path), new RegExp(`${path}:2`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
