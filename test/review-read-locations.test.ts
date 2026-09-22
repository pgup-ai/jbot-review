import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReadLocations, suppliedOverlap } from '../src/shared/review-read-locations.ts';

test('literal shell reads preserve their directory and range without evaluating shell syntax', () => {
  const reads = (command: string, extra = {}) =>
    reviewReadLocations('/repo', 'shell', { command, ...extra });
  assert.deepEqual(reads("cd /repo && sed -n '40,80p' src/a.ts && cat 'src/b file.ts'"), [
    { path: 'src/a.ts', line: 40, endLine: 80 },
    { path: 'src/b file.ts', line: 1, endLine: Number.MAX_SAFE_INTEGER },
  ]);
  assert.deepEqual(reads('cat a.ts b.ts', { cwd: '/repo/src' }), [
    { path: 'src/a.ts', line: 1, endLine: Number.MAX_SAFE_INTEGER },
    { path: 'src/b.ts', line: 1, endLine: Number.MAX_SAFE_INTEGER },
  ]);
  assert.deepEqual(
    reviewReadLocations('/repo', 'read', { filePath: '/repo/src/a.ts', offset: 12, limit: 6 }),
    [{ path: 'src/a.ts', line: 12, endLine: 17 }],
  );
  assert.deepEqual(reviewReadLocations('/repo', 'read_file', { path: 'src/a.ts', line: 40 }), [
    { path: 'src/a.ts', line: 40, endLine: 40 },
  ]);
  assert.deepEqual(
    reviewReadLocations('/repo', 'read_file', { path: 'src/a.ts', offset: 4096 }),
    [],
  );
  for (const limit of [undefined, 0, 3000]) {
    assert.deepEqual(
      reviewReadLocations('/repo', 'read', { filePath: '/repo/a.ts', offset: 12, limit }),
      [{ path: 'a.ts', line: 12, endLine: 2011 }],
    );
  }
  for (const command of [
    'cat ../secret.ts',
    'cd /private && cat secret.ts',
    'cat $(pwd)/a.ts',
    'cat a.ts; cat b.ts',
    'cat a.ts | head',
    'sed -i x a.ts',
    "sed -n '9,2p' a.ts",
    'cat *.ts',
    'cat a.ts > out',
    "cat 'unterminated",
    'cat a.ts &&',
    'cat a.ts && git diff',
  ])
    assert.deepEqual(reads(command), [], command);
});

test('supplied overlap separates re-reads and searches of context-pack content', () => {
  const supplied = {
    ranges: new Map<string, [number, number][]>([['src/a.ts', [[12, 20]]]]),
    symbols: new Set(['LedgerService']),
    directories: new Set(['src']),
  };
  const read = (input: Record<string, unknown>) => suppliedOverlap('/w', 'read', input, supplied);
  assert.equal(read({ filePath: '/w/src/a.ts', offset: 10, limit: 5 }), 'read');
  assert.equal(read({ filePath: '/w/src/a.ts', offset: 1, limit: 5 }), false);
  // No limit defaults to a 2000-line window; 9 supplied lines in it is not half.
  assert.equal(read({ filePath: '/w/src/a.ts', offset: 1 }), false);
  assert.equal(read({ filePath: '/w/src' }), 'read');
  assert.equal(
    suppliedOverlap('/w', 'grep', { pattern: 'LedgerService|other' }, supplied),
    'search',
  );
  assert.equal(
    suppliedOverlap('/w', 'shell', { command: 'grep -rn LedgerService src' }, supplied),
    'search',
  );
  assert.equal(
    suppliedOverlap('/w', 'shell', { command: 'grep -n "\\bLedgerService\\b" src' }, supplied),
    'search',
  );
  assert.equal(
    suppliedOverlap('/w', 'shell', { command: 'git log --grep=LedgerService' }, supplied),
    false,
  );
  assert.equal(
    suppliedOverlap(
      '/w',
      'shell',
      { command: 'grep -n "npm run build" ci.yml' },
      { ...supplied, symbols: new Set(['run']) },
    ),
    'search',
  );
  assert.equal(
    suppliedOverlap('/w', 'shell', { command: 'sed -n 15,16p src/a.ts' }, supplied),
    'read',
  );
});
