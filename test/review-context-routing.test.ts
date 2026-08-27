import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  discoverGuidelineDocs,
  formatFinderGuidelines,
  formatGuidelines,
} from '../src/shared/review-context.ts';

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

  it('matches many globs across varied-length files correctly (compiled cache + shared scratch)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-multi-'));
    roots.push(root);
    mkdirSync(join(root, '.pr-governance/review'), { recursive: true });
    mkdirSync(join(root, '.pr-governance/design'), { recursive: true });
    writeFileSync(
      join(root, '.pr-governance/README.md'),
      '## Rule IDs\n- `TS-<n>` maps to `design/TECHNICAL_STANDARDS.md`',
    );
    writeFileSync(
      join(root, '.pr-governance/review/rules-for-diff.yaml'),
      "entries:\n  - name: a\n    paths: ['apps/**']\n    rules: [TS-1]\n  - name: b\n    paths: ['libs/**']\n    rules: [TS-2]",
    );
    writeFileSync(
      join(root, '.pr-governance/design/TECHNICAL_STANDARDS.md'),
      '## 1. First\nSECTION-ONE\n## 2. Second\nSECTION-TWO',
    );
    // The long apps path grows the shared match scratch; libs/** must still match
    // the short libs path afterward (reused scratch not corrupted across calls).
    const bundle = (
      await discoverGuidelineDocs(root, ['apps/really/deep/nested/dir/component.tsx', 'libs/y.ts'])
    ).docs.find((d) => d.label.includes('§'))!;
    assert.match(bundle.text, /SECTION-ONE/, 'apps/** matched via TS-1');
    assert.match(bundle.text, /SECTION-TWO/, 'libs/** matched via TS-2 after the scratch grew');
  });

  it('honors whole-doc precedence (via a symlinked docs: entry) over section extraction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-symlink-'));
    roots.push(root);
    mkdirSync(join(root, '.pr-governance/review'), { recursive: true });
    mkdirSync(join(root, '.pr-governance/design'), { recursive: true });
    writeFileSync(
      join(root, '.pr-governance/README.md'),
      '## Rule IDs\n- `INV-<n>` maps to `design/INVARIANTS.md`',
    );
    writeFileSync(
      join(root, '.pr-governance/design/INVARIANTS.md'),
      '# Invariants\n## 1. First\nWHOLE-VIA-SYMLINK',
    );
    // docs: points at a symlink to the same file the rule maps to; real-path
    // comparison must still treat it as the whole-doc request.
    symlinkSync('INVARIANTS.md', join(root, '.pr-governance/design/inv-link.md'));
    writeFileSync(
      join(root, '.pr-governance/review/rules-for-diff.yaml'),
      "entries:\n  - name: s\n    paths: ['x/**']\n    docs: ['.pr-governance/design/inv-link.md']\n    rules: [INV-1]",
    );
    const { docs } = await discoverGuidelineDocs(root, ['x/a.ts']);
    assert.ok(
      docs.some((d) => d.text.includes('WHOLE-VIA-SYMLINK')),
      'the symlinked target loads whole',
    );
    assert.ok(!docs.some((d) => d.label.includes('§')), 'section extraction was skipped');
  });

  it('discloses a route whose every cited section is unavailable, bounded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-allmiss-'));
    roots.push(root);
    // §97/§98 are absent; a bounded "unavailable" record must still name them.
    writeRoutedRepo(root, { rules: 'TS-97, TS-98', doc: '## 1. Only\nSECTION-ONE' });
    const { docs } = await discoverGuidelineDocs(root, ['x/a.ts']);
    const rec = docs.find((d) => d.label.includes('unavailable'))!;
    assert.match(rec.text, /§97 \(not found\)/);
    assert.ok(!docs.some((d) => d.label.includes('§')), 'no section bundle — nothing resolved');
  });

  it('keeps body+note within the per-file cap when the selected section is truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-trunc-'));
    roots.push(root);
    // A single ~40 KB section forces truncation; the note + its "(truncated)" marker must still fit.
    writeRoutedRepo(root, { rules: 'TS-1', doc: `## 1. Big\n${'x'.repeat(40000)}` });
    const bundle = (await discoverGuidelineDocs(root, ['x/a.ts'])).docs.find((d) =>
      d.label.includes('§'),
    )!;
    assert.match(bundle.text, /truncated/, 'the truncation is disclosed');
    assert.ok(
      Buffer.byteLength(bundle.text, 'utf8') <= 24 * 1024,
      'body plus the truncation note stays within the per-file cap',
    );
  });

  it('does not falsely truncate a section that fits under the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-fits-'));
    roots.push(root);
    writeRoutedRepo(root, { rules: 'TS-1', doc: `## 1. Fits\n${'x'.repeat(20000)}` }); // ~20 KB < 24 KB
    const bundle = (await discoverGuidelineDocs(root, ['x/a.ts'])).docs.find((d) =>
      d.label.includes('§'),
    )!;
    assert.ok(!bundle.text.includes('truncated'), 'a fitting section is not marked truncated');
    assert.equal(bundle.text.match(/x/g)?.length, 20000, 'the full body is present');
  });

  it('byte-bounds the omission note when a route cites hundreds of unavailable sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-note-'));
    roots.push(root);
    const many = Array.from({ length: 400 }, (_, i) => `TS-${i + 100}`).join(', ');
    writeRoutedRepo(root, { rules: `TS-1, ${many}`, doc: '## 1. First\nSECTION-ONE' });
    const bundle = (await discoverGuidelineDocs(root, ['x/a.ts'])).docs.find((d) =>
      d.label.includes('§'),
    )!;
    assert.match(bundle.text, /SECTION-ONE/);
    assert.match(bundle.text, /\+\d+ more/, 'the list is capped with a +N more summary');
    assert.ok(
      Buffer.byteLength(bundle.text, 'utf8') < 2048,
      'the note cannot balloon to hundreds of ids',
    );
  });

  it('applies globstar/star/? tokens with the correct segment and slash semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-tokens-'));
    roots.push(root);
    // `?` glob uses a distinct extension so `**/*.ts` can't mask its slash test.
    writeRoutedRepo(root, {
      paths: "['**/*.ts', 'x/a?c.md']",
      rules: 'TS-1',
      doc: '## 1. A\nONE',
    });
    const matches = async (file: string) =>
      (await discoverGuidelineDocs(root, [file])).docs.some((d) => d.label.includes('§'));
    assert.ok(
      await matches('top.ts'),
      '**/*.ts matches a top-level file (globstar spans zero dirs)',
    );
    assert.ok(await matches('a/b/c/deep.ts'), '**/*.ts matches a deep file');
    assert.ok(!(await matches('a/b/c/deep.tsx')), 'the trailing literal still discriminates');
    assert.ok(await matches('x/axc.md'), '? matches one non-slash char');
    assert.ok(!(await matches('x/a/c.md')), '? does not match a slash');
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

describe('rendered guideline block byte caps', () => {
  // Labels, `###` wrappers, separators, and notices are added at render time and
  // are not charged to the per-doc discovery budget — so only the final rendered
  // block can enforce the true output size.
  const docs = Array.from({ length: 40 }, (_, i) => ({
    label: `.pr-governance/design/DOC-${i}.md (§${i})`,
    text: 'x'.repeat(3000),
    relevance: 3 as const,
  }));
  const discovered = { docs, referenced: ['a.md', 'b.md'], budgetExhausted: true };

  it('hard-caps the rendered block at its budget, down to sub-marker caps', () => {
    assert.ok(Buffer.byteLength(formatGuidelines(discovered), 'utf8') <= 96 * 1024);
    // 0/5/30 are smaller than the truncation marker itself — still never exceeded.
    for (const cap of [24 * 1024, 30, 5, 0]) {
      const out = formatFinderGuidelines(discovered, { capBytes: cap });
      assert.ok(Buffer.byteLength(out, 'utf8') <= cap, `finder <= ${cap}`);
    }
  });
});
