import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderOrphanedSection, condenseSummary } from '../src/shared/report.ts';
import type { Finding } from '../src/shared/types.ts';

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
  assert.equal(out.split('\n').length, 2);
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

test('condenseSummary keeps repeated category headers across shards (no misattribution)', () => {
  const out = condenseSummary([
    '**Changes**\n- A\n**Bugs**\n- B1',
    '**Changes**\n- C\n**Bugs**\n- B2',
  ]);
  const lines = out.split('\n');
  // Headers are not bullets, so they are never deduped across shards.
  assert.equal(lines.filter((l) => l === '**Changes**').length, 2);
  assert.equal(lines.filter((l) => l === '**Bugs**').length, 2);
  // Each bullet stays under its own header; `- C` is a Change, not a Bug.
  assert.match(out, /\*\*Changes\*\*\n- A/);
  assert.match(out, /\*\*Changes\*\*\n- C/);
  assert.match(out, /\*\*Bugs\*\*\n- B1/);
  assert.match(out, /\*\*Bugs\*\*\n- B2/);
});

test('condenseSummary prunes a category header left empty by cross-shard dedup', () => {
  // Shard 2 repeats the same `- A` under **Changes**; the bullet is deduped,
  // which would otherwise leave shard 2's **Changes** header with nothing below.
  const out = condenseSummary(['**Changes**\n- A\n**Bugs**\n- B', '**Changes**\n- A']);
  assert.equal(out.split('\n').filter((l) => l === '**Changes**').length, 1);
  assert.match(out, /\*\*Changes\*\*\n- A/);
  assert.match(out, /\*\*Bugs\*\*\n- B/);
  // No trailing empty header left dangling.
  assert.doesNotMatch(out, /\*\*Changes\*\*\s*$/);
});
