import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDiffHunksBlock,
  diffRiskScore,
  shardFilesForReview,
} from '../src/shared/diff-context.ts';
import type { PrFile } from '../src/shared/github.ts';

function makePatch(lines: number, prefix = 'line'): string {
  const body = Array.from({ length: lines }, (_, i) => `+const ${prefix}${i} = ${i};`).join('\n');
  return `@@ -0,0 +1,${lines} @@\n${body}`;
}

describe('diffRiskScore', () => {
  it('ranks auth code above source above tests above docs', () => {
    const auth: PrFile = { filename: 'src/auth/session.ts', patch: makePatch(5) };
    const source: PrFile = { filename: 'src/billing/invoice.ts', patch: makePatch(5) };
    const test: PrFile = { filename: 'test/invoice.test.ts', patch: makePatch(5) };
    const doc: PrFile = { filename: 'docs/notes.md', patch: makePatch(5) };

    assert.ok(diffRiskScore(auth) > diffRiskScore(source));
    assert.ok(diffRiskScore(source) > diffRiskScore(test));
    assert.ok(diffRiskScore(test) > diffRiskScore(doc));
  });

  it('caps the churn tiebreaker so giant patches cannot outrank risky paths', () => {
    const hugeDoc: PrFile = { filename: 'docs/huge.md', patch: makePatch(5000) };
    const smallAuth: PrFile = { filename: 'src/auth/guard.ts', patch: makePatch(3) };

    assert.ok(diffRiskScore(smallAuth) > diffRiskScore(hugeDoc));
  });
});

describe('buildDiffHunksBlock', () => {
  it('returns empty for files without patches', () => {
    assert.equal(buildDiffHunksBlock([{ filename: 'a.ts' }]), '');
    assert.equal(buildDiffHunksBlock([]), '');
  });

  it('embeds hunks highest-risk first inside diff fences', () => {
    const block = buildDiffHunksBlock([
      { filename: 'README.md', patch: makePatch(2, 'doc') },
      { filename: 'src/auth/guard.ts', patch: makePatch(2, 'auth') },
    ]);

    assert.match(block, /## Diff hunks/);
    assert.ok(block.indexOf('### src/auth/guard.ts') < block.indexOf('### README.md'));
    assert.match(block, /```diff\n@@ -0,0 \+1,2 @@/);
  });

  it('truncates a single file at a line boundary with a notice', () => {
    const block = buildDiffHunksBlock([{ filename: 'src/a.ts', patch: makePatch(100) }], {
      perFileBudgetBytes: 200,
      totalBudgetBytes: 10_000,
    });

    assert.match(block, /_Hunks truncated for src\/a\.ts/);
    // Every kept diff line is complete (no mid-line cuts).
    const fenced = block.split('```diff\n')[1].split('\n```')[0];
    for (const line of fenced.split('\n')) {
      assert.match(line, /^(@@|\+const \w+ = \d+;$)/);
    }
  });

  it('accounts for long truncation notices when enforcing the file budget', () => {
    const longName = 'src/very/long/path/to/some/deeply/nested/file-with-a-long-name.ts';
    const block = buildDiffHunksBlock([{ filename: longName, patch: makePatch(100) }], {
      perFileBudgetBytes: 360,
      totalBudgetBytes: 10_000,
    });
    const fenced = block.split('```diff\n')[1].split('\n```')[0];
    const notice = `_Hunks truncated for ${longName}; run the git diff command for the rest._`;
    const section = [`### ${longName}`, '```diff', fenced, '```', notice].join('\n');

    assert.ok(Buffer.byteLength(section, 'utf8') <= 360);
    assert.match(
      block,
      new RegExp(`_Hunks truncated for ${longName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('lists files omitted by the total budget instead of dropping them silently', () => {
    const block = buildDiffHunksBlock(
      [
        { filename: 'src/auth/a.ts', patch: makePatch(50, 'a') },
        { filename: 'docs/b.md', patch: makePatch(50, 'b') },
      ],
      { totalBudgetBytes: 600, perFileBudgetBytes: 10_000 },
    );

    assert.match(block, /### Hunks not embedded \(diff budget reached\)/);
    assert.match(block, /- docs\/b\.md/);
    assert.match(block, /### src\/auth\/a\.ts/);
  });
});

describe('shardFilesForReview', () => {
  function fileOfSize(name: string, bytes: number): PrFile {
    return { filename: name, patch: `@@ -0,0 +1,1 @@\n+${'x'.repeat(Math.max(bytes - 18, 1))}` };
  }

  it('keeps small diffs in a single shard', () => {
    const shards = shardFilesForReview([fileOfSize('a.ts', 2000), fileOfSize('b.ts', 2000)]);

    assert.equal(shards.length, 1);
  });

  it('auto-scales shard count with total patch size, capped at maxShards', () => {
    const files = Array.from({ length: 10 }, (_, i) => fileOfSize(`f${i}.ts`, 20_000));

    const auto = shardFilesForReview(files);
    assert.equal(auto.length, 4);

    const capped = shardFilesForReview(files, { maxShards: 2 });
    assert.equal(capped.length, 2);
  });

  it('honors an explicit shard count and never exceeds the file count', () => {
    const files = [fileOfSize('a.ts', 100_000), fileOfSize('b.ts', 100_000)];

    assert.equal(shardFilesForReview(files, { requestedShards: 3 }).length, 2);
    assert.equal(shardFilesForReview(files, { requestedShards: 2 }).length, 2);
  });

  it('assigns every file to exactly one shard', () => {
    const files = Array.from({ length: 9 }, (_, i) => fileOfSize(`f${i}.ts`, 15_000));

    const shards = shardFilesForReview(files);
    const assigned = shards.flat().map((file) => file.filename);

    assert.equal(assigned.length, files.length);
    assert.equal(new Set(assigned).size, files.length);
  });

  it('assigns patchless files to shards in multi-shard mode', () => {
    const files = [
      fileOfSize('large-a.ts', 30_000),
      fileOfSize('large-b.ts', 30_000),
      { filename: 'asset.bin' },
      { filename: 'renamed-only.ts' },
    ];

    const shards = shardFilesForReview(files, { requestedShards: 2 });
    const assigned = shards.flat().map((file) => file.filename);

    assert.deepEqual(new Set(assigned), new Set(files.map((file) => file.filename)));
  });

  it('balances shard sizes largest-first', () => {
    const files = [
      fileOfSize('big.ts', 40_000),
      fileOfSize('mid1.ts', 20_000),
      fileOfSize('mid2.ts', 20_000),
    ];

    const shards = shardFilesForReview(files, { requestedShards: 2 });
    const loads = shards.map((shard) =>
      shard.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0),
    );

    // big.ts alone vs the two mids together: no shard should hold everything.
    assert.equal(shards.length, 2);
    assert.ok(Math.max(...loads) <= 41_000);
  });
});
