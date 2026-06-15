import {
  SEVERITY_RANK,
  applyFindingVerdicts,
  dedupeFindings,
  demoteLowConfidenceBlockingFindings,
  isNoiseFile,
  selectBlockingFindingIndexes,
  suppressPreviouslyReported,
} from './filter.ts';
import { buildBlastRadiusBlock } from './blast-radius.ts';
import {
  PATH_PATTERNS,
  buildDiffHunksBlock,
  isDocOnlyChange,
  shardFilesForReview,
} from './diff-context.ts';
import { parseModelName } from './model.ts';
import { parseAddedLines } from './patch.ts';
import { REVIEW_LENSES, buildShardAssignmentBlock, selectLensKeys } from './prompt.ts';
import { ensureGitSafeDirectory } from './git.ts';
import {
  startOpencode,
  configureSessionConcurrency,
  runReview,
  runAddressedPriorCommentsCheck,
  runFindingVerification,
  runGuidelineComplianceCheck,
  listProviderModels,
  enableContext7Mcp,
  disableContext7Mcp,
  formatContext7Error,
} from './opencode.ts';
import { buildReviewContext, discoverGuidelines, formatDiffScope } from './review-context.ts';
import { decideContext7Mode, type Context7Mode } from './context7.ts';
import {
  listPrFiles,
  listPrComments,
  listPrCommits,
  getCheckStatusSummary,
  formatFindingMetadata,
  formatFindingLocation,
  postFileLevelComment,
  addPrReaction,
  removeOwnPrReaction,
  postReview,
  decideVerdict,
  listPriorJbotThreads,
  formatPriorJbotThreadsForPrompt,
  postAddressedThreadReply,
  resolveReviewThread,
  isJbotReviewBody,
} from './github.ts';
import type { Octokit, PriorJbotThread } from './github.ts';
import { condenseSummary, renderOrphanedSection } from './report.ts';
import type { AddressedPriorComment, Finding, Severity } from './types.ts';

/** Blocking findings verified per run; the rest pass through unverified. */
const MAX_VERIFIED_FINDINGS = 10;

export interface ReviewRunOptions {
  enhancedContext?: boolean;
  dryRun?: boolean;
  maxFindings?: number;
  minSeverity?: Severity;
  includePriorComments?: boolean;
  context7Mode?: Context7Mode;
  context7ApiKey?: string;
  guidelinePass?: boolean;
  /**
   * Model for the auxiliary sessions (addressed-check, guideline compliance,
   * finding verification). Lets the main review run on a stronger tier while
   * the mechanical checks stay on a cheap one. Must be on the same provider
   * as the main model (one API key per run). Empty = use the main model.
   */
  auxModel?: string;
  /**
   * Total review passes: 1 = the general pass only; each extra pass adds a
   * focused recall lens (interactions, then integrity) running in parallel.
   * Findings are merged and deduped, so extra passes raise recall at roughly
   * one extra session cost each.
   */
  reviewPasses?: number;
  /** Adversarially verify blocking findings before posting (precision gate). */
  verifyFindings?: boolean;
  /**
   * Wall-clock target in minutes (0 = no budget). Finder sessions get the
   * full budget (minus a posting reserve) as their deadline; retries and
   * verification use whatever remains at their start or are skipped
   * (fail-open). Lets heavy-reasoning models run without ever timing out
   * the whole job.
   */
  timeBudgetMinutes?: number;
  /**
   * Parallel shards for the main review. 1 = no sharding, a single full-diff
   * session (default). 0 = auto from diff size. N = pin N shards. Each shard
   * deep-reviews a subset of files with the full checkout available; the union
   * covers the complete diff and wall clock ≈ the slowest shard. Only a win on
   * providers that serve concurrent sessions; free/throttled tiers serialize
   * the shards on one key, so single-session is the better default there.
   */
  reviewShards?: number;
  /**
   * Provider options for the MAIN model, passed through opencode to the
   * provider SDK — e.g. {"reasoningEffort":"medium"} to cap reasoning spend
   * on heavy models. Aux-model sessions are unaffected.
   */
  modelOptions?: Record<string, unknown>;
  /**
   * Enable opencode prompt caching (provider `setCacheKey`). Default true:
   * parallel shards and re-reviews share a byte-identical prompt prefix, so
   * caching cuts input-token cost on providers that honor it and is a no-op
   * elsewhere. Per-session cache hits are logged via `formatTokenUsage`.
   */
  promptCache?: boolean;
  /**
   * Skip the full LLM review when the WHOLE PR diff is doc/prose files
   * (deterministic, see `isDocOnlyChange`; evaluated on the cumulative
   * base...head file list, so a mixed code+docs PR never qualifies). Default
   * true: a docs-only PR gets the "review done" reaction and no review
   * session, saving the whole model cost.
   */
  skipDocOnly?: boolean;
  /**
   * Max model sessions in flight at once (0 = unlimited). Throttled provider
   * tiers serialize one key's concurrent requests upstream; capping on our
   * side keeps session deadlines measuring model time, not queue time.
   * Try 2-3 on free tiers.
   */
  maxConcurrentSessions?: number;
  /**
   * Override opencode server port for this run. Local benchmark workers use
   * this to run isolated snapshots concurrently.
   */
  opencodePort?: number;
  /**
   * Local harness hook: receives the same filtered findings that dry-run would
   * post. Not exposed through the GitHub Action input surface.
   */
  onReviewResult?: (result: {
    summary: string;
    findings: Finding[];
    addressedPriorComments: AddressedPriorComment[];
  }) => void;
}

export async function runPrReview(params: {
  octokit: Octokit;
  threadResolutionOctokit?: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  pullTitle: string;
  pullBody: string;
  workspace: string;
  model: string;
  apiKey: string;
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  options?: ReviewRunOptions;
  log: (msg: string) => void;
}): Promise<void> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    pullTitle,
    pullBody,
    workspace,
    model,
    apiKey,
    headSha,
    baseRef,
    baseSha,
    log,
  } = params;
  const options = normalizeOptions(params.options);
  const runStartedAt = Date.now();
  const finderTimeoutMs = computeFinderTimeoutMs(options.timeBudgetMinutes);
  if (finderTimeoutMs) {
    log(
      `Time budget ${options.timeBudgetMinutes}m: finder sessions capped at ${Math.round(finderTimeoutMs / 1000)}s.`,
    );
  }

  const { providerID, modelID } = parseModelName(model);

  // Clear the prior "review done" reaction up front so it only reappears
  // when THIS run finishes — a removed reaction means a review is in flight.
  // Skipped on dry runs (which must not touch the PR).
  if (!options.dryRun) {
    await safeRemoveReviewReaction(octokit, owner, repo, pullNumber, log);
  }

  await ensureGitSafeDirectory(workspace, log);

  log(`Listing PR files for ${owner}/${repo}#${pullNumber}`);
  const rawFiles = await listPrFiles(octokit, owner, repo, pullNumber);
  log(`Files in PR: ${rawFiles.length} total`);
  const files = rawFiles.filter((f) => f.patch && !isNoiseFile(f.filename));
  if (files.length === 0) {
    log('No reviewable files after filtering.');
    if (!options.dryRun) await safeAddReviewReaction(octokit, owner, repo, pullNumber, log);
    return;
  }
  log(`Reviewable files: ${files.length} (noise filtered: ${rawFiles.length - files.length})`);

  const addable = new Map<string, Set<number>>();
  const changedFiles: string[] = [];
  for (const f of files) {
    addable.set(f.filename, parseAddedLines(f.patch));
    changedFiles.push(f.filename);
  }

  // Deterministic doc-only gate: when the entire PR diff is prose, it isn't
  // worth a full model review. `changedFiles` is the cumulative base...head
  // list, so a PR with any code/config file never qualifies — even if the
  // latest push touched only docs. React "done" and return before any server
  // boot or LLM session.
  if (options.skipDocOnly && isDocOnlyChange(changedFiles)) {
    log(`Doc-only PR (${changedFiles.length} file(s)); skipping the full review.`);
    if (!options.dryRun) await safeAddReviewReaction(octokit, owner, repo, pullNumber, log);
    return;
  }

  const guidelines = await discoverGuidelines(workspace, changedFiles);
  if (guidelines) log(`Guidelines loaded (${guidelines.length} bytes).`);

  const priorComments = options.includePriorComments
    ? await listPrComments(octokit, owner, repo, pullNumber)
    : [];
  if (!options.includePriorComments) log('Prior review comments excluded by configuration.');
  const priorJbotThreads = options.includePriorComments
    ? await safeListPriorJbotThreads(octokit, owner, repo, pullNumber, log)
    : [];
  log(`Prior jbot-review threads available for addressed checks: ${priorJbotThreads.length}`);
  const priorJbotThreadBlock = formatPriorJbotThreadsForPrompt(priorJbotThreads);
  const summaryScopeBlock = buildSummaryScopeBlock(priorComments, headSha);
  const reviewFocusBlock = buildReviewFocusBlock(changedFiles);
  const diffHunksBlock = buildDiffHunksBlock(files);
  if (diffHunksBlock) log(`Embedded diff hunks block: ${diffHunksBlock.length} chars.`);
  const blastRadiusBlock = options.enhancedContext
    ? await buildBlastRadiusBlock(workspace, files)
    : '';
  if (blastRadiusBlock) log('Embedded changed-symbol usage block.');

  const diffScope = { baseRef, baseSha, headSha };

  // The diff hunks deliberately stay OUT of the core context: each main
  // review shard appends its own slice, and the lens/aux sessions append the
  // full block. Hunks always go last — closest to the output reminder, where
  // small models attend most.
  let coreContext: string;
  let guidelinesForPrompt = guidelines;
  if (options.enhancedContext) {
    const commits = await listPrCommits(octokit, owner, repo, pullNumber);
    const checkSummary = headSha
      ? await getCheckStatusSummary(octokit, owner, repo, headSha)
      : 'Check status unavailable: PR head SHA was not provided.';
    coreContext = buildReviewContext({
      pullTitle,
      pullBody,
      changedFiles,
      priorComments,
      commits,
      checkSummary,
      guidelines,
      diffScope,
    });
    coreContext = `${coreContext}\n\n${summaryScopeBlock}`;
    coreContext = `${coreContext}\n\n${reviewFocusBlock}`;
    if (priorJbotThreadBlock) coreContext = `${coreContext}\n\n${priorJbotThreadBlock}`;
    if (blastRadiusBlock) coreContext = `${coreContext}\n\n${blastRadiusBlock}`;
    guidelinesForPrompt = '';
  } else {
    const commentsBlock =
      priorComments.length > 0
        ? '## Prior review comments\n' + priorComments.map((c) => `- ${c}`).join('\n')
        : '';
    coreContext = [
      '## Pull request',
      pullTitle && `Title: ${pullTitle}`,
      pullBody && `Description: ${pullBody}`,
      formatDiffScope(diffScope),
      `Changed files: ${changedFiles.join(', ')}`,
      summaryScopeBlock,
      reviewFocusBlock,
      commentsBlock,
      priorJbotThreadBlock,
    ]
      .filter(Boolean)
      .join('\n');
  }
  const basePrContext = joinContext(coreContext, diffHunksBlock);

  configureSessionConcurrency(options.maxConcurrentSessions);
  if (options.maxConcurrentSessions > 0) {
    log(`Model session concurrency capped at ${options.maxConcurrentSessions}.`);
  }

  log('Starting opencode server');
  const { client, stop } = await startOpencode(workspace, providerID, modelID, apiKey, log, {
    modelOptions: options.modelOptions,
    promptCache: options.promptCache,
    port: options.opencodePort > 0 ? options.opencodePort : undefined,
  });
  try {
    try {
      const modelListCacheKey = `${providerID}:${modelID}`;
      let models = providerModelListCache.get(modelListCacheKey);
      const fromCache = !!models;
      if (!models) {
        models = await listProviderModels(client, providerID);
        providerModelListCache.set(modelListCacheKey, models);
      }
      log(
        models.length > 0
          ? `Available models for ${providerID} using supplied API key/config${fromCache ? ' (cached)' : ''}:\n${models.join('\n')}`
          : `Available models for ${providerID} using supplied API key/config: none returned`,
      );
    } catch (e) {
      log(`(skipped provider model listing: ${(e as Error).message})`);
    }

    const context7 = decideContext7Mode({
      mode: options.context7Mode,
      files,
      apiKey: options.context7ApiKey,
    });
    let context7Active = false;
    let context7Block = '';
    if (context7.enabled) {
      log(`Context7 MCP requested: ${context7.reason}`);
      context7Active = await enableContext7Mcp(client, options.context7ApiKey, log);
      if (context7Active) context7Block = buildContext7PromptBlock(context7.reason);
    } else {
      log(`Context7 MCP skipped: ${context7.reason}.`);
    }

    const auxModel = options.auxModel || model;

    const addressedPriorCheck = startAddressedPriorCommentsCheck({
      client,
      model: auxModel,
      prContext: basePrContext,
      priorJbotThreads,
      timeoutMs: finderTimeoutMs,
      log,
    });

    const guidelineComplianceCheck = startGuidelineComplianceCheck({
      client,
      model: auxModel,
      prContext: basePrContext,
      guidelinesForPrompt,
      hasGuidelines: Boolean(guidelines),
      enabled: options.guidelinePass,
      timeoutMs: finderTimeoutMs,
      log,
    });

    // Lens passes run on the aux model (recall supplement, not the deep
    // pass) and use the base context (no Context7 block): they have no
    // Context7 retry path, so a Context7 hiccup must not be able to zero a
    // pass's findings.
    const lensPasses = startLensPasses({
      client,
      model: auxModel,
      prContext: basePrContext,
      guidelinesForPrompt,
      passes: options.reviewPasses,
      timeoutMs: finderTimeoutMs,
      log,
    });

    const shards = shardFilesForReview(files, { requestedShards: options.reviewShards });
    const shardPlans = buildShardPlans({
      coreContext,
      fullDiffBlock: diffHunksBlock,
      context7Block,
      shards,
    });
    log(`Running review (${shardPlans.length} shard(s))`);
    const { summary, findings } = await runShardedReview({
      client,
      model,
      guidelinesForPrompt,
      shardPlans,
      changedFiles,
      timeoutMs: finderTimeoutMs,
      deadlineAt: computeRunDeadline(options.timeBudgetMinutes, runStartedAt),
      context7Active,
      context7ApiKey: options.context7ApiKey,
      log,
    });
    const lensFindingLists = await lensPasses;
    // The dedicated parallel session is the single owner of addressed-thread
    // verification; the main review no longer reports them.
    const verifiedAddressedPriorComments = await addressedPriorCheck;
    const complianceFindings = await guidelineComplianceCheck;
    // Gate confidence BEFORE deduping so each finding carries its effective
    // severity into collision resolution; otherwise a low-confidence main
    // finding could win a path:line collision and then be demoted to P3,
    // dropping a stronger compliance finding at the same location.
    const gatedLists = [findings, ...lensFindingLists, complianceFindings].map(
      demoteLowConfidenceBlockingFindings,
    );
    const demotedCount = gatedLists.reduce((sum, gated) => sum + gated.demotedCount, 0);
    if (demotedCount > 0) {
      log(`Demoted ${demotedCount} low-confidence blocking finding(s) to P3.`);
    }
    // Main review first: on equal-strength path:line collisions its richer
    // general context wins over lens and compliance findings.
    const combinedFindings = dedupeFindings(...gatedLists.map((gated) => gated.findings));
    const dedupeDropped =
      gatedLists.reduce((sum, gated) => sum + gated.findings.length, 0) - combinedFindings.length;
    if (dedupeDropped > 0) {
      log(`Deduped ${dedupeDropped} finding(s) that collided on path:line across sessions.`);
    }
    // Full-diff re-review means repeats are possible by design; this is the
    // in-code backstop that drops findings prior jbot threads already cover.
    const suppression = suppressPreviouslyReported(combinedFindings, priorJbotThreads);
    if (suppression.suppressedCount > 0) {
      log(
        `Suppressed ${suppression.suppressedCount} finding(s) already covered by prior jbot-review threads.`,
      );
    }
    const verifiedFindings = await verifyBlockingFindings({
      client,
      model: auxModel,
      prContext: basePrContext,
      timeoutMs: computeVerificationTimeoutMs(options.timeBudgetMinutes, Date.now() - runStartedAt),
      findings: suppression.findings,
      enabled: options.verifyFindings,
      log,
    });
    const filteredFindings = filterFindings(verifiedFindings, options);
    log(
      `Review complete: ${findings.length} main + ${lensFindingLists.flat().length} lens + ${complianceFindings.length} compliance finding(s), ${filteredFindings.length} after filters, ${verifiedAddressedPriorComments.length} addressed prior comment(s)`,
    );

    const inline: Finding[] = [];
    const fileLevel: Finding[] = [];
    const orphaned: Finding[] = [];
    for (const f of filteredFindings) {
      if (f.line === 0 && headSha && addable.has(f.path)) fileLevel.push(f);
      else if (addable.get(f.path)?.has(f.line)) inline.push(f);
      else orphaned.push(f);
    }
    const verdict = decideVerdict(filteredFindings);

    if (options.dryRun) {
      const body = buildBody(summary, filteredFindings, orphaned, model, owner, repo, headSha);
      options.onReviewResult?.({
        summary,
        findings: filteredFindings,
        addressedPriorComments: verifiedAddressedPriorComments,
      });
      log(
        `Dry run enabled; would post verdict=${verdict} inline=${inline.length} file-level=${fileLevel.length} orphaned=${orphaned.length}`,
      );
      log(`Dry run review body:\n${body}`);
      if (inline.length > 0) {
        log(`Dry run inline comments:\n${inline.map(formatInlineFinding).join('\n\n')}`);
      }
      if (fileLevel.length > 0) {
        log(`Dry run file-level comments:\n${fileLevel.map(formatInlineFinding).join('\n\n')}`);
      }
      if (verifiedAddressedPriorComments.length > 0) {
        log(
          `Dry run addressed prior comments:\n${verifiedAddressedPriorComments
            .map(formatAddressedPriorComment)
            .join('\n')}`,
        );
      }
      return;
    }

    // Don't post a redundant "all clear" comment on a re-run: the first
    // visible run always posts (sets a baseline), and any run with findings
    // posts. A clean re-run is signaled by the reaction instead. Addressed
    // -thread replies (below) still run regardless.
    const isFirstRun = priorComments.filter(isJbotReviewBody).length === 0;
    const hasFindings = inline.length + fileLevel.length + orphaned.length > 0;
    if (isFirstRun || hasFindings) {
      // File-level comments go first so a posting failure can still fall back
      // into the review body, which is built afterwards.
      for (const finding of fileLevel) {
        try {
          await postFileLevelComment(octokit, owner, repo, pullNumber, headSha as string, finding);
          log(`Posted file-level comment for ${finding.path}.`);
        } catch (error) {
          log(
            `Failed to post file-level comment for ${finding.path}; folding into review body: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          orphaned.push(finding);
        }
      }

      const body = buildBody(summary, filteredFindings, orphaned, model, owner, repo, headSha);
      log(
        `Posting review: verdict=${verdict} inline=${inline.length} file-level=${fileLevel.length} orphaned=${orphaned.length}`,
      );
      await postReview(octokit, owner, repo, pullNumber, verdict, body, inline);
      log('Review posted.');
    } else {
      log('No new findings on a re-run; skipping the review comment (reacting instead).');
    }

    await acknowledgeAddressedPriorComments({
      octokit,
      threadResolutionOctokit: params.threadResolutionOctokit,
      owner,
      repo,
      pullNumber,
      headSha,
      priorJbotThreads,
      addressedPriorComments: verifiedAddressedPriorComments,
      log,
    });
    // The "review done" reaction goes on only after a fully successful run;
    // a thrown/aborted run leaves the reaction absent (review didn't finish).
    await safeAddReviewReaction(octokit, owner, repo, pullNumber, log);
  } finally {
    stop();
  }
}

/**
 * The PR reaction jbot uses as a "current head reviewed, no comment needed"
 * marker. GitHub has no checkmark reaction; rocket is the closest "shipped".
 */
const REVIEW_DONE_REACTION = 'rocket' as const;

/** Best-effort: a reaction failure (e.g. missing permission) never fails the run. */
async function safeAddReviewReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await addPrReaction(octokit, owner, repo, pullNumber, REVIEW_DONE_REACTION);
  } catch (error) {
    log(`(could not add ${REVIEW_DONE_REACTION} reaction: ${describeError(error)})`);
  }
}

async function safeRemoveReviewReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await removeOwnPrReaction(octokit, owner, repo, pullNumber, REVIEW_DONE_REACTION);
  } catch (error) {
    log(`(could not clear prior ${REVIEW_DONE_REACTION} reaction: ${describeError(error)})`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type NormalizedReviewRunOptions = Required<Omit<ReviewRunOptions, 'onReviewResult'>> &
  Pick<ReviewRunOptions, 'onReviewResult'>;

function normalizeOptions(options: ReviewRunOptions | undefined): NormalizedReviewRunOptions {
  const maxPasses = 1 + Object.keys(REVIEW_LENSES).length;
  return {
    enhancedContext: options?.enhancedContext ?? false,
    dryRun: options?.dryRun ?? false,
    maxFindings: options?.maxFindings ?? 0,
    minSeverity: options?.minSeverity ?? 'nit',
    includePriorComments: options?.includePriorComments ?? true,
    context7Mode: options?.context7Mode ?? 'auto',
    context7ApiKey: options?.context7ApiKey ?? '',
    guidelinePass: options?.guidelinePass ?? true,
    auxModel: options?.auxModel ?? '',
    reviewPasses: Math.min(Math.max(options?.reviewPasses ?? 1, 1), maxPasses),
    verifyFindings: options?.verifyFindings ?? true,
    timeBudgetMinutes: Math.max(options?.timeBudgetMinutes ?? 0, 0),
    reviewShards: Math.max(options?.reviewShards ?? 0, 0),
    modelOptions: options?.modelOptions ?? {},
    promptCache: options?.promptCache ?? true,
    skipDocOnly: options?.skipDocOnly ?? true,
    maxConcurrentSessions: Math.max(options?.maxConcurrentSessions ?? 0, 0),
    opencodePort: Math.max(options?.opencodePort ?? 0, 0),
    onReviewResult: options?.onReviewResult,
  };
}

const providerModelListCache = new Map<string, string[]>();

const MIN_FINDER_TIMEOUT_MS = 60_000;
// Ceiling for any single session even under a generous budget: callers who
// set time-budget-minutes 30+ for powerful models get the full 30-minute window.
const MAX_SESSION_TIMEOUT_MS = 30 * 60_000;
const POSTING_RESERVE_MS = 30_000;
const MIN_VERIFICATION_MS = 45_000;
const MAX_VERIFICATION_MS = 5 * 60_000;

/**
 * Finder sessions (main shards, lenses, aux checks) get the FULL budget
 * (minus the posting reserve) as their deadline: heavy reasoning models need
 * the whole window for a first attempt, and a starved first attempt just
 * converts into a retry that costs more wall clock overall. Retries and
 * verification adaptively use whatever remains — or are skipped, fail-open.
 * Returns undefined (default 15-minute cap) when no budget is set.
 */
export function computeFinderTimeoutMs(timeBudgetMinutes: number): number | undefined {
  if (timeBudgetMinutes <= 0) return undefined;
  const window = timeBudgetMinutes * 60_000 - POSTING_RESERVE_MS;
  const floor = Math.min(MIN_FINDER_TIMEOUT_MS, window);
  return Math.min(Math.max(window, floor), MAX_SESSION_TIMEOUT_MS);
}

/** Absolute run deadline for retries; undefined when no budget is set. */
export function computeRunDeadline(
  timeBudgetMinutes: number,
  runStartedAt: number,
): number | undefined {
  if (timeBudgetMinutes <= 0) return undefined;
  return runStartedAt + timeBudgetMinutes * 60_000 - POSTING_RESERVE_MS;
}

const MIN_RETRY_TIMEOUT_MS = 60_000;

/**
 * Timeout for a shard's single retry: whatever remains until the run
 * deadline, capped at the original finder timeout. Returns 0 (skip the
 * retry) when less than a usable minute remains; undefined deadline means
 * no budget — retry with the original timeout.
 */
export function computeRetryTimeoutMs(
  deadlineAt: number | undefined,
  now: number,
  finderTimeoutMs: number | undefined,
): number | undefined {
  if (deadlineAt === undefined) return finderTimeoutMs;
  const remaining = deadlineAt - now;
  if (remaining < MIN_RETRY_TIMEOUT_MS) return 0;
  return finderTimeoutMs === undefined ? remaining : Math.min(remaining, finderTimeoutMs);
}

/**
 * Verification runs last, so it gets whatever actually remains of the
 * budget. Returns undefined for no budget (default cap), 0 when too little
 * remains — the caller skips verification (fail-open: unverified findings
 * post rather than blow the budget or vanish).
 */
export function computeVerificationTimeoutMs(
  timeBudgetMinutes: number,
  elapsedMs: number,
): number | undefined {
  if (timeBudgetMinutes <= 0) return undefined;
  const remaining = timeBudgetMinutes * 60_000 - elapsedMs - POSTING_RESERVE_MS;
  if (remaining < MIN_VERIFICATION_MS) return 0;
  return Math.min(remaining, MAX_VERIFICATION_MS);
}

/**
 * Starts the extra recall passes in parallel with the main review. Each pass
 * is the full review prompt plus one focus lens; a failed lens pass costs
 * its own findings only, never the run.
 */
function startLensPasses(params: {
  client: Awaited<ReturnType<typeof startOpencode>>['client'];
  model: string;
  prContext: string;
  guidelinesForPrompt: string;
  passes: number;
  timeoutMs?: number;
  log: (msg: string) => void;
}): Promise<Finding[][]> {
  const lensKeys = selectLensKeys(params.passes);
  if (lensKeys.length === 0) return Promise.resolve([]);

  params.log(`Starting ${lensKeys.length} lens pass(es) in parallel: ${lensKeys.join(', ')}.`);
  return Promise.all(
    lensKeys.map((key) =>
      runReview(
        params.client,
        params.model,
        params.prContext,
        params.guidelinesForPrompt,
        params.log,
        {
          lensAddendum: REVIEW_LENSES[key],
          label: `review-${key}`,
          timeoutMs: params.timeoutMs,
        },
      )
        .then((result) => {
          params.log(`${key} lens pass complete: ${result.findings.length} finding(s).`);
          return result.findings;
        })
        .catch((error) => {
          params.log(
            `(skipped ${key} lens pass: ${error instanceof Error ? error.message : String(error)})`,
          );
          return [];
        }),
    ),
  );
}

/**
 * Adversarial precision gate: blocking findings are re-checked by a verifier
 * session prompted to refute them. Refuted findings are dropped, uncertain
 * ones demoted to advisory. Fail-open everywhere — when verification cannot
 * run or returns garbage, findings pass through unchanged.
 */
async function verifyBlockingFindings(params: {
  client: Awaited<ReturnType<typeof startOpencode>>['client'];
  model: string;
  prContext: string;
  findings: Finding[];
  enabled: boolean;
  timeoutMs?: number;
  log: (msg: string) => void;
}): Promise<Finding[]> {
  if (!params.enabled) return params.findings;
  if (params.timeoutMs === 0) {
    params.log(
      'Skipping finding verification: time budget exhausted; posting findings unverified (fail-open).',
    );
    return params.findings;
  }

  const selectedIndexes = selectBlockingFindingIndexes(params.findings, MAX_VERIFIED_FINDINGS);
  if (selectedIndexes.length === 0) return params.findings;

  const targets = selectedIndexes.map((index) => params.findings[index]);
  params.log(`Verifying ${targets.length} blocking finding(s) before posting.`);

  let verdicts;
  try {
    verdicts = await runFindingVerification(
      params.client,
      params.model,
      params.prContext,
      targets,
      params.log,
      params.timeoutMs,
    );
  } catch (error) {
    params.log(
      `(skipped finding verification: ${error instanceof Error ? error.message : String(error)})`,
    );
    return params.findings;
  }
  if (!verdicts) {
    params.log('(finding verification output unusable; keeping findings unverified)');
    return params.findings;
  }

  const application = applyFindingVerdicts(params.findings, selectedIndexes, verdicts);
  for (const { finding, reason } of application.dropped) {
    params.log(
      `Dropped refuted finding ${formatFindingLocation(finding)} "${finding.title}".${
        reason ? ` Reason: ${reason}` : ''
      }`,
    );
  }
  for (const { finding, reason } of application.demoted) {
    params.log(
      `Demoted uncertain finding ${formatFindingLocation(finding)} "${finding.title}" to P3.${
        reason ? ` Reason: ${reason}` : ''
      }`,
    );
  }
  return application.findings;
}

function filterFindings(findings: Finding[], options: NormalizedReviewRunOptions): Finding[] {
  const maxRank = SEVERITY_RANK[options.minSeverity];
  const filtered = findings.filter((finding) => SEVERITY_RANK[finding.severity] <= maxRank);
  if (options.maxFindings <= 0) return filtered;
  return [...filtered]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, options.maxFindings);
}

function formatInlineFinding(finding: Finding): string {
  const indentedBody = finding.body.replace(/\n/g, '\n  ');
  const metadata = formatFindingMetadata(finding);
  return `- ${formatFindingLocation(finding)} ${finding.severity}${metadata} ${finding.title}\n  ${indentedBody}`;
}

function formatAddressedPriorComment(comment: AddressedPriorComment): string {
  const commit = comment.addressedByCommit ? ` (${comment.addressedByCommit})` : '';
  const note = comment.note ? `: ${comment.note}` : '';
  return `- ${comment.id}${commit}${note}`;
}

function joinContext(...parts: string[]): string {
  return parts.filter(Boolean).join('\n\n');
}

interface ShardPlan {
  label: string;
  /** Context including the Context7 block (when active). */
  context: string;
  /** Context without the Context7 block, for the fallback retry. */
  baseContext: string;
  /** Changed files this shard may anchor findings in. */
  assignedFiles: string[];
}

/**
 * One plan per main-review session. A single shard reproduces the classic
 * whole-PR review; multiple shards each get the full core context (PR
 * metadata, guidelines pointers, prior threads, blast radius) plus their own
 * assignment block and diff slice, so every shard can reason across the
 * whole PR but anchors only in its files.
 */
function buildShardPlans(params: {
  coreContext: string;
  fullDiffBlock: string;
  context7Block: string;
  shards: ReturnType<typeof shardFilesForReview>;
}): ShardPlan[] {
  const { coreContext, fullDiffBlock, context7Block, shards } = params;
  if (shards.length <= 1) {
    const baseContext = joinContext(coreContext, fullDiffBlock);
    return [
      {
        label: 'review',
        context: joinContext(baseContext, context7Block),
        baseContext,
        assignedFiles: (shards[0] ?? []).map((file) => file.filename),
      },
    ];
  }
  return shards.map((shard, index) => {
    const assignedFiles = shard.map((file) => file.filename);
    const assignment = buildShardAssignmentBlock(assignedFiles, index, shards.length);
    const shardDiff = buildDiffHunksBlock(shard);
    return {
      label: `review-shard-${index + 1}`,
      context: joinContext(coreContext, context7Block, assignment, shardDiff),
      baseContext: joinContext(coreContext, assignment, shardDiff),
      assignedFiles,
    };
  });
}

/**
 * Runs the main review as parallel shard sessions and merges the results.
 * Wall clock is the slowest shard, not the whole PR. Each shard owns a slice
 * of the changed files, so an unrecovered main-shard failure is a coverage
 * hole and fails the main review. Auxiliary sessions fail open; main shards
 * do not. In sharded mode each shard's findings are clamped in code to its
 * assigned files so parallel shards cannot duplicate or poach each other.
 */
async function runShardedReview(params: {
  client: Awaited<ReturnType<typeof startOpencode>>['client'];
  model: string;
  guidelinesForPrompt: string;
  shardPlans: ShardPlan[];
  changedFiles: string[];
  timeoutMs?: number;
  /** Absolute run deadline (budget minus posting reserve); bounds retries. */
  deadlineAt?: number;
  context7Active: boolean;
  context7ApiKey: string;
  log: (msg: string) => void;
}): Promise<{ summary: string; findings: Finding[] }> {
  const { client, model, guidelinesForPrompt, shardPlans, timeoutMs, log } = params;
  const sharded = shardPlans.length > 1;
  const changed = new Set(params.changedFiles);

  let context7Disabled = false;
  const disableContext7Once = async () => {
    if (context7Disabled) return;
    context7Disabled = true;
    await disableContext7Mcp(client, log);
  };

  const outcomes: ShardOutcome[] = await Promise.all(
    shardPlans.map(async (plan): Promise<ShardOutcome> => {
      try {
        const result = await runReview(client, model, plan.context, guidelinesForPrompt, log, {
          label: plan.label,
          timeoutMs,
        });
        return { plan, result };
      } catch (error) {
        // One retry per shard in a fresh session, for ANY failure: upstream
        // streams drop ("Upstream idle timeout exceeded"), providers blip,
        // and a shard that died early still has budget left. Context7 is a
        // possible culprit, so the retry always uses the base context.
        if (params.context7Active) await disableContext7Once();
        const retryTimeoutMs = computeRetryTimeoutMs(params.deadlineAt, Date.now(), timeoutMs);
        if (retryTimeoutMs === 0) {
          log(
            `${plan.label} failed with no budget left for a retry: ${formatContext7Error(
              error,
              params.context7ApiKey,
            )}`,
          );
          return { plan, error };
        }
        log(
          `${plan.label} failed; retrying once in a fresh session: ${formatContext7Error(
            error,
            params.context7ApiKey,
          )}`,
        );
        try {
          const result = await runReview(
            client,
            model,
            plan.baseContext,
            guidelinesForPrompt,
            log,
            { label: `${plan.label}-retry`, timeoutMs: retryTimeoutMs },
          );
          return { plan, result };
        } catch (retryError) {
          return { plan, error: retryError };
        }
      }
    }),
  );

  const successes = outcomes.filter((outcome) => outcome.result !== undefined);
  const failures = outcomes.filter((outcome) => outcome.result === undefined);
  for (const failure of failures) {
    log(
      `${failure.plan.label} failed permanently: ${
        failure.error instanceof Error ? failure.error.message : String(failure.error)
      }`,
    );
  }
  if (failures.length > 0) {
    const first = failures[0]?.error;
    throw new Error(buildMainShardFailureMessage(failures.length, shardPlans.length, first));
  }

  const findings = successes.flatMap(({ plan, result }) => {
    if (!sharded) return result.findings;
    // Anchoring clamp: findings in another shard's changed file are that
    // shard's to report. Findings outside the changed set (orphaned notes)
    // pass through and dedupe by path:line.
    const assigned = new Set(plan.assignedFiles);
    const kept = result.findings.filter(
      (finding) => assigned.has(finding.path) || !changed.has(finding.path),
    );
    const clamped = result.findings.length - kept.length;
    if (clamped > 0) {
      log(`${plan.label}: dropped ${clamped} finding(s) anchored outside its assigned files.`);
    }
    return kept;
  });

  const summaryParts = successes.map(({ result }) => result.summary).filter(Boolean);
  const summary = condenseSummary(summaryParts);
  return { summary, findings };
}

export function buildMainShardFailureMessage(
  failedCount: number,
  totalCount: number,
  firstError: unknown,
): string {
  const reason =
    firstError instanceof Error
      ? firstError.message
      : firstError === undefined
        ? 'unknown error'
        : String(firstError);
  return `${failedCount} of ${totalCount} main review shard(s) failed; refusing to post partial review coverage. First failure: ${reason}`;
}

interface ReviewResultLike {
  summary: string;
  findings: Finding[];
}

type ShardOutcome =
  | { plan: ShardPlan; result: ReviewResultLike; error?: undefined }
  | { plan: ShardPlan; error: unknown; result?: undefined };

/**
 * Summary-field instructions ONLY. This block must never narrow review
 * scope: an earlier wording ("summarize only what changed since the latest
 * reviewed head... use git log/diff for prior..head") leaked into review
 * behavior on small models, which then reviewed only the delta and missed
 * cross-commit bugs — the single biggest recall gap versus competitor bots.
 */
export function buildSummaryScopeBlock(priorComments: string[], headSha?: string): string {
  const priorJbotReviews = priorComments.filter(isJbotReviewBody);
  const lines = [
    '## Summary instructions',
    '- These instructions affect ONLY the text of the "summary" field. They never change what you review: findings always come from the complete PR diff.',
    '- Prefer concise Markdown bullet points in the "summary" field when they make the review easier to scan.',
  ];

  if (priorJbotReviews.length === 0) {
    lines.push(
      '- This is the first visible jbot-review run for this PR, so summarize the overall PR change.',
    );
    return lines.join('\n');
  }

  const latestReviewedHead = findLatestReviewedHead(priorJbotReviews);
  lines.push(
    '- This PR already has prior jbot-review runs, so the summary TEXT should describe what changed since the latest prior reviewed head instead of restating the full PR summary. Your review and findings still cover the full PR diff.',
  );
  if (latestReviewedHead && headSha && latestReviewedHead !== headSha) {
    lines.push(`- Latest prior reviewed head: ${latestReviewedHead}. Current head: ${headSha}.`);
  } else if (latestReviewedHead) {
    lines.push(`- Latest prior reviewed head: ${latestReviewedHead}.`);
  }

  return lines.join('\n');
}

function buildContext7PromptBlock(reason: string): string {
  return [
    '## Context7 documentation lookup',
    `Context7 MCP is available for this run because ${reason}.`,
    'Use Context7 only to verify changed external API, SDK, framework, CLI, cloud-service, or GitHub Actions usage. Do not use it for ordinary business-logic review.',
    'If Context7 is unavailable or does not return relevant documentation, continue the review from the repository diff and local evidence.',
  ].join('\n');
}

function buildReviewFocusBlock(changedFiles: string[]): string {
  const focusItems = new Set<string>();

  for (const file of changedFiles) {
    if (PATH_PATTERNS.tooling.test(file)) {
      focusItems.add('External/tooling: inputs, permissions, auth, versions, failure modes.');
    }
    if (PATH_PATTERNS.api.test(file)) {
      focusItems.add('API/server: validation, auth/authz, idempotency, response contracts.');
    }
    if (PATH_PATTERNS.data.test(file)) {
      focusItems.add('Data: compatibility, migration order, defaults, nullability, indexes.');
    }
    if (PATH_PATTERNS.security.test(file)) {
      focusItems.add('Security: privilege, tokens, tenant isolation, unsafe input boundaries.');
    }
    if (
      /\.(tsx|jsx|vue|svelte)$/i.test(file) ||
      /(^|\/)(components?|pages?|app|frontend|ui)\//i.test(file)
    ) {
      focusItems.add(
        'Frontend: loading/error states, stale async state, accessibility, API assumptions.',
      );
    }
    if (PATH_PATTERNS.tests.test(file)) {
      focusItems.add('Tests: assertions cover changed behavior and do not mask failures.');
    }
  }

  if (focusItems.size === 0) {
    focusItems.add(
      'General correctness: trace behavior through callers, error paths, contracts, and tests.',
    );
  }

  return [
    '## Relevant review focus',
    'Use only as relevant checklists; do not invent findings.',
    ...[...focusItems].map((item) => `- ${item}`),
  ].join('\n');
}

function findLatestReviewedHead(priorJbotReviews: string[]): string | undefined {
  for (const review of [...priorJbotReviews].reverse()) {
    const reviewedHeadLine = review.match(/\*\*Reviewed head:\*\*([^\n]+)/i);
    const reviewedHeadText = reviewedHeadLine?.[1] ?? '';
    const match =
      reviewedHeadText.match(/\/commit\/([0-9a-f]{40})\b/i) ??
      reviewedHeadText.match(/`([0-9a-f]{7,40})`/i);
    if (match) return match[1];
  }
  return undefined;
}

async function safeListPriorJbotThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  log: (msg: string) => void,
): Promise<PriorJbotThread[]> {
  try {
    return await listPriorJbotThreads(octokit, owner, repo, pullNumber);
  } catch (error) {
    log(
      `Prior jbot-review thread lookup skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function startAddressedPriorCommentsCheck(params: {
  client: Awaited<ReturnType<typeof startOpencode>>['client'];
  model: string;
  prContext: string;
  priorJbotThreads: PriorJbotThread[];
  timeoutMs?: number;
  log: (msg: string) => void;
}): Promise<AddressedPriorComment[]> {
  if (params.priorJbotThreads.length === 0) return Promise.resolve([]);

  params.log('Starting addressed-prior-comments check in parallel.');
  return runAddressedPriorCommentsCheck(
    params.client,
    params.model,
    params.prContext,
    params.log,
    params.timeoutMs,
  )
    .then((independentlyAddressed) => {
      params.log(
        `Addressed-prior-comments check complete: ${independentlyAddressed.length} addressed prior comment(s)`,
      );
      return independentlyAddressed;
    })
    .catch((error) => {
      params.log(
        `(skipped addressed-prior-comments check: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return [];
    });
}

function startGuidelineComplianceCheck(params: {
  client: Awaited<ReturnType<typeof startOpencode>>['client'];
  model: string;
  prContext: string;
  guidelinesForPrompt: string;
  hasGuidelines: boolean;
  enabled: boolean;
  timeoutMs?: number;
  log: (msg: string) => void;
}): Promise<Finding[]> {
  if (!params.enabled) return Promise.resolve([]);
  if (!params.hasGuidelines) {
    params.log('Guideline-compliance check skipped: no repository guidelines discovered.');
    return Promise.resolve([]);
  }

  params.log('Starting guideline-compliance check in parallel.');
  return runGuidelineComplianceCheck(
    params.client,
    params.model,
    params.prContext,
    params.guidelinesForPrompt,
    params.log,
    params.timeoutMs,
  )
    .then((findings) => {
      params.log(`Guideline-compliance check complete: ${findings.length} finding(s)`);
      return findings;
    })
    .catch((error) => {
      params.log(
        `(skipped guideline-compliance check: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      return [];
    });
}

async function acknowledgeAddressedPriorComments(params: {
  octokit: Octokit;
  threadResolutionOctokit?: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha?: string;
  priorJbotThreads: PriorJbotThread[];
  addressedPriorComments: AddressedPriorComment[];
  log: (msg: string) => void;
}): Promise<void> {
  if (params.addressedPriorComments.length === 0 || params.priorJbotThreads.length === 0) return;

  const threadsById = new Map(params.priorJbotThreads.map((thread) => [thread.id, thread]));
  const seen = new Set<string>();
  for (const addressed of params.addressedPriorComments) {
    if (seen.has(addressed.id)) continue;
    seen.add(addressed.id);

    const thread = threadsById.get(addressed.id);
    if (!thread) {
      params.log(`Skipping addressed prior comment with unknown thread id: ${addressed.id}`);
      continue;
    }

    const addressedByCommit = addressed.addressedByCommit || params.headSha || 'the latest commit';
    try {
      await postAddressedThreadReply({
        octokit: params.octokit,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        thread,
        addressedByCommit,
        note: addressed.note,
      });
      params.log(`Posted addressed reply for prior thread ${thread.id}`);
    } catch (error) {
      params.log(
        `Failed to reply to addressed prior thread ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    if (thread.isResolved) continue;
    try {
      await resolveReviewThread(params.threadResolutionOctokit ?? params.octokit, thread.id);
      params.log(`Resolved prior jbot-review thread ${thread.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint =
        !params.threadResolutionOctokit && isResourceNotAccessibleByIntegration(message)
          ? ' Set the thread-resolution-token input to a token that can resolve review threads.'
          : '';
      params.log(`Failed to resolve prior jbot-review thread ${thread.id}: ${message}${hint}`);
    }
  }
}

function isResourceNotAccessibleByIntegration(message: string): boolean {
  return message.toLowerCase().includes('resource not accessible by integration');
}

function buildBody(
  summary: string,
  all: Finding[],
  orphaned: Finding[],
  model: string,
  owner: string,
  repo: string,
  headSha?: string,
): string {
  const total = all.length;
  const lines = ['## J-Bot Code Review', '', summary || 'No summary provided.', ''];
  const guidance = getMergeGuidance(all);
  lines.push(`**Review state:** ${guidance.state}`, '');
  lines.push(`**Merge guidance:** ${guidance.mergeGuidance}`, '');
  if (headSha) {
    lines.push(
      `**Reviewed head:** [\`${headSha.slice(0, 12)}\`](https://github.com/${owner}/${repo}/commit/${headSha})`,
      '',
    );
  }
  if (total === 0) {
    lines.push('✅ _No new findings._');
  } else {
    lines.push('### Findings Summary', '', ...buildSeverityTable(all), '');
  }
  const orphanedSection = renderOrphanedSection(orphaned);
  if (orphanedSection.length > 0) lines.push(...orphanedSection);
  lines.push('', `<sup>Reviewed with \`${model}\`.</sup>`);
  return lines.join('\n');
}

function getMergeGuidance(findings: Pick<Finding, 'severity'>[]): {
  state: string;
  mergeGuidance: string;
} {
  if (findings.length === 0) {
    return {
      state: 'Good to go from jbot-review',
      mergeGuidance: 'No new findings were found in this review run.',
    };
  }

  const hasBlockingFinding = findings.some(
    (finding) => SEVERITY_RANK[finding.severity] <= SEVERITY_RANK.P2,
  );
  if (hasBlockingFinding) {
    return {
      state: 'Needs changes before approval',
      mergeGuidance: 'Address the P0/P1/P2 findings before treating this PR as ready to approve.',
    };
  }

  return {
    state: 'Mergeable with non-blocking comments',
    mergeGuidance: 'Only P3/nit findings were found; jbot-review does not consider these blocking.',
  };
}

function buildSeverityTable(findings: Pick<Finding, 'severity'>[]): string[] {
  const counts = countBySeverity(findings);
  return [
    '| Total | P0 | P1 | P2 | P3 | nit |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${findings.length} | ${counts.P0} | ${counts.P1} | ${counts.P2} | ${counts.P3} | ${counts.nit} |`,
  ];
}

function countBySeverity(findings: Pick<Finding, 'severity'>[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0, nit: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}
