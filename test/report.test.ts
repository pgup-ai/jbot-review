import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  categoryOf,
  groupFindingsByCategory,
  renderGroupedFindingIndex,
  renderOrphanedSection,
  condenseSummary,
} from '../src/shared/report.ts';
import type { Finding, FindingKind } from '../src/shared/types.ts';

function f(overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'src/a.ts',
    line: 10,
    severity: 'P2',
    kind: 'bug',
    confidence: 'high',
    title: 'Something',
    body: 'Because reasons.',
    ...overrides,
  };
}

test('categoryOf maps kinds to coarse buckets, defaults to Other', () => {
  const cases: [FindingKind | undefined, string][] = [
    ['bug', 'Correctness'],
    ['security', 'Correctness'],
    ['performance', 'Correctness'],
    ['architecture', 'Design & architecture'],
    ['maintainability', 'Design & architecture'],
    ['test', 'Tests'],
    ['docs', 'Docs'],
    ['investigate', 'Other'],
    [undefined, 'Other'],
  ];
  for (const [kind, expected] of cases) {
    assert.equal(categoryOf({ kind }), expected);
  }
});

test('groupFindingsByCategory orders groups, omits empty, sorts by severity within', () => {
  const groups = groupFindingsByCategory([
    f({ kind: 'docs', severity: 'P3', title: 'd1' }),
    f({ kind: 'bug', severity: 'P2', title: 'b2' }),
    f({ kind: 'bug', severity: 'P0', title: 'b0' }),
    f({ kind: 'architecture', severity: 'P1', title: 'a1' }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.category),
    ['Correctness', 'Design & architecture', 'Docs'],
  );
  // Within Correctness, P0 sorts before P2.
  assert.deepEqual(
    groups[0].findings.map((x) => x.title),
    ['b0', 'b2'],
  );
});

test('renderGroupedFindingIndex returns nothing for short lists', () => {
  const findings = Array.from({ length: 4 }, (_, i) => f({ title: `t${i}` }));
  assert.deepEqual(renderGroupedFindingIndex(findings), []);
});

test('renderGroupedFindingIndex returns nothing when all one category', () => {
  const findings = Array.from({ length: 6 }, (_, i) => f({ kind: 'bug', title: `t${i}` }));
  assert.deepEqual(renderGroupedFindingIndex(findings), []);
});

test('renderGroupedFindingIndex groups a long, multi-category list', () => {
  const findings: Finding[] = [
    f({ kind: 'bug', severity: 'P1', title: 'Null deref', path: 'src/x.ts', line: 5 }),
    f({ kind: 'security', severity: 'P0', title: 'SQL injection', path: 'src/y.ts', line: 9 }),
    f({ kind: 'bug', severity: 'P2', title: 'Off by one', path: 'src/z.ts', line: 3 }),
    f({ kind: 'docs', severity: 'P3', title: 'Stale comment', path: 'README.md', line: 0 }),
    f({ kind: 'architecture', severity: 'P2', title: 'Dup helper', path: 'src/w.ts', line: 7 }),
  ];
  const lines = renderGroupedFindingIndex(findings);
  const text = lines.join('\n');

  assert.equal(lines[0], '### Findings by category');
  // Correctness has 3 (two bugs + one security), and appears before others.
  assert.match(text, /\*\*Correctness\*\* \(3\)/);
  assert.match(text, /\*\*Design & architecture\*\* \(1\)/);
  assert.match(text, /\*\*Docs\*\* \(1\)/);
  assert.ok(
    text.indexOf('Correctness') < text.indexOf('Design & architecture'),
    'Correctness before Design',
  );
  // Severity sort inside Correctness: P0 security before the P1/P2 bugs.
  assert.ok(text.indexOf('SQL injection') < text.indexOf('Null deref'));
  // Index line carries severity, kind/confidence, title, and clickable location.
  assert.match(text, /- \*\*P0 \(security, high\)\*\* SQL injection — `src\/y\.ts:9`/);
  // File-level finding (line 0) renders just the path.
  assert.match(text, /Stale comment — `README\.md`/);
  // No trailing blank line.
  assert.notEqual(lines[lines.length - 1], '');
});

test('renderOrphanedSection: lists outside-diff findings flat with bodies', () => {
  const lines = renderOrphanedSection([
    f({ title: 'Outside one', body: 'b1', path: 'src/o.ts', line: 2 }),
    f({ title: 'Outside two', body: 'b2', path: 'src/o.ts', line: 4 }),
  ]);
  assert.equal(lines[0], '### Findings (outside the diff)');
  const text = lines.join('\n');
  assert.match(text, /- \*\*P2 \(bug, high\)\*\* Outside one — `src\/o\.ts:2`/);
  assert.match(text, /\n {2}b1/);
});

test('renderOrphanedSection: stays flat even when long (no category headers)', () => {
  const orphaned: Finding[] = [
    f({ kind: 'bug', title: 'b1', body: 'x' }),
    f({ kind: 'bug', title: 'b2', body: 'x' }),
    f({ kind: 'bug', title: 'b3', body: 'x' }),
    f({ kind: 'docs', title: 'd1', body: 'x' }),
    f({ kind: 'docs', title: 'd2', body: 'x' }),
  ];
  const text = renderOrphanedSection(orphaned).join('\n');
  assert.doesNotMatch(text, /\*\*Correctness\*\*/);
  assert.match(text, /\n {2}x/); // bodies retained
});

test('renderOrphanedSection: empty input yields no section', () => {
  assert.deepEqual(renderOrphanedSection([]), []);
});

test('condenseSummary drops verbatim duplicate bullets across shards', () => {
  const out = condenseSummary([
    '- Adds retry logic\n- No blocking issues found',
    '- Refreshes the lockfile\n- No blocking issues found',
  ]);
  assert.equal(out.split('\n').filter((l) => /no blocking issues found/i.test(l)).length, 1);
  assert.match(out, /Adds retry logic/);
  assert.match(out, /Refreshes the lockfile/);
});

test('condenseSummary dedups case- and spacing-insensitively, keeps distinct lines', () => {
  const out = condenseSummary([
    '-  No   Blocking Issues',
    '- no blocking issues',
    '- Real finding',
  ]);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.match(out, /Real finding/);
});

test('condenseSummary collapses blank runs and trims trailing blanks', () => {
  const out = condenseSummary(['- a\n\n\n- b', '\n']);
  assert.equal(out, '- a\n\n- b');
});

test('condenseSummary preserves distinct per-file observations', () => {
  const out = condenseSummary(['- `foo.ts` looks correct', '- `bar.ts` looks correct']);
  assert.equal(out.split('\n').length, 2);
});
