import assert from 'node:assert/strict';
import { it } from 'node:test';

import type { PrFile } from '../src/shared/github.ts';
import { rulesOnlyTestFiles } from '../src/shared/test-tiers.ts';

const on = { enabled: true, autoApprove: false, standaloneCompliance: true };
const code: PrFile = { filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' };
const rulesOnly = (filename: string, patch?: string) =>
  rulesOnlyTestFiles([{ filename, patch }, code], on).has(filename);
const added = '@@ -0,0 +1 @@\n+ok';

it('sends new test files to the guideline pass alone', () => {
  // A new file's hooks only set up its own new tests.
  assert.ok(rulesOnly('src/z.spec.ts', '@@ -0,0 +1 @@\n+beforeEach(() => seed());'));
  for (const filename of [
    'test/y.test.ts',
    'src/users/users.api-spec.ts',
    'pkg/a_test.go',
    'tests/test_a.py',
    'spec/a_spec.rb',
    'core/src/test/java/a/FooTest.java',
  ])
    assert.ok(rulesOnly(filename, added), filename);
});

it('keeps existing test files, patchless files and non-test files in the main review', () => {
  // A plain appended case looks like an appended hook, mock or skip wrapper to a line scan.
  assert.ok(
    !rulesOnly('test/y.test.ts', "@@ -3,2 +3,3 @@\n describe('a', () => {\n+  it('b');\n });"),
  );
  assert.ok(
    !rulesOnly('test/y.test.ts', '@@ -1,2 +1,2 @@\n-expect(a).toBe(1);\n+expect(a).toBe(2);'),
  );
  assert.ok(!rulesOnly('test/y.test.ts', '@@ -1,2 +0,0 @@\n-a\n-b'));
  assert.ok(!rulesOnly('src/x.spec.ts'));
  // Helpers, fixtures and config under a test dir are not test cases.
  for (const filename of [
    'spec/openapi.yaml',
    'src/api-spec.ts',
    'test/helpers/db.ts',
    'test/fixtures/accounts.ts',
    'test/jest.config.ts',
  ])
    assert.ok(!rulesOnly(filename, added), filename);
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
