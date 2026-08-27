import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { discoverGuidelineDocs } from '../src/shared/review-context.ts';

// Synthetic .pr-governance fixture (no repo content). TECHNICAL_STANDARDS is
// padded so §16.2 sits well past the 24 KB per-file cap: a whole-file load would
// truncate before reaching it, so section extraction is the only way it loads.
function buildGovernanceRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'jbot-gov-'));
  mkdirSync(join(root, '.pr-governance/review'), { recursive: true });
  mkdirSync(join(root, '.pr-governance/design'), { recursive: true });

  writeFileSync(
    join(root, '.pr-governance/README.md'),
    [
      '## Rule IDs',
      '- `INV-<n>` — sections of `design/INVARIANTS.md`',
      '- `TS-<n>` — sections of `design/TECHNICAL_STANDARDS.md`',
    ].join('\n'),
  );
  writeFileSync(
    join(root, '.pr-governance/review/rules-for-diff.yaml'),
    [
      'version: 1',
      'entries:',
      '  - name: services',
      "    paths: ['apps/**/*.service.ts']",
      "    docs: ['.pr-governance/design/SEAMS.md']",
      '    rules: [TS-6, TS-6.1, TS-16.2]',
    ].join('\n'),
  );
  writeFileSync(join(root, '.pr-governance/design/SEAMS.md'), '# Seams\nrouted whole doc body');
  // §2 (uncited) is padded past 24 KB so §16.2 lives past the per-file cap: a
  // whole-file 24 KB load would stop in §2, but section extraction still reaches it.
  const filler = `\n${'padding to push §16.2 past the 24 KB whole-file cap. '.repeat(40)}`;
  writeFileSync(
    join(root, '.pr-governance/design/TECHNICAL_STANDARDS.md'),
    [
      '# Technical Standards',
      '## 6. Helpers', // nested parent — cited alongside its `### 6.1` child
      'parent body',
      '### 6.1 Nested child',
      'NESTED-CHILD-MARKER body',
      '## 2. Filler',
      `uncited body${filler.repeat(12)}`,
      '## 16. AI',
      'ai body',
      '## 16.2 Service parity',
      'THE-SERVICE-PARITY-RULE body',
      '## 17. Next',
      'seventeen body',
    ].join('\n'),
  );
  return root;
}

// Minimal single-doc routed repo. README uses the `maps to` phrasing (fms-frontend's),
// so these also exercise rule-ID resolution end-to-end for that convention.
function writeRoutedRepo(root: string, opts: { paths?: string; rules: string; doc: string }): void {
  mkdirSync(join(root, '.pr-governance/review'), { recursive: true });
  mkdirSync(join(root, '.pr-governance/design'), { recursive: true });
  writeFileSync(
    join(root, '.pr-governance/README.md'),
    '## Rule IDs\n- `TS-<n>` maps to `design/TECHNICAL_STANDARDS.md`',
  );
  writeFileSync(
    join(root, '.pr-governance/review/rules-for-diff.yaml'),
    `entries:\n  - name: s\n    paths: ${opts.paths ?? "['x/**']"}\n    rules: [${opts.rules}]`,
  );
  writeFileSync(join(root, '.pr-governance/design/TECHNICAL_STANDARDS.md'), opts.doc);
}

describe('discoverGuidelineDocs with diff routing', () => {
  const roots: string[] = [];
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  it('loads matched rule sections (past the file cap) instead of the whole doc', async () => {
    const root = buildGovernanceRepo();
    roots.push(root);
    const { docs } = await discoverGuidelineDocs(root, ['apps/core/src/thing.service.ts']);

    const tsSection = docs.find(
      (d) => d.label.includes('TECHNICAL_STANDARDS.md') && d.label.includes('§'),
    );
    assert.ok(tsSection, 'a TECHNICAL_STANDARDS section bundle is loaded');
    assert.match(tsSection.text, /THE-SERVICE-PARITY-RULE/, '§16.2 is included despite its offset');
    assert.match(tsSection.label, /§16\.2/);
    assert.equal(tsSection.relevance, 3, 'routed sections rank scoped (highest)');
    // §6.1 is nested under the also-cited §6, so it appears once (deduped), not twice.
    assert.equal(tsSection.text.match(/NESTED-CHILD-MARKER/g)?.length, 1);
    assert.ok(!tsSection.label.includes('§6.1'), 'the deduped child is not named in the label');

    // The whole (large) file is not also loaded — the sections stand in for it.
    assert.ok(!docs.some((d) => d.label.endsWith('TECHNICAL_STANDARDS.md')));
    // A routed `docs:` entry loads whole.
    assert.ok(docs.some((d) => d.label.endsWith('SEAMS.md')));
  });

  it('an oversized first section does not block smaller later ones, and is named omitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-cap-'));
    roots.push(root);
    writeRoutedRepo(root, {
      rules: 'TS-1, TS-2, TS-3',
      doc: [
        '## 1. Huge',
        'over-cap '.repeat(4000), // >24 KB, cited FIRST — must not starve §2/§3
        '## 2. Second',
        'SECTION-TWO',
        '## 3. Third',
        'SECTION-THREE',
      ].join('\n'),
    });
    const bundle = (await discoverGuidelineDocs(root, ['x/a.ts'])).docs.find((d) =>
      d.label.includes('§'),
    )!;
    assert.match(bundle.text, /SECTION-TWO/, 'a later small section lands despite the huge §1');
    assert.match(bundle.text, /SECTION-THREE/);
    assert.match(bundle.text, /Omitted from this bundle[\s\S]*§1/, 'the skipped section is named');
    assert.ok(!bundle.label.includes('§1'));
  });

  it('names a cited section absent from the source instead of dropping it silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-missing-'));
    roots.push(root);
    writeRoutedRepo(root, { rules: 'TS-1, TS-9', doc: '## 1. First\nSECTION-ONE' });
    const bundle = (await discoverGuidelineDocs(root, ['x/a.ts'])).docs.find((d) =>
      d.label.includes('§'),
    )!;
    assert.match(bundle.text, /SECTION-ONE/);
    assert.match(bundle.text, /§9 \(not found\)/, 'the absent cited section is disclosed');
    assert.ok(!bundle.label.includes('§9'));
  });

  it('bounds pathological route globs (over-length and over-expanding) so they cannot stall the matcher', async () => {
    // Each glob would match its file if unbounded; both must be rejected — one by
    // MAX_GLOB_LENGTH (short-circuits first), one by MAX_GLOB_VARIANTS (2^7 > 64).
    const cases = [
      { tag: 'length', paths: `['${'*'.repeat(130)}']`, file: 'a.ts' },
      { tag: 'variants', paths: `['x/${'{a,b}'.repeat(7)}.ts']`, file: 'x/aaaaaaa.ts' },
    ];
    for (const { tag, paths, file } of cases) {
      const root = mkdtempSync(join(tmpdir(), `jbot-glob-${tag}-`));
      roots.push(root);
      writeRoutedRepo(root, { paths, rules: 'TS-1', doc: '## 1. First\nSECTION-ONE' });
      const { docs } = await discoverGuidelineDocs(root, [file]);
      assert.ok(!docs.some((d) => d.label.includes('§')), `${tag}-bounded glob loads no section`);
    }
  });

  it('falls back to whole-file discovery when no routing file exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-noroute-'));
    roots.push(root);
    writeFileSync(join(root, 'AGENTS.md'), '# Agents\nrepo guidance');
    const { docs } = await discoverGuidelineDocs(root, ['src/x.ts']);
    assert.ok(docs.some((d) => d.label === 'AGENTS.md'));
    assert.ok(!docs.some((d) => d.label.includes('§')));
  });
});
