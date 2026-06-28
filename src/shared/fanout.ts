import { PATH_PATTERNS, diffLineCounts } from './diff-context.ts';
import type { ChangeShape } from './diff-context.ts';
import type { PrFile } from './github.ts';

// Scale recall-supplement fan-out (extra lenses + the guideline pass) to a
// diff's risk and size. The requested config is the ceiling: this only reduces
// it for provably-low-risk diffs, and never the main review or verification
// (invariants #1/#3). Pure — runner.ts only wires it (invariant #10).

const SENSITIVE_PATTERNS = [
  PATH_PATTERNS.security,
  PATH_PATTERNS.data,
  PATH_PATTERNS.api,
  PATH_PATTERNS.infra,
  PATH_PATTERNS.tooling,
];

const MINIMAL_FANOUT_MAX_FILES = 3;
const MINIMAL_FANOUT_MAX_ADDED_LINES = 60;

export interface FanoutPlan {
  reviewPasses: number;
  guidelinePass: boolean;
  tier: 'minimal' | 'full';
  /** Why fan-out was reduced (for the run log); '' when unchanged. */
  reason: string;
}

export function planReviewFanout(input: {
  requestedPasses: number;
  requestedGuidelinePass: boolean;
  files: PrFile[];
  shape: ChangeShape;
}): FanoutPlan {
  const { requestedPasses, requestedGuidelinePass, files, shape } = input;
  const added = diffLineCounts(files).added;
  const sensitive = files.some((file) =>
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(file.filename)),
  );
  const lowRisk =
    !sensitive &&
    !shape.dependencyManifestChange &&
    !shape.largeDeletion &&
    files.length <= MINIMAL_FANOUT_MAX_FILES &&
    added <= MINIMAL_FANOUT_MAX_ADDED_LINES;

  if (!lowRisk) {
    return {
      reviewPasses: requestedPasses,
      guidelinePass: requestedGuidelinePass,
      tier: 'full',
      reason: '',
    };
  }
  return {
    reviewPasses: Math.min(requestedPasses, 1),
    guidelinePass: false,
    tier: 'minimal',
    reason: `low-risk diff (${files.length} files, +${added} lines, no sensitive paths)`,
  };
}
