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

function routedDocs(docs: Array<{ label: string; text: string; relevance: number }>): Array<{
  label: string;
  text: string;
  relevance: number;
}> {
  return docs.filter((doc) => doc.label.includes('TECHNICAL_STANDARDS.md'));
}

describe('discoverGuidelineDocs with diff routing', () => {
  const roots: string[] = [];
  after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

  it('loads matched rule sections (past the file cap) instead of the whole doc', async () => {
    const root = buildGovernanceRepo();
    roots.push(root);
    const { docs } = await discoverGuidelineDocs(root, ['apps/core/src/thing.service.ts']);

    const tsSections = routedDocs(docs);
    const text = tsSections.map((doc) => doc.text).join('\n');
    const labels = tsSections.map((doc) => doc.label).join('\n');
    assert.match(text, /THE-SERVICE-PARITY-RULE/, '§16.2 is included despite its offset');
    assert.match(labels, /§16\.2/);
    assert.ok(
      tsSections.every((doc) => doc.relevance === 3),
      'routed sections rank scoped',
    );
    // §6.1 is nested under the also-cited §6, so it appears once (deduped), not twice.
    assert.equal(text.match(/NESTED-CHILD-MARKER/g)?.length, 1);
    assert.ok(!labels.includes('§6.1'), 'the deduped child is not named in the label');

    // The whole (large) file is not also loaded — the sections stand in for it.
    assert.ok(!docs.some((d) => d.label.endsWith('TECHNICAL_STANDARDS.md')));
    // A routed `docs:` entry loads whole.
    assert.ok(docs.some((d) => d.label.endsWith('SEAMS.md')));
  });

  it('gives every oversized matched section a prefix and names partial sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-cap-'));
    roots.push(root);
    const sections = Array.from({ length: 8 }, (_, index) => index + 1);
    writeRoutedRepo(root, {
      rules: sections.map((section) => `TS-${section}`).join(', '),
      doc: sections
        .flatMap((section) => [
          `## ${section}. Section`,
          `SECTION-${section}-MARKER`,
          'x'.repeat(8000),
        ])
        .join('\n'),
    });
    const text = routedDocs((await discoverGuidelineDocs(root, ['x/a.ts'])).docs)
      .map((doc) => doc.text)
      .join('\n');
    for (const section of sections) assert.match(text, new RegExp(`SECTION-${section}-MARKER`));
    assert.match(text, /Omitted from this bundle[\s\S]*partially loaded/);
  });

  it('names a cited section absent from the source instead of dropping it silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-missing-'));
    roots.push(root);
    writeRoutedRepo(root, { rules: 'TS-1, TS-9', doc: '## 1. First\nSECTION-ONE' });
    const sections = routedDocs((await discoverGuidelineDocs(root, ['x/a.ts'])).docs);
    const text = sections.map((doc) => doc.text).join('\n');
    assert.match(text, /SECTION-ONE/);
    assert.match(text, /§9 \(not found\)/, 'the absent cited section is disclosed');
    assert.ok(!sections.some((doc) => doc.label.includes('§9')));
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
    const sections = routedDocs(
      (
        await discoverGuidelineDocs(root, [
          'apps/really/deep/nested/dir/component.tsx',
          'libs/y.ts',
        ])
      ).docs,
    );
    const text = sections.map((doc) => doc.text).join('\n');
    assert.match(text, /SECTION-ONE/, 'apps/** matched via TS-1');
    assert.match(text, /SECTION-TWO/, 'libs/** matched via TS-2 after the scratch grew');
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
    const sections = routedDocs((await discoverGuidelineDocs(root, ['x/a.ts'])).docs);
    const text = sections.map((doc) => doc.text).join('\n');
    assert.match(text, /partially loaded/, 'the truncation is disclosed');
    assert.ok(
      sections.reduce((total, doc) => total + Buffer.byteLength(doc.text, 'utf8'), 0) <= 24 * 1024,
      'body plus the truncation note stays within the per-file cap',
    );
  });

  it('discloses a section cut by the bounded source read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-source-cap-'));
    roots.push(root);
    const target = '## 2. Target\nTARGET-BODY-CONTINUES';
    const prefix = '## 1. Filler\n';
    const targetOffset = 512 * 1024 - 24;
    writeRoutedRepo(root, {
      rules: 'TS-2',
      doc: `${prefix}${'x'.repeat(targetOffset - prefix.length - 1)}\n${target}${'z'.repeat(100)}`,
    });

    const text = routedDocs((await discoverGuidelineDocs(root, ['x/a.ts'])).docs)
      .map((doc) => doc.text)
      .join('\n');
    assert.match(text, /## 2\. Target/);
    assert.match(text, /§2 \(source read truncated\)/);
  });

  it('does not falsely truncate a section that fits under the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-fits-'));
    roots.push(root);
    const heading = '## 1. Fits\n';
    const body = 'x'.repeat(24 * 1024 - Buffer.byteLength(heading));
    writeRoutedRepo(root, { rules: 'TS-1', doc: `${heading}${body}` });
    const sections = routedDocs((await discoverGuidelineDocs(root, ['x/a.ts'])).docs);
    const text = sections.map((doc) => doc.text).join('\n');
    assert.ok(!text.includes('partially loaded'), 'a fitting section is not marked partial');
    assert.equal(text.match(/x/g)?.length, body.length, 'the full body is present');
  });

  it('byte-bounds the omission note when a route cites hundreds of unavailable sections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-note-'));
    roots.push(root);
    const many = Array.from({ length: 400 }, (_, i) => `TS-${i + 100}`).join(', ');
    writeRoutedRepo(root, { rules: `TS-1, ${many}`, doc: '## 1. First\nSECTION-ONE' });
    const sections = routedDocs((await discoverGuidelineDocs(root, ['x/a.ts'])).docs);
    const text = sections.map((doc) => doc.text).join('\n');
    assert.match(text, /SECTION-ONE/);
    assert.match(text, /\+\d+ more/, 'the list is capped with a +N more summary');
    assert.ok(Buffer.byteLength(text, 'utf8') < 2048, 'the note cannot balloon to hundreds of ids');
  });

  it('gives each routed document and explicit doc a finder fragment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jbot-fair-'));
    roots.push(root);
    const ids = Array.from({ length: 26 }, (_, index) => `R${index}`);
    mkdirSync(join(root, '.pr-governance/review'), { recursive: true });
    mkdirSync(join(root, '.pr-governance/design'), { recursive: true });
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(
      join(root, '.pr-governance/README.md'),
      ['## Rule IDs', ...ids.map((id) => `- \`${id}-<n>\` maps to \`design/${id}.md\``)].join('\n'),
    );
    const routingPath = join(root, '.pr-governance/review/rules-for-diff.yaml');
    const writeRouting = (ruleIds: string[]) =>
      writeFileSync(
        routingPath,
        `entries:\n  - name: all\n    paths: ['x/**']\n    docs: ['docs/EXPLICIT.md']\n    rules: [${ruleIds.map((id) => `${id}-1`).join(', ')}]`,
      );
    writeRouting([...ids].reverse());
    for (const id of ids) {
      writeFileSync(
        join(root, `.pr-governance/design/${id}.md`),
        `## 1. ${id}\n${id}-ROUTED-MARKER\n${id.toLowerCase().repeat(40 * 1024)}`,
      );
    }
    writeFileSync(join(root, 'docs/EXPLICIT.md'), '# Explicit\nEXPLICIT-DOC-MARKER');

    const discovered = await discoverGuidelineDocs(root, ['x/a.ts']);
    const finder = formatFinderGuidelines(discovered);

    assert.ok(discovered.budgetExhausted, 'fixture reaches the candidate cap');
    assert.match(finder, /EXPLICIT-DOC-MARKER/);
    for (const marker of discovered.docs.flatMap(
      (doc) => doc.text.match(/R\d+-ROUTED-MARKER/g) ?? [],
    ))
      assert.match(finder, new RegExp(marker));
    assert.ok(Buffer.byteLength(finder, 'utf8') <= 24 * 1024);

    writeRouting(ids);
    assert.equal(formatFinderGuidelines(await discoverGuidelineDocs(root, ['x/a.ts'])), finder);
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
