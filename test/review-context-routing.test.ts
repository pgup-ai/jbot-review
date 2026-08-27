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
      '    rules: [TS-16.2, TS-1]',
    ].join('\n'),
  );
  writeFileSync(join(root, '.pr-governance/design/SEAMS.md'), '# Seams\nrouted whole doc body');
  const filler = `\n${'padding line to push later sections past the 24 KB cap. '.repeat(40)}`;
  writeFileSync(
    join(root, '.pr-governance/design/TECHNICAL_STANDARDS.md'),
    [
      '# Technical Standards',
      '## 1. Money and decimal types',
      `body of section one${filler.repeat(12)}`,
      '## 2. Something else',
      `body two${filler.repeat(12)}`,
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

    // The whole (large) file is not also loaded — the sections stand in for it.
    assert.ok(!docs.some((d) => d.label.endsWith('TECHNICAL_STANDARDS.md')));
    // A routed `docs:` entry loads whole.
    assert.ok(docs.some((d) => d.label.endsWith('SEAMS.md')));
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
