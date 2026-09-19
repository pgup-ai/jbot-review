import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReadLocations } from '../src/shared/review-read-locations.ts';

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
