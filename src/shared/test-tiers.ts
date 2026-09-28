import { TEST_ONLY_FILE } from './diff-context.ts';
import type { PrFile } from './github.ts';

// Test names TEST_ONLY_FILE misses outside test dirs; a catch-all `-spec` would take `openapi-spec.ts`.
const TEST_SUFFIX =
  /\.(?:api|e2e|int|integration|unit)-(?:spec|test)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$|_spec\.rb$/;
// Added lines that change how a file's existing tests run: focus, setup/teardown, module mocks.
const RISKY_ADDITION =
  /^\+.*(?:\b(?:describe|it|test)\.only\s*\(|(?<![\w.])f(?:describe|it)\s*\(|\b(?:before|after)(?:Each|All)\s*\(|@(?:Before|After)(?:Each|All|Class)?\b|\bdef (?:setUp|tearDown)(?:Class)?\s*\(|autouse\s*=\s*True|\bfunc TestMain\s*\(|\b(?:jest|vi)\.(?:mock|doMock)\s*\()/m;

function routineTest(file: PrFile): boolean {
  if (!TEST_ONLY_FILE.test(file.filename) && !TEST_SUFFIX.test(file.filename)) return false;
  const patch = file.patch ?? '';
  // Patches are header-free, so any leading '-' is a removed line; diffLineCounts skips `-- ` content.
  if (/^-/m.test(patch)) return false;
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
