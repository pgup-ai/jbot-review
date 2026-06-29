import {
  PATH_PATTERNS,
  diffLineCounts,
  classifyChangeShape,
  isDocOnlyChange,
} from './diff-context.ts';
import type { ChangeShape } from './diff-context.ts';
import { extractChangedExportedSymbols } from './blast-radius.ts';
import { changedFilesIncludeFrontend } from './review-playbooks.ts';
import type { PrFile } from './github.ts';

// Scale recall-supplement fan-out (extra lenses + guideline pass) to diff risk/size.
// The requested config is the ceiling — only ever reduced, never the main review or
// verify (invariants #1/#3). Pure; runner.ts only wires it (#10).

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

// Paths the integrity lens (security/concurrency/data) is for. Concurrency isn't
// a path class — the always-full main pass backstops it.
const INTEGRITY_PATTERNS = [PATH_PATTERNS.security, PATH_PATTERNS.data, PATH_PATTERNS.api];

// `export *` re-exports (`export * from`, `export * as ns from`) change the
// exported surface but carry no symbol name, so the name-based extractor skips
// them — match the diff line directly. `export\s+\*` is re-export-only syntax.
const EXPORT_STAR_LINE = /^[+-]\s*export\s+\*/m;

/**
 * Whether the incremental delta touches the EXPORTED surface — the signal the
 * interactions lens (changed code breaking unchanged callers) keys on. Broader
 * than a plain name extraction: a re-export or a patchless file can change the
 * surface invisibly, so both fail open toward running interactions.
 */
function deltaTouchesExportSurface(files: PrFile[]): boolean {
  // GitHub omits patches for large/binary diffs — content unknown, so fail open.
  if (files.some((file) => file.patch === undefined)) return true;
  if (extractChangedExportedSymbols(files, { includeRemoved: true }).length > 0) return true;
  return files.some((file) => EXPORT_STAR_LINE.test(file.patch ?? ''));
}

export interface IncrementalLensPlan {
  lensKeys: string[];
  guidelinePass: boolean;
}

/**
 * Second, finer fan-out reducer: on a re-review, drop the recall-supplement
 * sessions whose trigger class the INCREMENTAL delta doesn't touch. The main
 * review + verification are never gated (invariants #1/#3); a lens that does run
 * still sees the full diff. `deltaFiles === null` (first review, or a best-effort
 * fetch failure) returns the inputs unchanged — fail toward more coverage.
 */
export function planIncrementalLenses(input: {
  candidateLensKeys: string[];
  guidelinePass: boolean;
  deltaFiles: PrFile[] | null;
}): IncrementalLensPlan {
  const { candidateLensKeys, guidelinePass, deltaFiles } = input;
  if (deltaFiles === null) return { lensKeys: candidateLensKeys, guidelinePass };

  const filenames = deltaFiles.map((file) => file.filename);
  // The ONLY place a lens's incremental trigger is defined; each reuses the
  // shared taxonomy/helpers, never re-declares a path regex.
  const lensTriggered: Record<string, boolean> = {
    interactions: deltaTouchesExportSurface(deltaFiles),
    integrity: filenames.some((name) => INTEGRITY_PATTERNS.some((pattern) => pattern.test(name))),
    frontend: changedFilesIncludeFrontend(filenames),
  };
  // Unknown (future) lens keys are kept — fail toward coverage.
  const lensKeys = candidateLensKeys.filter((key) => lensTriggered[key] ?? true);

  // Written standards can apply to almost any code, so only a test-only or
  // docs-only delta skips the guideline pass; never re-enable one the caller off'd.
  const trivial = classifyChangeShape(deltaFiles).testOnly || isDocOnlyChange(filenames);
  return { lensKeys, guidelinePass: guidelinePass && !trivial };
}
