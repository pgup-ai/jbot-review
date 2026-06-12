/**
 * Golden-set scoring for review quality. A golden case is a PR with labeled
 * expected findings (including known competitor catches and clean PRs with
 * zero expected findings); a run's actual findings are matched against the
 * labels to compute recall, precision, and noise — the regression harness
 * for any prompt or pipeline change.
 *
 * Matching is deliberately fuzzy: same file, line within a tolerance window
 * of the labeled range (file-level findings match any line), and — when the
 * label provides keywords — at least one keyword in the finding text. Exact
 * line/string matching would undercount trivially-rephrased findings.
 */

export interface ExpectedFinding {
  path: string;
  /** Inclusive labeled line range on the new side; omit both for file-level. */
  lineStart?: number;
  lineEnd?: number;
  /** Free-form category for per-category recall (bug, security, data-integrity...). */
  category?: string;
  /** Counts toward recall. Optional nice-to-haves set this false. */
  mustFind: boolean;
  description: string;
  /** Case-insensitive; one match in title+body suffices. */
  keywords?: string[];
}

export interface ActualFinding {
  path: string;
  line: number;
  severity: string;
  title: string;
  body: string;
}

export interface GoldenCase {
  /** True when the labels are complete: every unmatched actual counts as noise. */
  exhaustive?: boolean;
  findings: ExpectedFinding[];
}

export interface MatchResult {
  matched: Array<{ expected: ExpectedFinding; actual: ActualFinding }>;
  missed: ExpectedFinding[];
  unmatchedActuals: ActualFinding[];
}

export const LINE_MATCH_TOLERANCE = 5;

export function matchFindings(expected: ExpectedFinding[], actuals: ActualFinding[]): MatchResult {
  const matched: MatchResult['matched'] = [];
  const usedActuals = new Set<number>();
  const missed: ExpectedFinding[] = [];

  for (const expectation of expected) {
    const index = actuals.findIndex(
      (actual, i) => !usedActuals.has(i) && matchesExpectation(expectation, actual),
    );
    if (index === -1) {
      missed.push(expectation);
    } else {
      usedActuals.add(index);
      matched.push({ expected: expectation, actual: actuals[index] });
    }
  }

  const unmatchedActuals = actuals.filter((_, i) => !usedActuals.has(i));
  return { matched, missed, unmatchedActuals };
}

function matchesExpectation(expected: ExpectedFinding, actual: ActualFinding): boolean {
  if (expected.path !== actual.path) return false;

  const hasRange = expected.lineStart !== undefined || expected.lineEnd !== undefined;
  if (hasRange && actual.line > 0) {
    const start = (expected.lineStart ?? expected.lineEnd ?? 0) - LINE_MATCH_TOLERANCE;
    const end = (expected.lineEnd ?? expected.lineStart ?? 0) + LINE_MATCH_TOLERANCE;
    if (actual.line < start || actual.line > end) return false;
  }

  if (expected.keywords && expected.keywords.length > 0) {
    const text = `${actual.title}\n${actual.body}`.toLowerCase();
    return expected.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  }
  return true;
}

export interface CaseScore {
  name: string;
  mustFindCount: number;
  mustFindMatched: number;
  matched: MatchResult['matched'];
  missed: ExpectedFinding[];
  noiseCandidates: ActualFinding[];
  exhaustive: boolean;
}

export function scoreCase(name: string, golden: GoldenCase, actuals: ActualFinding[]): CaseScore {
  const result = matchFindings(golden.findings, actuals);
  const mustFind = golden.findings.filter((finding) => finding.mustFind);
  const mustFindMatched = result.matched.filter(({ expected }) => expected.mustFind).length;
  return {
    name,
    mustFindCount: mustFind.length,
    mustFindMatched,
    matched: result.matched,
    missed: result.missed.filter((finding) => finding.mustFind),
    noiseCandidates: result.unmatchedActuals,
    exhaustive: golden.exhaustive ?? false,
  };
}

export interface AggregateScore {
  /** mustFind findings matched / total mustFind findings, across all cases. */
  recall: number | undefined;
  /**
   * Matched actuals / total actuals, over exhaustive cases only (elsewhere
   * an unmatched actual may simply be unlabeled, not wrong).
   */
  precision: number | undefined;
  /** Average unmatched actuals per exhaustive case. */
  noisePerCase: number | undefined;
  perCategory: Record<string, { expected: number; matched: number }>;
}

export function aggregateScores(scores: CaseScore[]): AggregateScore {
  let expectedTotal = 0;
  let matchedTotal = 0;
  const perCategory: AggregateScore['perCategory'] = {};

  // Per-category expected counts include both matched and missed mustFinds.
  for (const score of scores) {
    expectedTotal += score.mustFindCount;
    matchedTotal += score.mustFindMatched;
    for (const { expected } of score.matched) {
      if (!expected.mustFind) continue;
      const category = expected.category ?? 'uncategorized';
      perCategory[category] ??= { expected: 0, matched: 0 };
      perCategory[category].matched += 1;
      perCategory[category].expected += 1;
    }
    for (const expected of score.missed) {
      const category = expected.category ?? 'uncategorized';
      perCategory[category] ??= { expected: 0, matched: 0 };
      perCategory[category].expected += 1;
    }
  }

  const exhaustive = scores.filter((score) => score.exhaustive);
  let actualsInExhaustive = 0;
  let matchedInExhaustive = 0;
  let noiseTotal = 0;
  for (const score of exhaustive) {
    matchedInExhaustive += score.matched.length;
    actualsInExhaustive += score.matched.length + score.noiseCandidates.length;
    noiseTotal += score.noiseCandidates.length;
  }

  return {
    recall: expectedTotal > 0 ? matchedTotal / expectedTotal : undefined,
    precision: actualsInExhaustive > 0 ? matchedInExhaustive / actualsInExhaustive : undefined,
    noisePerCase: exhaustive.length > 0 ? noiseTotal / exhaustive.length : undefined,
    perCategory,
  };
}
