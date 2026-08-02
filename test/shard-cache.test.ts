import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  loadCachedShardResult,
  saveShardResult,
  shardFingerprint,
} from '../src/shared/shard-cache.ts';

const files = [
  { filename: 'a.ts', patch: '@@ -1 +1 @@\n+const a = 1;' },
  { filename: 'b.ts', patch: '@@ -1 +1 @@\n+const b = 2;' },
];

describe('shardFingerprint', () => {
  it('is content-addressed: stable under file order, sensitive to content/head/model', () => {
    const base = shardFingerprint({ headSha: 'h1', model: 'p/m', files });
    assert.equal(
      shardFingerprint({ headSha: 'h1', model: 'p/m', files: [...files].reverse() }),
      base,
      'file order must not matter',
    );
    assert.notEqual(
      shardFingerprint({
        headSha: 'h1',
        model: 'p/m',
        files: [files[0], { ...files[1], patch: '@@ -1 +1 @@\n+const b = 3;' }],
      }),
      base,
      'a changed patch changes the fingerprint',
    );
    assert.notEqual(shardFingerprint({ headSha: 'h2', model: 'p/m', files }), base);
    assert.notEqual(shardFingerprint({ headSha: 'h1', model: 'p/other', files }), base);
  });
});

describe('shard result cache', () => {
  it('round-trips a result and fails open on missing or corrupt entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-cache-'));
    try {
      const fingerprint = shardFingerprint({ headSha: 'h1', model: 'p/m', files });
      const result = {
        summary: 'looks fine',
        findings: [{ path: 'a.ts', line: 1, severity: 'P2' as const, title: 't', body: 'b' }],
      };

      assert.equal(loadCachedShardResult(dir, fingerprint), undefined, 'miss before save');
      saveShardResult(dir, fingerprint, result);
      assert.deepEqual(loadCachedShardResult(dir, fingerprint), result);

      writeFileSync(join(dir, `${fingerprint}.json`), 'not json');
      assert.equal(loadCachedShardResult(dir, fingerprint), undefined, 'corrupt entry is a miss');

      // A directory that cannot be created must not throw either.
      saveShardResult('/dev/null/nope', fingerprint, result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
