import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  loadCachedShardResult,
  resolveShardCacheDir,
  saveShardResult,
  shardFingerprint,
} from '../src/shared/shard-cache.ts';

const input = {
  headSha: 'h1',
  model: 'p/m',
  context: 'PR context + assignment + diff slice',
  guidelines: 'guideline slice',
  evidenceQuotes: true,
  config: '{"engine":"opencode","modelOptions":{"reasoningEffort":"medium"}}',
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
      { config: '{"engine":"pi","modelOptions":{"reasoningEffort":"high"}}' },
    ]) {
      assert.notEqual(
        shardFingerprint({ ...input, ...variant }),
        base,
        `${Object.keys(variant)[0]} must change the fingerprint`,
      );
    }

    // Field boundaries must be unambiguous: a NUL inside one field must not
    // alias a different split of the same bytes across two fields.
    assert.notEqual(
      shardFingerprint({ ...input, config: 'a\0b', context: 'c' }),
      shardFingerprint({ ...input, config: 'a', context: 'b\0c' }),
    );
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
      assert.deepEqual(loadCachedShardResult(dir, fingerprint), {
        summary: result.summary,
        findings: [{ ...result.findings[0], kind: undefined, confidence: undefined }],
      });

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
      // Optionals get the LIVE parse bar (sanitizeFinding): a mistyped
      // evidence is stripped, not entry-fatal — the finding survives with the
      // same tolerance a model response gets, and nothing crashy remains.
      writeFileSync(
        join(dir, `${fingerprint}.json`),
        JSON.stringify({
          summary: 's',
          findings: [{ path: 'a', line: 1, severity: 'P2', title: 't', body: 'b', evidence: 42 }],
        }),
      );
      assert.deepEqual(loadCachedShardResult(dir, fingerprint), {
        summary: 's',
        findings: [
          {
            path: 'a',
            line: 1,
            severity: 'P2',
            title: 't',
            body: 'b',
            kind: undefined,
            confidence: undefined,
          },
        ],
      });
      writeFileSync(
        join(dir, `${fingerprint}.json`),
        JSON.stringify({
          summary: 's',
          findings: [{ path: 'a', line: 2.5, severity: 'P2', title: 't', body: 'b' }],
        }),
      );
      assert.equal(
        loadCachedShardResult(dir, fingerprint),
        undefined,
        'a fractional line is a miss — parsers require integer lines ≥ 0',
      );

      // A directory that cannot be created must not throw either.
      saveShardResult('/dev/null/nope', fingerprint, result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a cache directory inside the reviewed workspace, symlinks included', () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-cache-guard-'));
    try {
      const workspace = join(root, 'checkout');
      const outside = join(root, 'cache');
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });

      assert.equal(resolveShardCacheDir(outside, workspace), outside, 'an outside dir is usable');
      assert.equal(
        resolveShardCacheDir(join(workspace, '.jbot-review', 'cache'), workspace),
        undefined,
        'a dir inside the PR-controlled checkout is forgeable and refused',
      );
      assert.equal(resolveShardCacheDir(workspace, workspace), undefined);

      // A symlink that RESOLVES into the workspace must not bypass the guard.
      const sneaky = join(root, 'sneaky');
      symlinkSync(join(workspace, 'sub'), sneaky);
      mkdirSync(join(workspace, 'sub'), { recursive: true });
      assert.equal(resolveShardCacheDir(sneaky, workspace), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
