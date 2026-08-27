import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractRuleSection,
  parseDiffRoutes,
  parseRuleIdDocs,
  selectDiffRoutes,
  splitRuleId,
} from '../src/shared/review-routing.ts';

// Synthetic fixtures mirroring the schema/heading shape — no repo content.
const ROUTES_YAML = `version: 1
entries:
  - name: inline-entry
    paths: ['apps/api/src/**']
    docs: ['design/SEAMS.md']
    rules: [INV-2]
  - name: multiline-entry
    paths:
      [
        'libs/mod/**',
        'apps/core/src/thing.service.ts',
      ]
    docs: ['design/INVARIANTS.md', 'design/CONTRACTS.md']
    rules: [INV-17, TS-16.2]
  - name: no-docs
    paths: ['**/*.spec.ts']
    rules: [TS-6, TS-6.2]
`;

describe('parseDiffRoutes', () => {
  it('parses inline and multi-line bracket lists and unquoted rule ids', () => {
    const routes = parseDiffRoutes(ROUTES_YAML);
    assert.equal(routes.length, 3);
    assert.deepEqual(routes[0], {
      name: 'inline-entry',
      paths: ['apps/api/src/**'],
      docs: ['design/SEAMS.md'],
      rules: ['INV-2'],
    });
    assert.deepEqual(routes[1].paths, ['libs/mod/**', 'apps/core/src/thing.service.ts']);
    assert.deepEqual(routes[1].rules, ['INV-17', 'TS-16.2']);
    assert.deepEqual(routes[2].docs, []); // absent list → empty, not an error
  });

  it('keeps a brace-set glob whole and parses CRLF input', () => {
    const routes = parseDiffRoutes(
      "entries:\r\n  - name: x\r\n    paths: ['**/*.{ts,tsx}', 'a/**']\r\n",
    );
    assert.deepEqual(routes[0].paths, ['**/*.{ts,tsx}', 'a/**']);
  });

  it('fails safe (empty) on malformed, entry-less, or oversized input', () => {
    assert.deepEqual(parseDiffRoutes('not: yaml\n'), []);
    assert.deepEqual(parseDiffRoutes(''), []);
    assert.deepEqual(parseDiffRoutes(`entries:\n${'#'.repeat(70 * 1024)}`), []);
  });
});

describe('parseRuleIdDocs', () => {
  it('maps a rule-id prefix to its doc across both README phrasings', () => {
    // Both conventions exist in the wild: fms uses `— sections of`, fms-frontend `maps to`.
    const readme = [
      '## Rule IDs',
      '- `INV-<n>` — sections of `design/INVARIANTS.md`, for example `INV-9.1`',
      '- `TS-<n>` maps to `design/TECHNICAL_STANDARDS.md`, for example `TS-13.1`',
    ].join('\n');
    const map = parseRuleIdDocs(readme);
    assert.equal(map.get('INV'), 'design/INVARIANTS.md');
    assert.equal(map.get('TS'), 'design/TECHNICAL_STANDARDS.md'); // not the trailing `TS-13.1`
  });
});

describe('splitRuleId', () => {
  it('splits a prefixed section id and rejects non-ids', () => {
    assert.deepEqual(splitRuleId('TS-16.2'), { prefix: 'TS', section: '16.2' });
    assert.deepEqual(splitRuleId('INV-9'), { prefix: 'INV', section: '9' });
    assert.equal(splitRuleId('not-an-id'), undefined);
    assert.equal(splitRuleId('TS-'), undefined);
    // An absurdly long dotted id is rejected, so it can't bloat a label or note.
    assert.equal(splitRuleId(`TS-${'1.'.repeat(2000)}1`), undefined);
  });
});

describe('selectDiffRoutes', () => {
  it('unions docs and rule ids of every route matching a changed file', () => {
    const matches = (glob: string, file: string) =>
      new RegExp('^' + glob.replace(/\*\*/g, '.*').replace(/(?<!\.)\*/g, '[^/]*') + '$').test(file);
    const { docs, ruleIds } = selectDiffRoutes(
      parseDiffRoutes(ROUTES_YAML),
      ['libs/mod/x.ts'],
      matches,
    );
    assert.deepEqual(docs, ['design/INVARIANTS.md', 'design/CONTRACTS.md']);
    assert.deepEqual(ruleIds, ['INV-17', 'TS-16.2']);

    const none = selectDiffRoutes(parseDiffRoutes(ROUTES_YAML), ['README.md'], matches);
    assert.deepEqual(none, { docs: [], ruleIds: [] });
  });
});

describe('extractRuleSection', () => {
  const doc = [
    '# Technical Standards',
    '## 6. Test helpers', // nested: `###` children
    'whole-number section body',
    '### 6.2 Placement',
    'subsection body',
    '## 16. AI', // flat: `##` "children"
    'ai body',
    '## 16.2 Parity',
    'parity body',
    '## 17. Repository',
    'seventeen body',
  ].join('\n');

  it('extracts a section bounded by heading level, not number', () => {
    // Nested: a `##` section keeps its deeper `###` children, stops at the next `##`.
    const whole = extractRuleSection(doc, '6')!;
    assert.match(whole, /^## 6\. Test helpers[\s\S]*### 6\.2 Placement/);
    assert.ok(!whole.includes('## 16. AI'));
    assert.equal(extractRuleSection(doc, '6.2'), '### 6.2 Placement\nsubsection body');
    // Flat: `## 16` and `## 16.2` are siblings — §16 must NOT swallow §16.2, or a
    // route citing both TS-16 and TS-16.2 would duplicate the body.
    assert.equal(extractRuleSection(doc, '16'), '## 16. AI\nai body');
    assert.equal(extractRuleSection(doc, '16.2'), '## 16.2 Parity\nparity body');
    assert.equal(extractRuleSection(doc, '99'), undefined);
  });
});
