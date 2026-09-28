import type { PrFile } from './github.ts';

// Test-case names only, so helpers, fixtures and config under a test dir stay in the main review;
// a catch-all `-spec` would also take `openapi-spec.ts`.
const TEST_FILE =
  /\.(?:(?:api|e2e|int|integration|unit)-)?(?:spec|test)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$|(?:^|\/)src\/test\/.+(?:Test|Tests|IT)\.(?:java|kt)$/;

export function rulesOnlyTestFiles(
  files: PrFile[],
  run: { enabled: boolean; autoApprove: boolean; standaloneCompliance: boolean },
): Set<string> {
  // Auto-approval attests a full main review.
  if (!run.enabled || run.autoApprove || !run.standaloneCompliance) return new Set();
  // Only a new file cannot change how existing tests run: hooks, mocks, fixtures and focus or skip
  // markers added to an existing file all can, in more spellings than a pattern would keep up with.
  const routine = files
    .filter((file) => TEST_FILE.test(file.filename) && file.patch?.startsWith('@@ -0,0 '))
    .map((file) => file.filename);
  // A PR of nothing but new tests keeps its main review.
  return new Set(routine.length < files.length ? routine : []);
}
