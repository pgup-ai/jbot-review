import type { Finding, FindingConfidence, FindingVerdict, Severity } from './types.ts';

/** Drops noise files (lockfiles, generated, minified) before the agent sees them. */
const NOISE_FILENAMES = new Set<string>([
  'bun.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
]);
const NOISE_EXTENSIONS = ['.min.js', '.min.css', '.bundle.js', '.map'];
const NOISE_PATH_SEGMENTS = ['node_modules/', 'dist/', 'vendor/', '/generated/'];

export function isNoiseFile(filename: string): boolean {
  const base = filename.split('/').pop() ?? filename;
  if (NOISE_FILENAMES.has(base)) return true;
  if (NOISE_EXTENSIONS.some((ext) => filename.endsWith(ext))) return true;
  if (NOISE_PATH_SEGMENTS.some((seg) => filename.includes(seg))) return true;
  return false;
}

export const SEVERITY_RANK: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  nit: 4,
};

const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2']);

const CONFIDENCE_RANK: Record<FindingConfidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * Strength of a finding for collision resolution: lower is stronger. Compares
 * by severity first, then confidence (an absent confidence ranks as medium).
 */
function findingStrength(finding: Finding): [number, number] {
  const confidence = finding.confidence
    ? CONFIDENCE_RANK[finding.confidence]
    : CONFIDENCE_RANK.medium;
  return [SEVERITY_RANK[finding.severity], confidence];
}

/**
 * Merges findings from multiple review sessions, keeping one finding per
 * issue. Line-anchored findings collide on exact path:line; file-level
 * (line-0) findings have no distinguishing line, so they collide only when
 * their titles describe the same issue — two DIFFERENT absence findings on
 * the same file must both survive. On a collision the STRONGEST finding
 * wins — more severe first, then higher confidence — with ties broken by
 * input order, so passing the main review first keeps its richer context.
 * Apply the confidence gate (demoteLowConfidenceBlockingFindings) BEFORE
 * this so each finding's effective severity is settled and a low-confidence
 * finding cannot out-rank a stronger one at the same location.
 */
export function dedupeFindings(...findingLists: Finding[][]): Finding[] {
  const kept: Finding[] = [];
  for (const findings of findingLists) {
    for (const finding of findings) {
      const existingIndex = kept.findIndex((existing) => isSameAnchor(existing, finding));
      if (existingIndex === -1) {
        kept.push(finding);
        continue;
      }
      const [existingSeverity, existingConfidence] = findingStrength(kept[existingIndex]);
      const [nextSeverity, nextConfidence] = findingStrength(finding);
      // Replace only when strictly stronger; equal strength keeps the earlier
      // (main-review-first) finding.
      if (
        nextSeverity < existingSeverity ||
        (nextSeverity === existingSeverity && nextConfidence < existingConfidence)
      ) {
        kept[existingIndex] = finding;
      }
    }
  }
  return kept;
}

function isSameAnchor(a: Finding, b: Finding): boolean {
  if (a.path !== b.path) return false;
  if (a.line > 0 || b.line > 0) return a.line === b.line;
  const titleMatch = titleTokenMatch(a.title, b.title);
  return (
    titleMatch.shared >= FILE_LEVEL_DEDUPE_MIN_SHARED_TOKENS &&
    titleMatch.overlap >= FILE_LEVEL_DEDUPE_TITLE_OVERLAP
  );
}

/**
 * Symmetric significant-word overlap between two titles, in [0, 1]. Returns
 * 0 when either title has no significant words, so content-blind matching
 * never merges findings it cannot actually compare.
 */
function titleTokenMatch(titleA: string, titleB: string): { overlap: number; shared: number } {
  const tokensA = significantTokens(titleA);
  const tokensB = new Set(significantTokens(titleB));
  if (tokensA.length === 0 || tokensB.size === 0) return { overlap: 0, shared: 0 };
  const shared = tokensA.filter((token) => tokensB.has(token)).length;
  return { overlap: shared / Math.min(tokensA.length, tokensB.size), shared };
}

/**
 * A previously posted jbot-review thread, reduced to what duplicate
 * suppression needs. Matches the shape of PriorJbotThread without importing
 * the GitHub layer into this pure module.
 */
export interface PriorFindingRef {
  path: string;
  line?: number;
  body: string;
  /**
   * Resolved threads never suppress: resolution means the issue was fixed,
   * so re-detecting it at the same location signals a regression or an
   * incomplete fix that MUST be re-reported.
   */
  isResolved?: boolean;
}

const SUPPRESS_LINE_TOLERANCE = 3;
const SUPPRESS_TITLE_OVERLAP = 0.5;
const FILE_LEVEL_DEDUPE_TITLE_OVERLAP = 0.5;
const FILE_LEVEL_DEDUPE_MIN_SHARED_TOKENS = 2;

/**
 * Drops findings that re-report an issue an existing jbot-review thread
 * already covers. This is the in-code backstop that makes full-diff
 * re-review safe: every run re-reads the whole PR (so nothing is missed),
 * and repeats are filtered here instead of by narrowing the model's scope.
 *
 * A finding is suppressed only when BOTH hold, keeping the filter
 * conservative (a genuinely new bug near an old comment must survive):
 * - location match: same path and within ±3 lines of the thread anchor
 *   (file-level findings match file-level threads), and
 * - content match: at least half of the finding title's significant words
 *   appear in the prior thread's comment body.
 */
export function suppressPreviouslyReported(
  findings: Finding[],
  priorThreads: PriorFindingRef[],
): { findings: Finding[]; suppressedCount: number } {
  if (priorThreads.length === 0) return { findings, suppressedCount: 0 };

  const kept = findings.filter(
    (finding) => !priorThreads.some((thread) => isSameIssue(finding, thread)),
  );
  return { findings: kept, suppressedCount: findings.length - kept.length };
}

function isSameIssue(finding: Finding, thread: PriorFindingRef): boolean {
  if (thread.isResolved) return false;
  if (finding.path !== thread.path) return false;

  const locationMatches =
    thread.line === undefined
      ? finding.line === 0
      : finding.line > 0 && Math.abs(finding.line - thread.line) <= SUPPRESS_LINE_TOLERANCE;
  if (!locationMatches) return false;

  const titleTokens = significantTokens(finding.title);
  // No comparable content: keep the finding rather than silently dropping it.
  if (titleTokens.length === 0) return false;

  const threadText = thread.body.toLowerCase();
  const matched = titleTokens.filter((token) => threadText.includes(token)).length;
  return matched / titleTokens.length >= SUPPRESS_TITLE_OVERLAP;
}

function significantTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
}

/**
 * Picks which findings get adversarial verification: the most severe
 * blocking findings first, capped at `max`. Returns indexes into the input
 * array; the sort is stable, so equal severities keep input order.
 */
export function selectBlockingFindingIndexes(findings: Finding[], max: number): number[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => BLOCKING_SEVERITIES.has(finding.severity))
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity])
    .slice(0, max)
    .map(({ index }) => index);
}

export interface VerdictApplication {
  findings: Finding[];
  dropped: Array<{ finding: Finding; reason?: string }>;
  demoted: Array<{ finding: Finding; reason?: string }>;
}

/**
 * Applies verifier verdicts to the full findings list. `verdicts[].index`
 * refers to a position in `selectedIndexes` (the order the findings were
 * shown to the verifier), which in turn holds positions in `findings` — this
 * function owns that double translation so it stays testable. Refuted
 * findings are dropped, uncertain ones demoted to advisory; a selected
 * finding with no verdict passes through unchanged (fail-open per finding).
 */
export function applyFindingVerdicts(
  findings: Finding[],
  selectedIndexes: number[],
  verdicts: FindingVerdict[],
): VerdictApplication {
  const verdictByPosition = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
  const dropped: VerdictApplication['dropped'] = [];
  const demotedByIndex = new Map<number, string | undefined>();
  const droppedIndexes = new Set<number>();

  selectedIndexes.forEach((findingIndex, position) => {
    const verdict = verdictByPosition.get(position);
    if (!verdict || verdict.verdict === 'confirmed') return;
    if (verdict.verdict === 'refuted') {
      droppedIndexes.add(findingIndex);
      dropped.push({ finding: findings[findingIndex], reason: verdict.reason });
    } else {
      demotedByIndex.set(findingIndex, verdict.reason);
    }
  });

  const demoted: VerdictApplication['demoted'] = [];
  const result = findings.flatMap((finding, index) => {
    if (droppedIndexes.has(index)) return [];
    if (demotedByIndex.has(index)) {
      demoted.push({ finding, reason: demotedByIndex.get(index) });
      return [{ ...finding, severity: 'P3' as const }];
    }
    return [finding];
  });

  return { findings: result, dropped, demoted };
}

/**
 * Enforces "do not emit low-confidence P0/P1/P2 findings" in code rather than
 * trusting the prompt: a low-confidence blocking finding from a weak model
 * would otherwise flip the review to "Needs changes". Demotes to P3 (advisory)
 * instead of dropping, so the signal stays visible without blocking.
 */
export function demoteLowConfidenceBlockingFindings(findings: Finding[]): {
  findings: Finding[];
  demotedCount: number;
} {
  let demotedCount = 0;
  const result = findings.map((finding) => {
    if (finding.confidence === 'low' && BLOCKING_SEVERITIES.has(finding.severity)) {
      demotedCount += 1;
      return { ...finding, severity: 'P3' as const };
    }
    return finding;
  });
  return { findings: result, demotedCount };
}

/**
 * Whether to post a review comment this run. The first visible run always
 * posts (sets a baseline) and any run with findings posts; a clean re-run
 * posts nothing — the "review done" reaction signals it instead — EXCEPT when
 * there is a "Changes since last review" delta to show, which is that block's
 * main case (a clean re-review of newly pushed commits).
 */
export function shouldPostReviewComment(
  priorJbotReviewCount: number,
  findingCount: number,
  hasChangesSinceDelta = false,
): boolean {
  return priorJbotReviewCount === 0 || findingCount > 0 || hasChangesSinceDelta;
}

/** Minimal review-thread shape for the reaction gate (no GitHub-layer import). */
export interface ReviewThreadState {
  id: string;
  isResolved: boolean;
}

/**
 * Thread ids that remain OPEN after a run: not already resolved (by anyone,
 * including a human) and not resolved during this run. Relies on ACTUAL
 * resolution state — a thread the model claimed addressed but whose reply or
 * resolve failed to post is still open, so it stays in this list and keeps
 * the reaction honest.
 */
export function openFindingThreadIds(
  threads: ReviewThreadState[],
  resolvedThisRun: Iterable<string>,
): string[] {
  const resolved = new Set(resolvedThisRun);
  return threads
    .filter((thread) => !thread.isResolved && !resolved.has(thread.id))
    .map((t) => t.id);
}

/**
 * Whether the PR is clean after this run — the gate for the "review done" 🚀
 * reaction, which means "no open jbot findings", not merely "this run was
 * quiet". Clean requires BOTH no new findings posted now AND no finding
 * thread still open (a still-open prior finding can be suppressed from
 * `findingCount`, so the open-thread count is what keeps the reaction honest).
 */
export function isPrCleanAfterRun(findingCount: number, openThreadCount: number): boolean {
  return findingCount === 0 && openThreadCount === 0;
}
