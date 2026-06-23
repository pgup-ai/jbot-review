import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderOrphanedSection,
  condenseSummary,
  formatSummaryMarkdown,
} from '../src/shared/report.ts';
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
  assert.equal(out, '- a\n- b');
});

test('condenseSummary returns empty output for empty inputs and empty categories', () => {
  assert.equal(condenseSummary([]), '');
  assert.equal(condenseSummary(['']), '');
  assert.equal(condenseSummary(['**Bugs**']), '');
});

test('formatSummaryMarkdown returns empty output for empty input', () => {
  assert.equal(formatSummaryMarkdown(''), '');
});

test('condenseSummary preserves distinct per-file observations', () => {
  const out = condenseSummary(['- `foo.ts` looks correct', '- `bar.ts` looks correct']);
  assert.equal(out.split('\n').length, 2);
});

test('condenseSummary groups repeated category headers across shards', () => {
  const out = condenseSummary([
    '**Changes**\n- A\n**Bugs**\n- B1',
    '**Changes**\n- C\n**Bugs**\n- B2',
  ]);
  const lines = out.split('\n');
  assert.equal(lines.filter((l) => l === '**Changes**').length, 1);
  assert.equal(lines.filter((l) => l === '**Bugs**').length, 1);
  assert.match(out, /\*\*Changes\*\*\n- A/);
  assert.match(out, /\*\*Changes\*\*\n- A\n- C/);
  assert.match(out, /\*\*Bugs\*\*\n- B1/);
  assert.match(out, /\*\*Bugs\*\*\n- B1\n- B2/);
  assert.doesNotMatch(out, /- C\n\*\*Bugs\*\*/);
});

test('condenseSummary groups category headers with colon variants', () => {
  const out = condenseSummary(['**Changes:**\n- A', '**Changes**:\n- B']);
  assert.equal(out, '**Changes:**\n- A\n- B');
});

test('condenseSummary keeps flat shard summaries independent from prior categories', () => {
  const out = condenseSummary(['**Changes**\n- A', '- B']);
  assert.equal(out, '**Changes**\n- A\n\n- B');
});

test('condenseSummary does not carry category state across shard summaries', () => {
  const out = condenseSummary(['**Bugs**\n- P1 found', '- Updates docs']);
  assert.equal(out, '**Bugs**\n- P1 found\n\n- Updates docs');
});

test('condenseSummary groups bold lead-in summary lines with matching headers', () => {
  const out = condenseSummary([
    '**Changes** — Two minimal changes in assigned files:\n- A',
    '**Changes**\n- B',
    '**No bugs found** — Both changes are correct.',
  ]);
  assert.equal(
    out,
    '**Changes**\nTwo minimal changes in assigned files:\n- A\n- B\n\n**No bugs found**\nBoth changes are correct.',
  );
});

test('condenseSummary groups bold lead-in summary lines with en dash separators', () => {
  const out = condenseSummary(['**Changes** – Two minimal changes in assigned files:\n- A']);
  assert.equal(out, '**Changes**\nTwo minimal changes in assigned files:\n- A');
});

test('condenseSummary suppresses no-finding shard verdicts when findings exist', () => {
  const out = condenseSummary(
    [
      [
        '**Changes**',
        '- Pins accounts at creation',
        '',
        '**Bugs**',
        '- Draft completion skips v3 agreement checks',
      ].join('\n'),
      '**Review** No bugs found in assigned files.',
      'No bugs found in the assigned files. The functions handle edge cases consistently.',
    ],
    { suppressNoFindingVerdicts: true },
  );
  assert.equal(
    out,
    '**Changes**\n- Pins accounts at creation\n\n**Bugs**\n- Draft completion skips v3 agreement checks',
  );
});

test('condenseSummary keeps no-finding shard verdicts when no findings exist', () => {
  const out = condenseSummary(['**Review** No bugs found in assigned files.']);
  assert.equal(out, '**Review** No bugs found in assigned files.');
});

test('formatSummaryMarkdown suppresses no-finding sections when findings exist', () => {
  const out = formatSummaryMarkdown(
    [
      '**Changes**',
      '- Updates account pinning',
      '',
      '**No bugs found**',
      'The assigned files look correct.',
      '',
      '**Bugs**',
      '- Draft completion skips v3 checks',
    ].join('\n'),
    { suppressNoFindingVerdicts: true },
  );
  assert.equal(
    out,
    '**Changes**\n- Updates account pinning\n\n**Bugs**\n- Draft completion skips v3 checks',
  );
});

test('formatSummaryMarkdown does not suppress contextual no-bug prose', () => {
  const out = formatSummaryMarkdown('- No bugs were fixed by this documentation-only change.', {
    suppressNoFindingVerdicts: true,
  });
  assert.equal(out, '- No bugs were fixed by this documentation-only change.');
});

test('formatSummaryMarkdown drops review headers left empty by no-finding verdict suppression', () => {
  const out = formatSummaryMarkdown(
    [
      '**Changes**',
      '- Updates account pinning',
      '',
      '**Review**',
      'No bugs found in assigned files.',
      '',
      '**Bugs**',
      '- Draft completion skips v3 checks',
    ].join('\n'),
    { suppressNoFindingVerdicts: true },
  );
  assert.equal(
    out,
    '**Changes**\n- Updates account pinning\n\n**Bugs**\n- Draft completion skips v3 checks',
  );
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

test('formatSummaryMarkdown formats code-like tokens in grouped summaries', () => {
  const out = formatSummaryMarkdown(
    condenseSummary([
      [
        '**Changes**',
        '- Adds integration tests for non-draft REVENUE (INVOICE_SENT) and EXPENSE (BILL_RECEIVED) orders',
        '- Fixes write-business-event.repository.ts to return { version } from updateStageAndEntryStatus',
        '- Uses { entryStatus, invoiceId } for INVOICE_SENT orders',
        '- Makes updateStageAndEntryStatus return { version: version + 1 } instead of void',
        '- Re-enables the skipped test in business-event-object-matches.api-spec.ts',
      ].join('\n'),
    ]),
  );
  assert.match(out, /`REVENUE` \(`INVOICE_SENT`\)/);
  assert.match(out, /`EXPENSE` \(`BILL_RECEIVED`\)/);
  assert.match(out, /`write-business-event\.repository\.ts`/);
  assert.match(out, /`\{ version \}`/);
  assert.match(out, /`\{ entryStatus, invoiceId \}` for `INVOICE_SENT` orders/);
  assert.match(out, /`\{ version: version \+ 1 \}`/);
  assert.match(out, /`updateStageAndEntryStatus`/);
  assert.match(out, /`business-event-object-matches\.api-spec\.ts`/);
});

test('formatSummaryMarkdown does not add nested code spans inside formatted filenames', () => {
  const out = formatSummaryMarkdown('- Updates src/FMS-123.ts for INVOICE_SENT');
  assert.equal(out, '- Updates `src/FMS-123.ts` for `INVOICE_SENT`');
});

test('formatSummaryMarkdown formats dotted member expressions as a single code span', () => {
  const out = formatSummaryMarkdown(
    condenseSummary([
      '- Uses the version from updateOne rather than reloading updatedEvent.version',
    ]),
  );
  assert.equal(
    out,
    '- Uses the version from `updateOne` rather than reloading `updatedEvent.version`',
  );
});

test('formatSummaryMarkdown does not code-span product and protocol proper nouns', () => {
  const out = formatSummaryMarkdown(
    '- Keeps OpenAI, QuickBooks, OAuth, GitHub, TypeScript, iPhone, and macOS readable',
  );
  assert.equal(
    out,
    '- Keeps OpenAI, QuickBooks, OAuth, GitHub, TypeScript, iPhone, and macOS readable',
  );
});

test('condenseSummary dedups raw and already-formatted code-like summary lines before formatting', () => {
  const out = formatSummaryMarkdown(
    condenseSummary([
      '- Fixes write-business-event.repository.ts to return { version }',
      '- Fixes `write-business-event.repository.ts` to return `{ version }`',
    ]),
  );
  assert.equal(out, '- Fixes `write-business-event.repository.ts` to return `{ version }`');
});

test('formatSummaryMarkdown preserves existing links, bare URLs, and code spans', () => {
  const out = formatSummaryMarkdown(
    '- Keeps `alreadyFormatted`, https://example.com/business-events.common.service.ts, and [business-events.common.service.ts](https://example.com/path.ts) untouched while formatting updateOne',
  );
  assert.equal(
    out,
    '- Keeps `alreadyFormatted`, https://example.com/business-events.common.service.ts, and [business-events.common.service.ts](https://example.com/path.ts) untouched while formatting `updateOne`',
  );
});
