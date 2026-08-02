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

const input = {
  headSha: 'h1',
  model: 'p/m',
  context: 'PR context + assignment + diff slice',
  guidelines: 'guideline slice',
  evidenceQuotes: true,
};

describe('shardFingerprint', () => {
  it('covers every effective prompt input', () => {
    const base = shardFingerprint(input);
    assert.equal(shardFingerprint({ ...input }), base, 'stable for identical inputs');
    for (const variant of [
      { headSha: 'h2' },
      { model: 'p/other' },
      { context: 'different prompt' },
      { guidelines: 'other guidelines' },
      { evidenceQuotes: false },
    ]) {
      assert.notEqual(
        shardFingerprint({ ...input, ...variant }),
        base,
        `${Object.keys(variant)[0]} must change the fingerprint`,
      );
    }
  });
});

describe('shard result cache', () => {
  it('round-trips a result and fails open on missing, corrupt, or malformed entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-cache-'));
    try {
      const fingerprint = shardFingerprint(input);
      const result = {
        summary: 'looks fine',
        findings: [{ path: 'a.ts', line: 1, severity: 'P2' as const, title: 't', body: 'b' }],
      };

      assert.equal(loadCachedShardResult(dir, fingerprint), undefined, 'miss before save');
      saveShardResult(dir, fingerprint, result);
      assert.deepEqual(loadCachedShardResult(dir, fingerprint), result);

      // Fail-open covers entries other versions may have written: junk bytes,
      // and structurally-valid JSON whose findings are not findings.
      writeFileSync(join(dir, `${fingerprint}.json`), 'not json');
      assert.equal(loadCachedShardResult(dir, fingerprint), undefined, 'corrupt entry is a miss');
      writeFileSync(
        join(dir, `${fingerprint}.json`),
        JSON.stringify({ summary: 's', findings: [{ path: 1, line: 'x' }] }),
      );
      assert.equal(
        loadCachedShardResult(dir, fingerprint),
        undefined,
        'malformed finding is a miss',
      );
      writeFileSync(
        join(dir, `${fingerprint}.json`),
        JSON.stringify({
          summary: 's',
          findings: [{ path: 'a', line: 1, severity: 'P9', title: 't', body: 'b' }],
        }),
      );
      assert.equal(
        loadCachedShardResult(dir, fingerprint),
        undefined,
        'unknown severity is a miss',
      );

      // A directory that cannot be created must not throw either.
      saveShardResult('/dev/null/nope', fingerprint, result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
