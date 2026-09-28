import type { PrFile } from './github.ts';

// Test-case names only, so helpers, fixtures and config under a test dir stay in the main review;
// a catch-all `-spec` would also take `openapi-spec.ts`.
const TEST_FILE =
  /\.(?:(?:api|e2e|int|integration|unit)-)?(?:spec|test)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$|(?:^|\/)src\/test\/.+(?:Test|Tests|IT)\.(?:java|kt)$/;
// Added lines that change how a file's existing tests run: focus, setup/teardown, module mocks.
const RISKY_ADDITION =
  /^\+.*(?:\b(?:describe|context|it|test)(?:\.only\b|\[\s*['"]only['"]\s*\])|(?<![\w.])f(?:describe|context|it|example|specify)\b|\bfocus:\s*true\b|,\s*:focus\b|\b(?:before|after|around)(?:Each|All)?\s*(?:\(|\{|do\b)|\blet!\s*[({]|@(?:Before|After)(?:Each|All|Class)?\b|\bdef (?:setUp|tearDown|setup_|teardown_)\w*\s*\(|autouse\s*=\s*True|\bfunc TestMain\s*\(|\b(?:jest|vi)\.(?:mock|doMock)\s*\()/m;

function routineTest(file: PrFile): boolean {
  const patch = file.patch;
  // Patches are header-free, so any leading '-' is a removed line; diffLineCounts skips `-- ` content.
  if (!patch || !TEST_FILE.test(file.filename) || /^-/m.test(patch)) return false;
  return patch.startsWith('@@ -0,0 ') || !RISKY_ADDITION.test(patch);
}

export function rulesOnlyTestFiles(
  files: PrFile[],
  run: { enabled: boolean; autoApprove: boolean; standaloneCompliance: boolean },
): Set<string> {
  // Auto-approval attests a full main review.
  if (!run.enabled || run.autoApprove || !run.standaloneCompliance) return new Set();
  const routine = files.filter(routineTest).map((file) => file.filename);
  // A PR of nothing but new tests keeps its main review.
  return new Set(routine.length < files.length ? routine : []);
}
