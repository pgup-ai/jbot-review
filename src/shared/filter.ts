import { createHash } from 'node:crypto';

import { escapeHtml } from './text.ts';
import { formatUnverifiedFinding } from './prompt.ts';
import {
  anchorByEvidenceSnippet,
  evidenceWindow,
  rescueAnchorByEvidence,
  newSideLines,
  unnumberedEvidence,
} from './patch.ts';
import {
  parseVerificationProof,
  type Finding,
  type FindingConfidence,
  type FindingVerdict,
  type Severity,
} from './types.ts';

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

export function clampFindingsToFiles(
  findings: Finding[],
  assignedFiles: string[] | undefined,
  changedFiles: ReadonlySet<string>,
): Finding[] {
  if (!assignedFiles) return findings;
  const assigned = new Set(assignedFiles);
  return findings.filter(
    (finding) => assigned.has(finding.path) || !changedFiles.has(finding.path),
  );
}

export function isUnresolvedFinding(
  finding: Pick<Finding, 'kind' | 'confidence' | 'verificationUncertain'>,
): boolean {
  return (
    finding.verificationUncertain === true ||
    finding.kind === 'investigate' ||
    finding.confidence === 'low'
  );
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
  // Only findings on one path and line, or file-level ones on one path, can share an anchor.
  const byAnchor = new Map<string, number[]>();
  for (const findings of findingLists) {
    for (const finding of findings) {
      const key = `${finding.path}\0${finding.line > 0 ? finding.line : 0}`;
      const same = byAnchor.get(key) ?? [];
      const existingIndex = same.find((index) => isSameAnchor(kept[index], finding)) ?? -1;
      if (existingIndex === -1) {
        same.push(kept.length);
        byAnchor.set(key, same);
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
   * incomplete fix that MUST be re-reported. `declined` is the one exception.
   */
  isResolved?: boolean;
  /** A human replied last and nothing was fixed: it still suppresses once resolved. */
  declined?: boolean;
  /** The thread's lines changed after it was posted. */
  outdated?: boolean;
  /** Other sites of a grouped finding the jbot actor posted (`listPriorJbotThreads`). */
  sites?: Array<{ path: string; line?: number }>;
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
 *   (file-level threads also match changed-file anchor misses that will fall
 *   back to file level), and
 * - content match: at least half of the finding title's significant words
 *   appear in the prior thread's comment body.
 */
export function suppressPreviouslyReported(
  findings: Finding[],
  priorThreads: PriorFindingRef[],
  addable?: ReadonlyMap<string, ReadonlySet<number>>,
): { findings: Finding[]; suppressedCount: number } {
  if (priorThreads.length === 0) return { findings, suppressedCount: 0 };

  const open = new Map<string, { thread: PriorFindingRef; text: string }[]>();
  for (const thread of priorThreads) {
    if (thread.isResolved && !thread.declined) continue;
    // A grouped thread also covers its other sites in this PR's files, never a security or P0/P1 finding.
    // A decline speaks only for the primary thread's own lines, so it never spreads to sites.
    const sites = (thread.isResolved ? [] : (thread.sites ?? []))
      .filter(({ path }) => addable?.has(path))
      .map(({ path, line }) => ({ ...thread, path, line, grouped: true }));
    for (const site of [thread, ...sites]) {
      const same = open.get(site.path) ?? [];
      same.push({ thread: site, text: thread.body.toLowerCase() });
      open.set(site.path, same);
    }
  }
  const kept = findings.filter((finding) => {
    const candidates = open.get(finding.path);
    if (!candidates) return true;
    const titleTokens = significantTokens(finding.title);
    const capped =
      finding.kind === 'security' || SEVERITY_RANK[finding.severity] <= SEVERITY_RANK.P1;
    return !candidates.some(
      ({ thread, text }) =>
        !('grouped' in thread && capped) &&
        isSameIssue(finding, titleTokens, thread, text, addable),
    );
  });
  return { findings: kept, suppressedCount: findings.length - kept.length };
}

function isSameIssue(
  finding: Finding,
  titleTokens: string[],
  thread: PriorFindingRef,
  threadText: string,
  addable?: ReadonlyMap<string, ReadonlySet<number>>,
): boolean {
  const addableLines = addable?.get(finding.path);
  const locationMatches =
    thread.line === undefined
      ? finding.line === 0 || (addableLines !== undefined && !addableLines.has(finding.line))
      : finding.line > 0 && Math.abs(finding.line - thread.line) <= SUPPRESS_LINE_TOLERANCE;
  if (!locationMatches) return false;
  if (thread.isResolved) return declinedSameIssue(finding, thread);

  // No comparable content: keep the finding rather than silently dropping it.
  if (titleTokens.length === 0) return false;

  const matched = titleTokens.filter((token) => threadText.includes(token)).length;
  return matched / titleTokens.length >= SUPPRESS_TITLE_OVERLAP;
}

/**
 * A resolved decline covers its own unchanged lines, never a security or P0/P1
 * finding, and only the same claim: a shared guideline rule id with overlapping
 * titles, or a near-identical title (not when a CWE/CVE is cited).
 */
function declinedSameIssue(finding: Finding, thread: PriorFindingRef): boolean {
  if (
    thread.outdated ||
    finding.kind === 'security' ||
    SEVERITY_RANK[finding.severity] <= SEVERITY_RANK.P1
  )
    return false;
  const text = `${finding.title}\n${finding.body}`;
  // The posted comment opens with "<label> — <title>".
  const threadTitle = thread.body.split('\n', 1)[0].split(' — ').slice(1).join(' — ');
  const titles = titleTokenMatch(threadTitle, finding.title);
  // A shared rule id alone is not the same claim: one rule covers many mistakes.
  const threadIds = ruleIds(thread.body);
  if (
    [...ruleIds(text)].some((id) => threadIds.has(id)) &&
    titles.overlap >= SUPPRESS_TITLE_OVERLAP
  )
    return true;
  if (CWE_OR_CVE.test(text) || CWE_OR_CVE.test(thread.body)) return false;
  return (
    titles.shared >= FILE_LEVEL_DEDUPE_MIN_SHARED_TOKENS && titles.overlap >= NEAR_IDENTICAL_OVERLAP
  );
}

function significantTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])];
}

// Guideline namespaces only: a generic id (CWE, CVE) names a class of bug, not a written rule.
const RULE_ID = /\b(?:INV|TS)-\d+(?:\.\d+)*\b|§\s?\d+(?:\.\d+)*/g;

/** Written-rule ids a finding cites, such as `TS-13`, `INV-1` or `§12.1`. */
function ruleIds(text: string): Set<string> {
  return new Set((text.match(RULE_ID) ?? []).map((id) => id.replace(/\s/g, '')));
}

const NEAR_IDENTICAL_OVERLAP = 0.8;
const DESIGN_NOTE_PATH = /-design-note\.md$|(^|\/)docs\/(.+\/)?plans\/|-plan\.md$/;
// A title label ("Unverified: …", "[unverified]"), never body prose about unchecked input.
// "Unverified redirect parameter" names a defect, not a label: require the label form.
const SELF_UNVERIFIED = /^\W*unverified\s*:|\[unverified\]|\bverification not completed\b/i;
const CWE_OR_CVE = /\b(?:CWE|CVE)-\d+/;
// Test conventions the repo rates nit: helper use, cleanup and titles. Never
// matcher shape, which can hide a test passing for the wrong reason.
const TEST_STYLE =
  /\bem\.clear\b|\bafterAll\b|\bcreateTest[A-Z]\w*|\btest (?:data )?helpers?\b|\binline (?:test )?(?:data|fixtures?)\b|\btest (?:case )?(?:title|name)\b/i;
// TS-6.3 is the coverage risk tier, rated by what a regression would get past.
const isTestStyleRule = (id: string) => /^TS-6(\.\d+)?$/.test(id) && id !== 'TS-6.3';
// Matcher shape, or any sign the test may not catch its regression, keeps severity.
const MATCHER_SHAPE =
  /\btoBe(?:Defined|Truthy|Falsy)\b|\btoThrow\b|Containing\b|\boptional chaining\b|\bexpect\([^)]*\?\.|\bmatcher\b/i;
// Any coverage claim keeps severity: only a pure convention finding is clamped.
const COVERAGE_CLAIM =
  /\b(?:pass(?:es|ed|ing)?|fail(?:s|ed|ing|ure|ures)?|catch(?:es|ing)?|caught|cover(?:s|ed|ing|age)?|exercis(?:e|es|ed|ing)|reach(?:es|ed|ing)?|regress(?:es|ed|ion|ions)?|revert(?:s|ed|ing)?|guard(?:s|ed)?|assert(?:s|ed|ion|ions)?|verif(?:y|ies|ied|ication)|prov(?:e|es|ed|en|ing)|mask(?:s|ed|ing)?|hid(?:e|es|den|ing)|false (?:positive|negative)s?)\b/i;

/**
 * A maintainability finding citing only `TS-6` rules (not the `TS-6.3`
 * coverage tier) about test conventions is `nit`. Never one about matcher shape
 * or a test that may not catch its regression. Applied again after
 * verification, which can promote a hypothesis to a rated finding.
 */
export function capTestConvention(finding: Finding): Finding {
  const text = `${finding.title}\n${finding.body}`;
  const ids = ruleIds(text);
  return finding.severity !== 'nit' &&
    (finding.kind === undefined || finding.kind === 'maintainability') &&
    ids.size > 0 &&
    [...ids].every(isTestStyleRule) &&
    TEST_STYLE.test(text) &&
    !MATCHER_SHAPE.test(text) &&
    !COVERAGE_CLAIM.test(text)
    ? { ...finding, severity: 'nit' }
    : finding;
}

/**
 * Deterministic over-reach filters, applied before verification:
 * - drops non-security findings on design notes and plans, which record intent
 *   rather than current behavior;
 * - treats a non-security finding whose title carries an unverified label as a
 *   hypothesis for the verifier, never an inline claim;
 * - caps test-convention findings (`capTestConvention`).
 */
export function filterReviewNoise(findings: Finding[]): {
  findings: Finding[];
  dropped: Finding[];
} {
  const dropped: Finding[] = [];
  const kept: Finding[] = [];
  for (const original of findings) {
    if (DESIGN_NOTE_PATH.test(original.path) && original.kind !== 'security') {
      dropped.push(original);
      continue;
    }
    let finding = original;
    if (
      !isUnresolvedFinding(finding) &&
      finding.kind !== 'security' &&
      SELF_UNVERIFIED.test(finding.title)
    )
      finding = { ...finding, kind: 'investigate' };
    kept.push(capTestConvention(finding));
  }
  return { findings: kept, dropped };
}

/**
 * One thread per pattern: after verification, so each site was checked on its
 * own, resolved findings sharing a guideline rule id and a near-identical title
 * collapse into the strongest one, which lists every other site.
 */
export function collapseRepeatedFindings(
  findings: Finding[],
  route: (finding: Finding) => FindingRoute,
): Finding[] {
  const groups: Array<{ ids: Set<string>; members: Finding[] }> = [];
  for (const finding of findings) {
    // An unresolved site keeps its own entry, in diagnostics and Unverified concerns.
    const ids = isUnresolvedFinding(finding)
      ? new Set<string>()
      : ruleIds(`${finding.title}\n${finding.body}`);
    const group =
      ids.size > 0
        ? groups.find(
            (candidate) =>
              // Same routing only: a body-only primary would hide an inline site.
              route(candidate.members[0]) === route(finding) &&
              [...ids].some((id) => candidate.ids.has(id)) &&
              titleTokenMatch(candidate.members[0].title, finding.title).overlap >=
                NEAR_IDENTICAL_OVERLAP,
          )
        : undefined;
    if (!group) {
      groups.push({ ids, members: [finding] });
      continue;
    }
    group.members.push(finding);
    for (const id of ids) group.ids.add(id);
  }
  return groups.map(({ members }) => {
    if (members.length === 1) return members[0];
    const [primary, ...others] = [...members].sort((a, b) => {
      const [severityA, confidenceA] = findingStrength(a);
      const [severityB, confidenceB] = findingStrength(b);
      return severityA - severityB || confidenceA - confidenceB;
    });
    const sites = others
      .map(({ path, line }) => `\`${line > 0 ? `${path}:${line}` : path}\``)
      .join(', ');
    return {
      ...primary,
      body: `${primary.body}\n\nSame issue at: ${sites}.`,
      alsoAt: others.map(({ path, line, evidence }) => ({
        path,
        line,
        ...(evidence ? { evidence } : {}),
      })),
    };
  });
}

// Git's --color-moved counts a block as moved from 20 alphanumeric characters.
const MOVED_MIN_ALNUM = 20;

/**
 * New-side lines per file this PR did not write: context lines, and added
 * lines in a block whose every line was removed elsewhere in the PR (a move,
 * re-indentation allowed). A finding there reviews code the PR only carried.
 */
export function unchangedLines(patchByPath: ReadonlyMap<string, string>): Map<string, Set<number>> {
  const removed = new Set<string>();
  for (const patch of patchByPath.values())
    for (const raw of patch.split('\n'))
      if (raw.startsWith('-') && raw.slice(1).trim()) removed.add(raw.slice(1).trim());
  const result = new Map<string, Set<number>>();
  for (const [path, patch] of patchByPath) {
    const lines = new Set<number>();
    let block: number[] = [];
    let alnum = 0;
    const flush = () => {
      if (alnum >= MOVED_MIN_ALNUM) for (const line of block) lines.add(line);
      block = [];
      alnum = 0;
    };
    for (const { line, content, added } of newSideLines(patch)) {
      const text = content.trim();
      if (!added || (text && !removed.has(text))) {
        flush();
        if (!added) lines.add(line);
        continue;
      }
      block.push(line);
      alnum += text.replace(/[^\p{L}\p{N}]/gu, '').length;
    }
    flush();
    result.set(path, lines);
  }
  return result;
}

export type FindingRoute = 'withheld' | 'inline' | 'fileLevel' | 'body';

/** Where the PR's diff can carry a finding: added lines, and lines this PR did not write. */
export interface DiffLines {
  addable: ReadonlyMap<string, ReadonlySet<number>>;
  /** Moved and context lines per file (`unchangedLines`). */
  unchanged: ReadonlyMap<string, ReadonlySet<number>>;
  /** The PR targets a branch other than the default, so other lines may be parent code. */
  stacked: boolean;
  hasHeadSha: boolean;
}

/**
 * The one routing rule for a final finding. Unresolved ones are withheld. A
 * finding on a line this PR did not write goes to the review body: a moved or
 * context line, a file outside the diff, or, on a stacked PR, any line of a
 * changed file outside the PR's own additions (parent code, or a caller this PR
 * breaks). An added line is inline; any other line of a changed file falls back
 * to a file-level thread.
 */
export function routeFinding(finding: Finding, lines: DiffLines): FindingRoute {
  if (isUnresolvedFinding(finding)) return 'withheld';
  const added = lines.addable.get(finding.path);
  if (finding.line > 0 && lines.unchanged.get(finding.path)?.has(finding.line)) return 'body';
  if (!added || !lines.hasHeadSha) return added?.has(finding.line) ? 'inline' : 'body';
  if (finding.line === 0) return 'fileLevel';
  if (added.has(finding.line)) return 'inline';
  return lines.stacked ? 'body' : 'fileLevel';
}

/** Stable severity order keeps blocking findings first without excluding advisories. */
export function selectFindingIndexes(findings: Finding[]): number[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity])
    .map(({ index }) => index);
}

export interface VerdictApplication {
  findings: Finding[];
  dropped: Array<{ finding: Finding; reason?: string }>;
  demoted: Array<{ finding: Finding; reason?: string }>;
}

export interface OverlapVerdictMerge extends VerdictApplication {
  /** Findings absent from the snapshot, requiring a follow-up verification. */
  lateUnverified: Finding[];
}

export function verificationIdentity(finding: Finding): string {
  return JSON.stringify([finding.path, finding.line, finding.title]);
}

/** Location and title prevent a late replacement from inheriting another finding's verdict. */
export function mergeVerdictsByLocation(
  findings: Finding[],
  verifiedTargets: Finding[],
  verdicts: FindingVerdict[],
): OverlapVerdictMerge {
  const verdictByPosition = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
  const verdictByIdentity = new Map<string, FindingVerdict | undefined>();
  verifiedTargets.forEach((target, position) => {
    verdictByIdentity.set(verificationIdentity(target), verdictByPosition.get(position));
  });

  const dropped: VerdictApplication['dropped'] = [];
  const demoted: VerdictApplication['demoted'] = [];
  const lateUnverified: Finding[] = [];
  const result = findings.flatMap((finding) => {
    const identity = verificationIdentity(finding);
    if (!verdictByIdentity.has(identity)) {
      lateUnverified.push(finding);
      return [finding];
    }
    const verdict = verdictByIdentity.get(identity) ?? {
      verdict: 'uncertain',
      reason: 'Finding verification did not return a verdict.',
      unavailable: true,
    };
    if (verdict.verdict === 'confirmed') return [confirmedFinding(finding, verdict)];
    if (verdict.verdict === 'refuted') {
      dropped.push({ finding, reason: verdict.reason });
      return [];
    }
    demoted.push({ finding, reason: verdict.reason });
    return [unverifiedFinding(finding, verdict.reason, verdict.unavailable)];
  });
  return { findings: result, dropped, demoted, lateUnverified };
}

export function checkConfirmationEvidence(
  verdict: FindingVerdict,
  sourceContext: string,
): FindingVerdict {
  if (
    !verdict.finding ||
    (verdict.finding.evidence && sourceContext.includes(verdict.finding.evidence))
  )
    return verdict;
  return {
    index: verdict.index,
    verdict: 'uncertain',
    reason: 'The proposed confirmation did not quote evidence present in the supplied source.',
  };
}

export function requiresVerificationProof(
  finding: Pick<Finding, 'kind' | 'confidence' | 'verificationUncertain'>,
  correction?: FindingVerdict['finding'],
): boolean {
  const kind = isUnresolvedFinding(finding) ? correction?.kind : finding.kind;
  return !kind || ['bug', 'security', 'performance', 'investigate'].includes(kind);
}

export function checkVerificationProof(
  verdict: FindingVerdict,
  finding: Pick<Finding, 'kind' | 'confidence' | 'verificationUncertain'>,
  sources: ReadonlyMap<string, string>,
  producers: ReadonlySet<string>,
  unindexedSources?: ReadonlySet<string>,
): FindingVerdict {
  if (verdict.verdict !== 'confirmed' || !requiresVerificationProof(finding, verdict.finding))
    return verdict;
  const proof = parseVerificationProof(verdict.proof);
  if (
    proof &&
    proof.producer.every(
      (ref) => producers.has(`${ref.path}:${ref.line}`) || unindexedSources?.has(ref.path),
    ) &&
    [proof.producer, proof.guard, proof.effect].every((refs) =>
      refs.every(
        (ref) => sources.get(ref.path)?.split(/\r?\n/)[ref.line - 1]?.trim() === ref.quote.trim(),
      ),
    )
  ) {
    if (proof.producer.some((ref) => unindexedSources?.has(ref.path)))
      return {
        index: verdict.index,
        verdict: 'uncertain',
        unavailable: true,
        reason: 'Producer validation is unavailable for unsupported or truncated source.',
      };
    return verdict;
  }
  return {
    index: verdict.index,
    verdict: 'uncertain',
    reason:
      'Confirmation lacks a complete trigger, producer, guard and effect proof with source-validated citations.',
  };
}

export function resolvesFinding(finding: Finding, verdict: FindingVerdict): boolean {
  return !confirmedFinding(finding, verdict).verificationUncertain;
}

/** Counts re-check reasons; a "confirmed" here is one the evidence check rejected. */
export function recheckReasons(verdicts: (FindingVerdict['verdict'] | undefined)[]): string {
  const counts = new Map<string, number>();
  for (const verdict of verdicts) {
    const reason = verdict === 'confirmed' ? 'unbacked confirmation' : (verdict ?? 'no verdict');
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, count]) => `${reason} ${count}`).join(', ');
}

function confirmedFinding(finding: Finding, verdict: FindingVerdict): Finding {
  if (!isUnresolvedFinding(finding)) {
    const support = verdict.verifiedSupport;
    if (
      !support ||
      verdict.unavailable ||
      support.target !== JSON.stringify([finding.path, finding.line, finding.title, finding.body])
    )
      return finding;
    const citations = support.references
      .map((ref) => `- ${ref.path}:${ref.line} — SHA-256: ${support.sourceHashes[ref.path]}`)
      .join('\n');
    return {
      ...finding,
      body: `${finding.body}\n\nVerification support (listed source citations checked; causal explanation is the verifier's assessment):\n\n<pre lang="text"><code>${escapeHtml(support.explanation)}</code></pre>\n\n<details>\n<summary>Source provenance</summary>\n\nCheckout HEAD: ${support.revision}\n\nHashes identify the working-tree source read during validation, which may include uncommitted changes.\n\n<pre lang="text"><code>${escapeHtml(citations)}</code></pre>\n\n</details>`,
    };
  }
  const confirmed = verdict.finding;
  if (
    !confirmed ||
    !confirmed.kind ||
    confirmed.kind === 'investigate' ||
    !confirmed.title.trim() ||
    !confirmed.evidence?.trim() ||
    !verdict.reason?.trim()
  )
    return unverifiedFinding(
      finding,
      'The verifier returned confirmed without an evidence-backed finding and explanation.',
    );
  return {
    ...finding,
    title: confirmed.title,
    severity: confirmed.severity,
    kind: confirmed.kind,
    evidence: confirmed.evidence,
    body: verdict.reason,
    confidence: 'medium',
    verificationUncertain: undefined,
    verificationUnavailable: undefined,
  };
}

function unverifiedFinding(finding: Finding, reason?: string, unavailable = false): Finding {
  return {
    ...finding,
    // A failed verifier's reason can carry raw provider errors; the body gets none.
    ...formatUnverifiedFinding(
      finding,
      unavailable ? 'Finding verification did not complete.' : reason,
      unavailable,
    ),
    severity: finding.severity === 'nit' ? 'nit' : 'P3',
    kind: 'investigate',
    confidence: 'low',
    verificationUncertain: true,
    verificationUnavailable: unavailable || undefined,
  };
}

/** Verdict positions index selectedIndexes, which maps back to the full finding list. */
export function applyFindingVerdicts(
  findings: Finding[],
  selectedIndexes: number[],
  verdicts: FindingVerdict[],
): VerdictApplication {
  const verdictByPosition = new Map(verdicts.map((verdict) => [verdict.index, verdict]));
  const dropped: VerdictApplication['dropped'] = [];
  const demotedByIndex = new Map<number, Pick<FindingVerdict, 'reason' | 'unavailable'>>();
  const confirmedByIndex = new Map<number, Finding>();
  const droppedIndexes = new Set<number>();

  selectedIndexes.forEach((findingIndex, position) => {
    const verdict = verdictByPosition.get(position) ?? {
      verdict: 'uncertain',
      reason: 'Finding verification did not return a verdict.',
      unavailable: true,
    };
    if (verdict.verdict === 'confirmed') {
      confirmedByIndex.set(findingIndex, confirmedFinding(findings[findingIndex], verdict));
      return;
    }
    if (verdict.verdict === 'refuted') {
      droppedIndexes.add(findingIndex);
      dropped.push({ finding: findings[findingIndex], reason: verdict.reason });
    } else {
      demotedByIndex.set(findingIndex, verdict);
    }
  });

  const demoted: VerdictApplication['demoted'] = [];
  const result = findings.flatMap((finding, index) => {
    if (droppedIndexes.has(index)) return [];
    if (demotedByIndex.has(index)) {
      const verdict = demotedByIndex.get(index)!;
      demoted.push({ finding, reason: verdict.reason });
      return [unverifiedFinding(finding, verdict.reason, verdict.unavailable)];
    }
    return [confirmedByIndex.get(index) ?? finding];
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
 * Moves findings onto the line their evidence quote identifies, IN PLACE, and
 * returns the ones it moved — both lines that cannot anchor at all and addable
 * lines the quote provably contradicts (a confidently wrong line number is the
 * one case the quote exists to correct).
 *
 * Runs before dedupe and prior-thread suppression, not at routing time: both
 * compare path:line, so a finding left on a wrong line escapes the collision it
 * should have had — either with a sibling session's copy of the same issue, or
 * with the prior thread that already reported it.
 *
 * Line 0 is left alone: the prompt defines it as a finding no single added line
 * can carry, and its evidence necessarily quotes adjacent code rather than the
 * defect.
 *
 * Evidence always drops line numbers copied from a numbered page diff, line 0
 * and quotes-off included: verifier prompts quote it.
 */
export function resolveFindingAnchors(
  findings: Finding[],
  addable: ReadonlyMap<string, ReadonlySet<number>>,
  patchByPath: ReadonlyMap<string, string>,
  evidenceQuotes: boolean,
): Finding[] {
  const moved: Finding[] = [];
  for (const f of findings) {
    const patch = patchByPath.get(f.path);
    if (f.evidence) f.evidence = unnumberedEvidence(patch, f.evidence);
    if (!evidenceQuotes || f.line === 0 || !f.evidence) continue;
    let target: number | undefined;
    if (addable.get(f.path)?.has(f.line)) {
      // An addable claim moves only on provable inconsistency: the quote
      // resolves uniquely elsewhere. A claim inside the matched window is
      // corroborated — snapping it to the window anchor would be churn — and
      // an AMBIGUOUS quote proves nothing, so the prefix rescue may only run
      // on a confirmed no-match.
      const window = evidenceWindow(patch, f.evidence);
      if (window === 'ambiguous') continue;
      if (window !== undefined) {
        if (f.line >= window.start && f.line <= window.end) continue;
        target = window.anchor;
      } else {
        // Unique-prefix rescue: if the claimed line also matched the prefix,
        // the match would have been ambiguous and undefined — so a hit here
        // is a line the quote fits and the claimed line does not.
        target = rescueAnchorByEvidence(patch, f.evidence);
      }
    } else {
      // The snippet matcher handles multi-line quotes; the prefix rescue still
      // covers a single line truncated at the evidence cap, which cannot match whole.
      target =
        anchorByEvidenceSnippet(patch, f.evidence) ?? rescueAnchorByEvidence(patch, f.evidence);
    }
    if (target !== undefined && target !== f.line) {
      f.line = target;
      moved.push(f);
    }
  }
  return moved;
}

export function filterFindings(
  findings: Finding[],
  options: { minSeverity: Severity; maxFindings: number },
): Finding[] {
  const shown = (severity: Severity) =>
    SEVERITY_RANK[severity] <= SEVERITY_RANK[options.minSeverity];
  let published = findings.filter(
    (finding) => !isUnresolvedFinding(finding) && shown(finding.severity),
  );
  if (options.maxFindings > 0)
    published = [...published]
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
      .slice(0, options.maxFindings);
  return [...published, ...findings.filter(isUnresolvedFinding)];
}

export interface AnchoredFindings {
  withheld: Finding[];
  /** Postable at a specific added line. */
  inline: Finding[];
  /** Findings routed to a changed file instead of a specific added line. */
  fileLevel: Finding[];
  /** Anchor not in the diff, or on a line the PR only moved or shows as context; rendered in the review body. */
  orphaned: Finding[];
  /** A subset of `fileLevel`: demoted because no anchor resolved, unlike a model-declared line 0. */
  anchorMissed: Finding[];
}

/**
 * Splits final findings by where their anchor lands in the diff. Anchors are
 * already resolved by `resolveFindingAnchors`, so this only routes: a finding on
 * a changed file that still has no usable line falls back to a file-level thread
 * so it remains independently resolvable. Findings outside the changed-file set,
 * or on a line this PR only moved or shows as context, stay in the review body.
 */
export function anchorFindings(findings: Finding[], lines: DiffLines): AnchoredFindings {
  const result: AnchoredFindings = {
    inline: [],
    fileLevel: [],
    orphaned: [],
    anchorMissed: [],
    withheld: [],
  };
  for (const f of findings) {
    const route = routeFinding(f, lines);
    if (route === 'withheld') result.withheld.push(f);
    else if (route === 'inline') result.inline.push(f);
    else if (route === 'body') result.orphaned.push(f);
    else {
      if (f.line > 0) {
        f.line = 0;
        result.anchorMissed.push(f);
      }
      result.fileLevel.push(f);
    }
  }
  return result;
}

/** Marks each site of a body-only finding in a posted review body. */
export const BODY_FINDING_MARKER = 'jbot-site';

function bodyFindingKeys(finding: Finding): Array<{ path: string; key: string }> {
  const section = isUnresolvedFinding(finding) ? 'unverified' : 'outside';
  const title = finding.title.toLowerCase().replace(/\s+/g, ' ').trim();
  // Each site's own quoted code, so a site whose code changed counts as new.
  return [finding, ...(finding.alsoAt ?? [])].map(({ path, line, evidence }) => ({
    path,
    key: createHash('sha1')
      .update(`${path}|${line}|${title}|${section}|${(evidence ?? '').replace(/\s+/g, ' ').trim()}`)
      .digest('hex')
      .slice(0, 12),
  }));
}

/** The hidden markers at the end of a jbot review body; model text cannot open one (neutralizeMarkers). */
function trailerMarkers(body: string): string[] {
  const block = /(?:\s*\n<!-- [^\n]* -->[ \t]*)+\s*$/.exec(body)?.[0] ?? '';
  return [...block.matchAll(/<!-- ([^\n]*?) -->/g)].map(([, marker]) => marker);
}

/** One hidden marker listing every site key of `findings`, so a later run can tell what it reported. */
export function bodyFindingMarker(findings: Finding[]): string {
  return findings.length
    ? `<!-- ${BODY_FINDING_MARKER}:${findings
        .flatMap(bodyFindingKeys)
        .map(({ key }) => key)
        .join(',')} -->`
    : '';
}

/**
 * Findings that are new to the PR. A body-only finding (outside the diff, on a
 * line the PR did not write, or unverified) lives in the review body, which
 * thread suppression cannot see, so it counts unless a prior jbot review body
 * marks every one of its sites in the same disposition: a newly confirmed
 * concern, or a new site of a grouped finding, is new.
 */
export function newFindingCount(
  findings: Finding[],
  bodyOnly: Finding[],
  priorReviews: ReadonlyArray<{ id: number; body: string }>,
): number {
  // Newest first; a review without a coverage marker covered every file.
  const reviews = [...priorReviews]
    .sort((a, b) => b.id - a.id)
    .map(({ body }) => {
      const markers = trailerMarkers(body);
      const keys = markers.find((marker) => marker.startsWith(`${BODY_FINDING_MARKER}:`));
      const covered = markers.find((marker) => marker.startsWith(`${COVERED_MARKER}:`));
      return {
        keys: new Set(keys?.slice(BODY_FINDING_MARKER.length + 1).split(',') ?? []),
        covered: covered
          ? new Set(
              covered
                .slice(COVERED_MARKER.length + 1)
                .split(',')
                .map(decodeURIComponent),
            )
          : undefined,
      };
    });
  // A site is old only when the newest review that covered its file listed it.
  const reported = ({ path, key }: { path: string; key: string }) =>
    reviews.find(({ covered }) => !covered || covered.has(path))?.keys.has(key) ?? false;
  return (
    findings.length - bodyOnly.filter((finding) => bodyFindingKeys(finding).every(reported)).length
  );
}

/** The files an incremental review covered, in its trailer; a full review omits it. */
export const COVERED_MARKER = 'jbot-review:covered';

export function coveredFilesMarker(files: readonly string[]): string {
  return `<!-- ${COVERED_MARKER}:${files.map(encodeURIComponent).join(',')} -->`;
}

export function shouldPostReviewComment(
  priorJbotReviewCount: number,
  findingCount: number,
  coverageComplete = true,
  /** The stored baseline was unusable and this run's body records a new one. */
  refreshesBaseline = false,
): boolean {
  return !coverageComplete || priorJbotReviewCount === 0 || findingCount > 0 || refreshesBaseline;
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
 * If the thread lookup failed, the PR cannot be proven clean.
 */
export function isPrCleanAfterRun(
  findingCount: number,
  openThreadCount: number,
  threadStateKnown: boolean,
  coverageComplete = true,
): boolean {
  return coverageComplete && threadStateKnown && findingCount === 0 && openThreadCount === 0;
}
