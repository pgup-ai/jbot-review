import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { PrFile } from '../src/shared/github.ts';
import { rulesOnlyTestFiles } from '../src/shared/test-tiers.ts';

const on = { enabled: true, autoApprove: false, standaloneCompliance: true };
const code: PrFile = { filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' };
const rulesOnly = (filename: string, patch: string) =>
  rulesOnlyTestFiles([{ filename, patch }, code], on).has(filename);
const appended = (line: string) => `@@ -3,2 +3,3 @@\n describe('a', () => {\n+${line}\n });`;

it('sends new test files and appended cases to the guideline pass alone', () => {
  assert.ok(rulesOnly('src/x.spec.ts', "@@ -0,0 +1,2 @@\n+it('a', () => {});\n+"));
  assert.ok(rulesOnly('test/y.test.ts', appended("  it('b', () => {});")));
  // A new file's hooks only set up its own new tests.
  assert.ok(rulesOnly('src/z.spec.ts', '@@ -0,0 +1 @@\n+beforeEach(() => seed());'));
  for (const filename of [
    'apps/o/src/orders.api-spec.ts',
    'pkg/a_test.go',
    'tests/test_a.py',
    'spec/a_spec.rb',
  ])
    assert.ok(rulesOnly(filename, '@@ -0,0 +1 @@\n+ok'), filename);
});

it('keeps edits, deletions and additions that change existing tests in the main review', () => {
  assert.ok(
    !rulesOnly('test/y.test.ts', '@@ -1,2 +1,2 @@\n-expect(a).toBe(1);\n+expect(a).toBe(2);'),
  );
  assert.ok(!rulesOnly('test/y.test.ts', '@@ -1,2 +0,0 @@\n-a\n-b'));
  // A removed SQL comment reads `--- old`, which diffLineCounts skips as a file header.
  assert.ok(!rulesOnly('test/q.sql', '@@ -1,2 +1 @@\n--- old\n keep'));
  for (const line of [
    "  it.only('b', () => {});",
    'beforeEach(() => {});',
    "jest.mock('x');",
    '  @BeforeEach',
  ])
    assert.ok(!rulesOnly('test/y.test.ts', appended(line)), line);
  for (const filename of ['spec/openapi.yaml', 'src/api-spec.ts'])
    assert.ok(!rulesOnly(filename, '@@ -0,0 +1 @@\n+ok'), filename);
});

it('returns no files unless the flag is on, auto-approval is off and the guideline pass runs', () => {
  const test: PrFile = { filename: 'src/x.spec.ts', patch: '@@ -0,0 +1 @@\n+it()' };
  for (const run of [
    { ...on, enabled: false },
    { ...on, autoApprove: true },
    { ...on, standaloneCompliance: false },
  ])
    assert.equal(rulesOnlyTestFiles([test, code], run).size, 0);
  assert.equal(rulesOnlyTestFiles([test], on).size, 0);
});
