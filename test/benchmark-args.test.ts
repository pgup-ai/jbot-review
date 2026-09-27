import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { benchmarkArgument, integerArgument, readJsonLines } from '../scripts/benchmark-args.ts';

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

it('parses integer arguments and throws on typos or values below the minimum', () => {
  const argv = (...flags: string[]) => ['node', 'script', ...flags];
  assert.equal(integerArgument('concurrency', 4, 1, argv()), 4);
  assert.equal(integerArgument('concurrency', 4, 1, argv('--concurrency', '8')), 8);
  for (const typo of ['4x', '0', '1.5'])
    assert.throws(
      () => integerArgument('concurrency', 4, 1, argv(`--concurrency=${typo}`)),
      /--concurrency must be an integer ≥ 1, got/,
    );
});

it('reads nonblank JSONL records and reports malformed line locations', () => {
  const root = mkdtempSync(join(tmpdir(), 'jbot-benchmark-args-'));
  const path = join(root, 'rows.jsonl');
  try {
    writeFileSync(path, '{"id":1}\r\n  \r\n{"id":2}\n');
    assert.deepEqual(readJsonLines(path), [{ id: 1 }, { id: 2 }]);
    writeFileSync(path, '{"id":1}\ninvalid\n');
    assert.throws(
      () => readJsonLines(path),
      (error: unknown) => error instanceof Error && error.message.includes(`${path}:2`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
