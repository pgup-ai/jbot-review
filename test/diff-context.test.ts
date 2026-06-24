import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PATH_PATTERNS,
  buildDiffHunksBlock,
  buildDiffHunksBlockWithMetadata,
  classifyChangeShape,
  diffRiskScore,
  isDocFile,
  isDocOnlyChange,
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

  it('reports which files were truncated or omitted by the diff budget', () => {
    const result = buildDiffHunksBlockWithMetadata(
      [
        { filename: 'src/auth/a.ts', patch: makePatch(100, 'a') },
        { filename: 'docs/b.md', patch: makePatch(50, 'b') },
      ],
      { totalBudgetBytes: 300, perFileBudgetBytes: 220 },
    );

    assert.match(result.text, /### src\/auth\/a\.ts/);
    assert.deepEqual(result.truncatedFiles, ['src/auth/a.ts']);
    assert.deepEqual(result.omittedFiles, ['docs/b.md']);
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

describe('PATH_PATTERNS.infra', () => {
  it('matches IaC, containers, and deploy manifests', () => {
    for (const file of [
      'infra/main.tf',
      'terraform/prod.tfvars',
      'Dockerfile',
      'services/api/Dockerfile.prod',
      'deploy/k8s/app.yaml',
      'helm/charts/web/values.yaml',
      'charts/myapp/Chart.yaml',
      'pulumi/index.ts',
    ]) {
      assert.ok(PATH_PATTERNS.infra.test(file), `expected infra match: ${file}`);
    }
  });

  it('does not match application code, CI workflows, or frontend chart components', () => {
    for (const file of [
      'src/shared/runner.ts',
      '.github/workflows/ci.yml',
      'README.md',
      'src/components/charts/LineChart.tsx',
    ]) {
      assert.ok(!PATH_PATTERNS.infra.test(file), `unexpected infra match: ${file}`);
    }
  });
});

describe('diffRiskScore infra weighting', () => {
  it('ranks an infra change above prose and above a generic config file', () => {
    const infra = { filename: 'deploy/k8s/app.yaml', patch: '+ replicas: 3' };
    const genericYaml = { filename: 'config/app.yaml', patch: '+ key: value' };
    const doc = { filename: 'docs/guide.md', patch: '+ words' };
    assert.ok(diffRiskScore(infra) > diffRiskScore(genericYaml));
    assert.ok(diffRiskScore(genericYaml) > diffRiskScore(doc));
  });
});

describe('classifyChangeShape', () => {
  function removals(count: number): string {
    return Array.from({ length: count }, (_, i) => `-const removed${i} = ${i};`).join('\n');
  }
  function additions(count: number): string {
    return Array.from({ length: count }, (_, i) => `+const added${i} = ${i};`).join('\n');
  }

  it('flags a test-only change', () => {
    const shape = classifyChangeShape([
      { filename: 'src/components/Invoice.test.tsx', patch: '@@ -1 +1 @@\n+expect(x).toBe(1);' },
      { filename: 'test/runner.test.ts', patch: '@@ -1 +1 @@\n+ok(y);' },
    ]);
    assert.equal(shape.testOnly, true);
  });

  it('is not test-only when a source file changes alongside tests', () => {
    const shape = classifyChangeShape([
      { filename: 'src/runner.ts', patch: '@@ -1 +1 @@\n+const a = 1;' },
      { filename: 'test/runner.test.ts', patch: '@@ -1 +1 @@\n+expect(a);' },
    ]);
    assert.equal(shape.testOnly, false);
  });

  it('flags a large deletion when removals dominate', () => {
    const shape = classifyChangeShape([
      { filename: 'src/legacy.ts', patch: `@@ -1,60 +1,1 @@\n${removals(60)}\n+keep();` },
    ]);
    assert.equal(shape.largeDeletion, true);
  });

  it('does not flag a balanced move/refactor as a large deletion', () => {
    const shape = classifyChangeShape([
      { filename: 'src/move.ts', patch: `@@ -1,50 +1,50 @@\n${removals(50)}\n${additions(50)}` },
    ]);
    assert.equal(shape.largeDeletion, false);
  });

  it('does not flag a small deletion as a large deletion', () => {
    const shape = classifyChangeShape([
      { filename: 'src/x.ts', patch: '@@ -1,2 +1,1 @@\n-a();\n-b();\n+c();' },
    ]);
    assert.equal(shape.largeDeletion, false);
  });

  it('pins the large-deletion removal-count threshold at 40', () => {
    const pureDeletion = (count: number): PrFile => ({
      filename: 'src/a.ts',
      patch: `@@ -1,${count} +0,0 @@\n${removals(count)}`,
    });
    assert.equal(classifyChangeShape([pureDeletion(40)]).largeDeletion, true);
    assert.equal(classifyChangeShape([pureDeletion(39)]).largeDeletion, false);
  });

  it('pins the large-deletion 3x dominance threshold', () => {
    const ratio = (added: number): PrFile => ({
      filename: 'src/a.ts',
      patch: `@@ -1,40 +1,${added} @@\n${removals(40)}\n${additions(added)}`,
    });
    // 40 removed, 13 added: 40 >= 13*3 (39) → still dominant.
    assert.equal(classifyChangeShape([ratio(13)]).largeDeletion, true);
    // 40 removed, 14 added: 40 < 14*3 (42) → dominance lost.
    assert.equal(classifyChangeShape([ratio(14)]).largeDeletion, false);
  });

  it('counts content lines beginning with ++ or -- (not just diff headers)', () => {
    // A removed line of code `--i;` renders in the patch as `---i;`; it must
    // count as a removal, not be mistaken for a `---` file header.
    const decrements = Array.from({ length: 40 }, () => '---i;').join('\n');
    const shape = classifyChangeShape([
      { filename: 'src/counter.ts', patch: `@@ -1,40 +0,0 @@\n${decrements}` },
    ]);
    assert.equal(shape.largeDeletion, true);
  });

  it('does not count true unified-diff file headers as changed lines', () => {
    // 39 real removals plus '--- '/'+++ ' headers must stay below the 40 floor.
    const removed39 = Array.from({ length: 39 }, (_, i) => `-line${i}`).join('\n');
    const shape = classifyChangeShape([
      {
        filename: 'src/x.ts',
        patch: `--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,39 +0,0 @@\n${removed39}`,
      },
    ]);
    assert.equal(shape.largeDeletion, false);
  });

  it('flags a dependency manifest change', () => {
    const shape = classifyChangeShape([
      {
        filename: 'package.json',
        patch: '@@ -1 +1 @@\n-  "left-pad": "1.0.0"\n+  "left-pad": "1.3.0"',
      },
    ]);
    assert.equal(shape.dependencyManifestChange, true);
  });

  it('does not treat arbitrary json as a dependency manifest', () => {
    const shape = classifyChangeShape([
      { filename: 'src/data/config.json', patch: '@@ -1 +1 @@\n+{ "k": 1 }' },
    ]);
    assert.equal(shape.dependencyManifestChange, false);
  });

  it('returns all-false for an empty change set', () => {
    assert.deepEqual(classifyChangeShape([]), {
      testOnly: false,
      largeDeletion: false,
      dependencyManifestChange: false,
    });
  });
});

describe('isDocOnlyChange', () => {
  it('treats prose, document, and diagram assets as docs', () => {
    for (const f of [
      'README.md',
      'docs/guide.mdx',
      'CHANGELOG.markdown',
      'a/b.rst',
      'x.adoc',
      'notes.txt',
      'spec/report.pdf',
      'assets/icon.svg',
      'design/architecture.drawio',
      'design/flow.dio',
      'design/sketch.excalidraw',
      'docs/seq.mmd',
      'docs/component.puml',
      'docs/uml.plantuml',
    ]) {
      assert.equal(isDocFile(f), true, f);
    }
  });

  it('treats code, config, and extensionless files as non-docs', () => {
    for (const f of [
      'src/a.ts',
      'action.yml',
      'package.json',
      'Dockerfile',
      'LICENSE',
      'a.md.ts',
    ]) {
      assert.equal(isDocFile(f), false, f);
    }
  });

  it('is doc-only only when every changed file is a doc', () => {
    assert.equal(isDocOnlyChange(['README.md', 'docs/x.md']), true);
    assert.equal(isDocOnlyChange(['README.md', 'src/a.ts']), false);
    assert.equal(isDocOnlyChange(['src/a.ts']), false);
  });

  it('is not doc-only for an empty change set (nothing to skip)', () => {
    assert.equal(isDocOnlyChange([]), false);
  });
});
