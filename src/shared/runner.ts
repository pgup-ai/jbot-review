import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  SEVERITY_RANK,
  applyFindingVerdicts,
  anchorFindings,
  dedupeFindings,
  demoteLowConfidenceBlockingFindings,
  resolveFindingAnchors,
  isNoiseFile,
  isPrCleanAfterRun,
  openFindingThreadIds,
  selectBlockingFindingIndexes,
  shouldPostReviewComment,
  suppressPreviouslyReported,
} from './filter.ts';
import {
  ASSEMBLED_CONTEXT_WARN_BYTES,
  assembledContextWarning,
  createPhaseTelemetryTracker,
  createTelemetryRecorder,
  type RunTerminalState,
  type SessionCoverageRecorder,
  type TelemetryRecorder,
} from './telemetry.ts';
import { buildSupplementaryBlocks, trimContextBlocks } from './context-trim.ts';
import type { ContextBlock } from './context-trim.ts';
import {
  backendRequiresCompleteEmbeddedDiff,
  selectReviewBackends,
  type CliBackendID,
} from './backend-selection.ts';
import { limitReviewBackendSessions, type ReviewBackend } from './session-concurrency.ts';
import {
  loadCachedShardResult,
  resolveShardCacheDir,
  saveShardResult,
  shardFingerprint,
} from './shard-cache.ts';
import { closeObserver, reportRun, setRunName } from './observer.ts';
import { createAcpBackend } from './acp.ts';
import { codexAcpSpec, cursorAcpSpec, kiloAcpSpec } from '@symma/protocol';
import {
  ACP_GATEWAY_PROVIDERS,
  checkAuxGatewayEndpointReady,
  checkGatewayEndpointReady,
  createRemoteAcpBackend,
  remoteAcpConfigFromEnv,
} from './acp-remote.ts';
import {
  abortPiSessionsByLabel,
  piModelAvailable,
  piSupportsProvider,
  resolvePiEngine,
  runPiAddressedPriorCommentsCheck,
  runPiChangesSinceLastReview,
  runPiFindingVerification,
  runPiGuidelineComplianceCheck,
  runPiReview,
  startPi,
  PI_TELEMETRY_CAPABILITY,
  type PiRuntime,
} from './pi.ts';
import {
  assertPoolsideApiKey,
  poolsideReasoningEffort,
  runPoolsideAddressedPriorCommentsCheck,
  runPoolsideChangesSinceLastReview,
  runPoolsideFindingVerification,
  runPoolsideGuidelineComplianceCheck,
  runPoolsideReview,
  POOLSIDE_TELEMETRY_CAPABILITY,
} from './poolside.ts';
import { buildBlastRadiusBlock } from './blast-radius.ts';
import {
  type DiffHunksOptions,
  buildDiffHunksBlockWithMetadata,
  classifyChangeShape,
  isDocOnlyChange,
  shardFilesForReview,
  touchesRiskyPath,
} from './diff-context.ts';
import {
  auxModelOptionsFor,
  needsAuxOpencodeConfig,
  resolvePromptCachePolicy,
  supportedModelOptions,
  verificationModelOptions,
} from './config.ts';
import { parseModelName } from '@symma/protocol';
import { parseAddedLines } from './patch.ts';
import {
  COUNTED_LENS_KEYS,
  REVIEW_LENSES,
  UNTRUSTED_PR_CONTENT_NOTE,
  buildChangesSinceContextBlock,
  buildContext7PromptBlock,
  buildContextTrimNotice,
  buildReviewFocusBlock,
  buildShardAssignmentBlock,
  selectLensKeys,
} from './prompt.ts';
import { ensureGitSafeDirectory, hydratePrFilePatches } from './git.ts';
import { onFatalSignal } from '@symma/protocol';
import {
  abortOpencodeSessionsByLabel,
  startOpencode,
  withTimeout,
  configureSessionConcurrency,
  runReview as runOpencodeReview,
  runAddressedPriorCommentsCheck as runOpencodeAddressedPriorCommentsCheck,
  runFindingVerification as runOpencodeFindingVerification,
  runGuidelineComplianceCheck as runOpencodeGuidelineComplianceCheck,
  runChangesSinceLastReview as runOpencodeChangesSinceLastReview,
  listProviderModels,
  enableContext7Mcp,
  disableContext7Mcp,
  formatContext7Error,
  Semaphore,
  OPENCODE_TELEMETRY_CAPABILITY,
  configureOpencodeTelemetry,
} from './opencode.ts';
import type { PromptTokenUsage, TokenUsageRecorder } from './opencode.ts';
import { DEVIN_PROVIDER_ID, writeDevinCredentials } from '@symma/protocol';
import { createDevinCliBackend } from './devin-cli.ts';
import {
  COMMANDCODE_PROVIDER_ID,
  COMMANDCODE_TELEMETRY_CAPABILITY,
  listCommandCodeModels,
  runCommandCodeAddressedPriorCommentsCheck,
  runCommandCodeFindingVerification,
  runCommandCodeGuidelineComplianceCheck,
  runCommandCodeChangesSinceLastReview,
  runCommandCodeReview,
  writeCommandCodeAuth,
  writeCommandCodeReadOnlySettings,
} from './commandcode.ts';
import {
  CODEX_PROVIDER_ID,
  CURSOR_PROVIDER_ID,
  listCursorModels,
  writeCodexAuth,
} from '@symma/protocol';
import {
  CLINE_PROVIDER_ID,
  CLINE_TELEMETRY_CAPABILITY,
  runClineAddressedPriorCommentsCheck,
  runClineChangesSinceLastReview,
  runClineFindingVerification,
  runClineGuidelineComplianceCheck,
  runClineReview,
  writeClineAuth,
} from './cline.ts';
import {
  GROK_PROVIDER_ID,
  GROK_TELEMETRY_CAPABILITY,
  assertGrokAuthenticated,
  configureGrokHome,
  runGrokAddressedPriorCommentsCheck,
  runGrokChangesSinceLastReview,
  runGrokFindingVerification,
  runGrokGuidelineComplianceCheck,
  runGrokReview,
  type GrokRuntime,
} from './grok.ts';
import {
  DIM_PROVIDER_ID,
  DIM_TELEMETRY_CAPABILITY,
  decodeDimBundle,
  runDimAddressedPriorCommentsCheck,
  runDimChangesSinceLastReview,
  runDimFindingVerification,
  runDimGuidelineComplianceCheck,
  runDimReview,
  type DimRuntime,
} from './dim.ts';
import { assertValidKiloAuth, KILO_PROVIDER_ID, listKiloModels } from '@symma/protocol';
import {
  QODER_PROVIDER_ID,
  QODER_TELEMETRY_CAPABILITY,
  runQoderAddressedPriorCommentsCheck,
  runQoderChangesSinceLastReview,
  runQoderFindingVerification,
  runQoderGuidelineComplianceCheck,
  runQoderReview,
} from './qoder.ts';
import { createToolTelemetryAccumulator, type ToolTelemetryAccumulator } from './tool-telemetry.ts';
import {
  buildReviewContext,
  discoverGuidelineDocs,
  formatGuidelines,
  formatFinderGuidelines,
  formatDiffScope,
  formatContextBudget,
  selectFinderGuidelineText,
  truncatePrBody,
  type LinkedIssue,
  type ReviewCommit,
} from './review-context.ts';
import {
  assertRecoverableCoverage,
  enforcesExplorationBudget,
  planExploration,
  selectExplorationTier,
  type ExplorationPlan,
  type ExplorationTier,
} from './exploration-policy.ts';
import { planReviewFanout, planIncrementalLenses } from './fanout.ts';
import { decideContext7Mode, type Context7Mode } from './context7.ts';
import {
  listPrFiles,
  compareCommitFiles,
  listPrComments,
  listPrCommits,
  listClosingIssues,
  getCheckStatusSummary,
  formatFindingLabel,
  formatFindingLocation,
  getPullFreshness,
  postFileLevelComment,
  addPrReaction,
  removeOwnPrReaction,
  postReview,
  checkAutoApprovalEligibility,
  postApprovalReview,
  decideVerdict,
  listPriorJbotThreads,
  formatPriorJbotThreadsForPrompt,
  postAddressedThreadReply,
  resolveReviewThread,
  minimizePullRequestReview,
  isJbotReviewBody,
  selectResolvedJbotReviewsToFinalize,
  compactJbotReviewBody,
  updateReviewBody,
  type JbotReviewGroup,
  type Octokit,
  type PrFile,
  type PriorJbotThread,
  type PriorJbotThreads,
} from './github.ts';
import { isDefinitiveApprovalRejection, type AutoApprovalDecision } from './approval.ts';
import {
  classifyMainShardFailure,
  STALE_CHECK_MIN_ATTEMPT_MS,
  StaleReviewError,
} from './retry-policy.ts';
import { condenseSummary, formatSummaryMarkdown, renderOrphanedSection } from './report.ts';
import { formatFileList, formatUsageCost, isFiniteNumber } from './text.ts';
import type { AddressedPriorComment, Finding, Severity } from './types.ts';

/** Blocking findings verified per run; the rest pass through unverified. */
const MAX_VERIFIED_FINDINGS = 10;
/**
 * Unbounded on purpose. For a backend that can read the checkout a diff budget
 * caps prompt size, and anything it drops the model fetches with git. For a
 * backend that cannot, the same number caps coverage instead: a dropped file is
 * never reviewed. Every changed file is embedded whole at any shard count, and
 * an oversized PR fails loudly at the provider rather than being reviewed in
 * part and reported as whole.
 */
export const EMBEDDED_ONLY_BACKEND_DIFF_HUNKS_OPTIONS: DiffHunksOptions = {
  totalBudgetBytes: Number.POSITIVE_INFINITY,
  perFileBudgetBytes: Number.POSITIVE_INFINITY,
};

function createOpencodeBackend(
  client: Awaited<ReturnType<typeof startOpencode>>['client'],
  toolTelemetry?: ToolTelemetryAccumulator,
): ReviewBackend {
  if (toolTelemetry) configureOpencodeTelemetry(client, toolTelemetry);
  return {
    name: 'opencode',
    observability: OPENCODE_TELEMETRY_CAPABILITY,
    abortSessionsByLabel: (label, log) => abortOpencodeSessionsByLabel(client, label, log),
    runReview: (model, prContext, guidelines, log, options) =>
      runOpencodeReview(client, model, prContext, guidelines, log, options),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runOpencodeAddressedPriorCommentsCheck(
        client,
        model,
        prContext,
        log,
        timeoutMs,
        onTokenUsage,
      ),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runOpencodeGuidelineComplianceCheck(
        client,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage, modelOptions) =>
      runOpencodeFindingVerification(
        client,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
        modelOptions,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runOpencodeChangesSinceLastReview(
        client,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
      ),
  };
}

function createPiBackend(runtime: PiRuntime): ReviewBackend {
  return {
    name: 'pi',
    observability: PI_TELEMETRY_CAPABILITY,
    abortSessionsByLabel: (label, log) => abortPiSessionsByLabel(runtime, label, log),
    runReview: (model, prContext, guidelines, log, options) =>
      runPiReview(runtime, model, prContext, guidelines, log, options),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runPiAddressedPriorCommentsCheck(runtime, model, prContext, log, timeoutMs, onTokenUsage),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runPiGuidelineComplianceCheck(
        runtime,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage, modelOptions) =>
      runPiFindingVerification(
        runtime,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
        modelOptions,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runPiChangesSinceLastReview(
        runtime,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
      ),
  };
}

function createPoolsideBackend(
  apiKey: string,
  modelOptions?: Record<string, unknown>,
): ReviewBackend {
  const key = assertPoolsideApiKey(apiKey);
  const reasoningEffort = poolsideReasoningEffort(modelOptions);
  return {
    name: 'poolside',
    observability: POOLSIDE_TELEMETRY_CAPABILITY,
    runReview: (model, prContext, guidelines, log, options) =>
      runPoolsideReview(key, reasoningEffort, model, prContext, guidelines, log, options),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runPoolsideAddressedPriorCommentsCheck(
        key,
        reasoningEffort,
        model,
        prContext,
        log,
        timeoutMs,
        onTokenUsage,
      ),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runPoolsideGuidelineComplianceCheck(
        key,
        reasoningEffort,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage) =>
      runPoolsideFindingVerification(
        key,
        reasoningEffort,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runPoolsideChangesSinceLastReview(
        key,
        reasoningEffort,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
      ),
  };
}

function createCommandCodeBackend(workspace: string, home: string): ReviewBackend {
  return {
    name: COMMANDCODE_PROVIDER_ID,
    observability: COMMANDCODE_TELEMETRY_CAPABILITY,
    runReview: (model, prContext, guidelines, log, options) =>
      runCommandCodeReview(workspace, model, prContext, guidelines, log, {
        ...options,
        home,
      }),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runCommandCodeAddressedPriorCommentsCheck(
        workspace,
        model,
        prContext,
        log,
        timeoutMs,
        onTokenUsage,
        home,
      ),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runCommandCodeGuidelineComplianceCheck(
        workspace,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
        home,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage) =>
      runCommandCodeFindingVerification(
        workspace,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
        home,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runCommandCodeChangesSinceLastReview(
        workspace,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
        home,
      ),
  };
}

function createClineBackend(workspace: string, clineHome: string): ReviewBackend {
  return {
    name: CLINE_PROVIDER_ID,
    observability: CLINE_TELEMETRY_CAPABILITY,
    runReview: (model, prContext, guidelines, log, options) =>
      runClineReview(workspace, model, prContext, guidelines, log, {
        ...options,
        home: clineHome,
      }),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runClineAddressedPriorCommentsCheck(
        workspace,
        model,
        prContext,
        log,
        timeoutMs,
        onTokenUsage,
        clineHome,
      ),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runClineGuidelineComplianceCheck(
        workspace,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
        clineHome,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage) =>
      runClineFindingVerification(
        workspace,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
        clineHome,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runClineChangesSinceLastReview(
        workspace,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
        clineHome,
      ),
  };
}

function createGrokBackend(runtime: GrokRuntime): ReviewBackend {
  return {
    name: GROK_PROVIDER_ID,
    observability: GROK_TELEMETRY_CAPABILITY,
    runReview: (model, prContext, guidelines, log, options) =>
      runGrokReview(model, prContext, guidelines, log, {
        ...options,
        runtime,
      }),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runGrokAddressedPriorCommentsCheck(model, prContext, log, timeoutMs, onTokenUsage, runtime),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runGrokGuidelineComplianceCheck(
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
        runtime,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage) =>
      runGrokFindingVerification(model, prContext, findings, log, timeoutMs, onTokenUsage, runtime),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runGrokChangesSinceLastReview(
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
        runtime,
      ),
  };
}

function createDimBackend(
  workspace: string,
  runtime: DimRuntime,
  toolTelemetry?: ToolTelemetryAccumulator,
): ReviewBackend {
  if (toolTelemetry) runtime.toolTelemetry = toolTelemetry;
  return {
    name: DIM_PROVIDER_ID,
    observability: DIM_TELEMETRY_CAPABILITY,
    runReview: (model, prContext, guidelines, log, options) =>
      runDimReview(workspace, model, prContext, guidelines, log, { ...options, runtime }),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runDimAddressedPriorCommentsCheck(
        workspace,
        model,
        prContext,
        log,
        timeoutMs,
        onTokenUsage,
        runtime,
      ),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runDimGuidelineComplianceCheck(
        workspace,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
        runtime,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage) =>
      runDimFindingVerification(
        workspace,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
        runtime,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runDimChangesSinceLastReview(
        workspace,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
        runtime,
      ),
  };
}

function createQoderBackend(
  workspace: string,
  token: string,
  toolTelemetry?: ToolTelemetryAccumulator,
): ReviewBackend {
  return {
    name: QODER_PROVIDER_ID,
    observability: QODER_TELEMETRY_CAPABILITY,
    runReview: (model, prContext, guidelines, log, options) =>
      runQoderReview(workspace, model, prContext, guidelines, log, {
        ...options,
        token,
        toolTelemetry,
      }),
    runAddressedPriorCommentsCheck: (model, prContext, log, timeoutMs, onTokenUsage) =>
      runQoderAddressedPriorCommentsCheck(
        workspace,
        model,
        prContext,
        log,
        timeoutMs,
        onTokenUsage,
        token,
        toolTelemetry,
      ),
    runGuidelineComplianceCheck: (model, prContext, guidelines, log, timeoutMs, onTokenUsage) =>
      runQoderGuidelineComplianceCheck(
        workspace,
        model,
        prContext,
        guidelines,
        log,
        timeoutMs,
        onTokenUsage,
        token,
        toolTelemetry,
      ),
    runFindingVerification: (model, prContext, findings, log, timeoutMs, onTokenUsage) =>
      runQoderFindingVerification(
        workspace,
        model,
        prContext,
        findings,
        log,
        timeoutMs,
        onTokenUsage,
        token,
        toolTelemetry,
      ),
    runChangesSinceLastReview: (model, prContext, deltaContext, log, timeoutMs, onTokenUsage) =>
      runQoderChangesSinceLastReview(
        workspace,
        model,
        prContext,
        deltaContext,
        log,
        timeoutMs,
        onTokenUsage,
        token,
        toolTelemetry,
      ),
  };
}

function requireCliBackend(
  backends: Record<CliBackendID, ReviewBackend | undefined>,
  backendID: CliBackendID,
): ReviewBackend {
  const backend = backends[backendID];
  if (!backend) {
    throw new Error(`CLI backend "${backendID}" was selected but was not initialized.`);
  }
  return backend;
}

function requireSdkBackend(
  backend: ReviewBackend | undefined,
  engine: 'opencode' | 'pi' | 'poolside',
  role: 'main' | 'aux',
): ReviewBackend {
  if (!backend) {
    throw new Error(`${engine} backend was selected for ${role} sessions but was not initialized.`);
  }
  return backend;
}

/**
 * Stand-in client for local mode (no token, no Octokit): any property access
 * throws. Reads are short-circuited on `localDiff`, writes are unreachable
 * (localDiff forces dryRun), so a throw here means a GitHub call site the
 * local-mode seam missed — fail loudly rather than corrupt the run.
 */
function missingOctokit(): Octokit {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`GitHub client not available in local mode (octokit.${String(prop)})`);
      },
    },
  ) as unknown as Octokit;
}

export interface ReviewRunOptions {
  enhancedContext?: boolean;
  /**
   * Withhold credential env vars from the opencode child (default on). The
   * scrub mutates process-global env for the spawn window, so a process that
   * runs REVIEWS CONCURRENTLY (the webhook app) must turn it off — a sibling
   * run's env reads would race the window.
   */
  scrubSessionEnv?: boolean;
  /** Environment scoped to the opencode child process. */
  opencodeProxyEnv?: NodeJS.ProcessEnv;
  /** SDK routing override; blank defers to JBOT_SDK_ENGINE, then auto. */
  sdkEngine?: string;
  dryRun?: boolean;
  /** Approve an exact reviewed head when no new or open jbot findings remain. */
  autoApprove?: boolean;
  maxFindings?: number;
  minSeverity?: Severity;
  includePriorComments?: boolean;
  context7Mode?: Context7Mode;
  context7ApiKey?: string;
  guidelinePass?: boolean;
  /**
   * Directory for content-addressed reuse of completed shard results across
   * same-content re-runs. Must live OUTSIDE the reviewed checkout (the
   * workspace is the PR author's tree — a cache inside it is forgeable) and
   * is therefore off ('') unless an operator configures a path.
   */
  shardCachePath?: string;
  /**
   * Drop supplementary context blocks to hold the assembled-context soft cap.
   * Off by default: an unmeasured recall trade, kept as an A/B arm until
   * finding-level telemetry says which side wins.
   */
  contextTrim?: boolean;
  /** Treat embedded diff hunks as already read. On; JBOT_EMBEDDED_FIRST_PROMPT=false opts out. */
  embeddedFirstPrompt?: boolean;
  /**
   * Finder guideline text when the compliance pass is skipped: 'auto' keeps
   * the relevance slice for tool-capable finders (omitted docs named for
   * on-demand reads); 'full' restores the old widen-everywhere behavior
   * (JBOT_GUIDELINE_WIDEN=full). Checkout-blind finders always widen.
   */
  guidelineWiden?: 'auto' | 'full';
  /**
   * TASK-065 arm: verification judges from a slim claim-checking context
   * (title/body/diff scope, linked issues, changed files, full diff) instead
   * of the whole finder context. Off by default — the verifier is a precision
   * gate, so the flip waits on adjudicated benchmark evidence.
   */
  verifierSlimContext?: boolean;
  /**
   * Model for the auxiliary sessions (addressed-check, guideline compliance,
   * finding verification). Lets the main review run on a stronger tier while
   * the mechanical checks stay on a cheap one. Empty = use the main model.
   */
  auxModel?: string;
  /**
   * Optional API key for the auxiliary model provider when it differs from the
   * main model provider. Empty = reuse the main review API key.
   */
  auxApiKey?: string;
  /** Base URL for an auxiliary custom provider when it differs from the main provider. */
  auxBaseURL?: string;
  /**
   * Total review passes: 1 = the general pass only; each extra pass adds the
   * next count-rationed recall lens (interactions, then integrity) in parallel.
   * The frontend lens is content-triggered, not passes-rationed: a PR that
   * touches frontend files runs it IN ADDITION (when passes >= 2), so a frontend
   * PR runs one more aux session than `passes` implies. Findings are merged and
   * deduped, so extra passes raise recall at roughly one session each.
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
   * Provider options for the MAIN model — e.g. {"reasoningEffort":"medium"}
   * to cap reasoning spend on heavy models. An aux model running an entry of
   * its own gets defaultAuxModelOptions instead; one that IS the main model
   * shares this.
   */
  modelOptions?: Record<string, unknown>;
  /**
   * Enable opencode prompt caching (provider `setCacheKey`). Default true:
   * parallel shards and re-reviews share a byte-identical prompt prefix, so
   * caching cuts input-token cost on models that honor it. Models marked
   * unsupported omit the cache key entirely. Per-session cache hits are
   * logged via `formatTokenUsage`.
   */
  promptCache?: boolean;
  /**
   * Skip the full LLM review when every REVIEWABLE changed file is a
   * doc/prose/diagram asset (deterministic, see `isDocOnlyChange`). Evaluated
   * on the reviewable set — noise files (lockfiles, generated) and
   * patchless/binary files are already excluded, and the bot never reviews
   * those regardless, so the skip never suppresses content a full review
   * would have covered. Any reviewable code/config file forces a full review.
   * Default true: a docs-only PR is skipped with no review session (saving
   * the whole model cost) and leaves the review reaction unchanged.
   */
  skipDocOnly?: boolean;
  /** Scale recall-supplement fan-out down for low-risk diffs (see `fanout.ts`); default true. Never gates the main review or verify; false forces full fan-out. */
  dynamicFanout?: boolean;
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
  /** Emit per-finding disposition + per-session telemetry. Default true; off is fully inert. */
  reviewTelemetry?: boolean;
  /**
   * Ask each finding for a verbatim `evidence` quote of the flagged line:
   * grounds verification and enables orphan re-anchoring. Default true; off
   * keeps the prompt byte-identical to the pre-evidence review.
   */
  evidenceQuotes?: boolean;
  /**
   * Fires when a review completes (dry-run OR a real post) with the final filtered
   * findings + summary. Used by the dry-run harness and by the worker (to forward
   * per-severity counts to the control plane). Not a GitHub Action input.
   */
  onReviewResult?: (result: {
    summary: string;
    findings: Finding[];
    addressedPriorComments: AddressedPriorComment[];
    /** JSONL telemetry (finding + session rows); present when reviewTelemetry is on. */
    telemetry?: string;
  }) => void;
}

async function runReviewPipeline(params: {
  /** Required for the GitHub-backed paths; optional when `localDiff` is provided. */
  octokit?: Octokit;
  /**
   * Deliberately NOT proxy-defaulted like `octokit`: its undefined-ness is
   * load-bearing. Its consumers fall back `?? octokit` (in local mode
   * that IS the landmine proxy, so no bare-undefined access exists), and the
   * missing-token error hint keys off `!threadResolutionOctokit` — a proxy
   * default would break both on GitHub runs without a resolution token.
   */
  threadResolutionOctokit?: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  pullTitle: string;
  pullBody: string;
  workspace: string;
  model: string;
  apiKey: string;
  /** Base URL for a custom main provider. Native Models.dev providers leave this unset. */
  baseURL?: string;
  /** Required for GitHub-backed reviews; local worktree reviews omit it. */
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  preparePatchRecovery?: () => Promise<void> | void;
  /**
   * Local-mode diff source (`npm run review:local`): the COMPLETE
   * merge-base-relative diff (invariant #1) plus the local commit log.
   * Replaces every GitHub read and forces dryRun, so a run with it set
   * performs no GitHub API call at all.
   */
  localDiff?: { files: PrFile[]; commits: ReviewCommit[] };
  options?: ReviewRunOptions;
  /**
   * Internal: runPrReview installs the pipeline's failure finalizer here so a
   * throw anywhere after the recorder exists — setup, sessions, or posting —
   * still emits the run's terminal telemetry.
   */
  telemetryLifecycle?: { onFailure?: () => void };
  log: (msg: string) => void;
}): Promise<void> {
  const {
    owner,
    repo,
    pullNumber,
    pullTitle,
    pullBody,
    workspace,
    model,
    apiKey,
    baseURL,
    headSha,
    baseRef,
    baseSha,
    localDiff,
    log,
  } = params;
  // Local mode passes no client; the landmine default keeps the write sites
  // type-clean and turns any GitHub call the localDiff short-circuits missed
  // into a loud failure instead of a silent one.
  const octokit = params.octokit ?? missingOctokit();
  const options = normalizeOptions(params.options);
  // Trust boundary in code (invariant #2): a local diff must never reach the
  // posting paths, so local mode is only usable as a dry run.
  if (localDiff && !options.dryRun) {
    throw new Error('localDiff requires dryRun: true; local mode must never post to GitHub.');
  }
  // A GitHub-backed run needs a real client; fail with the accurate reason
  // rather than letting a later read hit the local-mode Proxy and mislead.
  if (!localDiff && !params.octokit) {
    throw new Error('runPrReview requires an octokit client unless localDiff is provided.');
  }
  if (!localDiff && !headSha) {
    throw new Error('runPrReview requires headSha for GitHub-backed reviews.');
  }
  const runStartedAt = Date.now();
  const finderTimeoutMs = computeFinderTimeoutMs(options.timeBudgetMinutes);
  if (finderTimeoutMs) {
    log(
      `Time budget ${options.timeBudgetMinutes}m: finder sessions capped at ${Math.round(finderTimeoutMs / 1000)}s.`,
    );
  }

  const { providerID, modelID } = parseModelName(model);
  const auxModel = options.auxModel || model;
  const { providerID: auxProviderID, modelID: auxModelID } = parseModelName(auxModel);
  const promptCachePolicy = resolvePromptCachePolicy({
    promptCache: options.promptCache,
    mainModel: model,
    mainProviderID: providerID,
    mainModelID: modelID,
    auxModel,
    auxProviderID,
    auxModelID,
  });
  if (promptCachePolicy.disabledPromptCacheModels.length > 0) {
    log(
      `Prompt cache disabled for unsupported model(s): ${promptCachePolicy.disabledPromptCacheModels.join(', ')}.`,
    );
  }
  if (promptCachePolicy.sharedProviderCacheDisabled) {
    log(
      `Prompt cache disabled for provider ${providerID} because aux model ${auxModel} does not support it; main model ${model} shares that provider config.`,
    );
  }
  const tokenUsage = createReviewTokenUsageAccumulator();
  const telemetry = createTelemetryRecorder(options.reviewTelemetry);
  const phases = createPhaseTelemetryTracker(telemetry);
  const backendToolTelemetry = telemetry.enabled
    ? createToolTelemetryAccumulator(telemetry, randomUUID())
    : undefined;
  const sessionTelemetry = backendToolTelemetry
    ? { phases, tools: backendToolTelemetry }
    : undefined;
  const contextAssemblyDone = phases.start({ phase: 'context-assembly', scope: 'run' });
  const recordTokenUsage: TokenUsageRecorder = (usage, usageModel, label) => {
    tokenUsage.add(usage, usageModel);
    telemetry.recordSession({
      session: label ?? usageModel,
      model: usageModel,
      inputTokens: usage.input,
      outputTokens: usage.output,
      reasoningTokens: usage.reasoning,
      cacheReadTokens: usage.cacheRead,
      ...(isFiniteNumber(usage.costUsd) ? { costUsd: usage.costUsd } : {}),
      ...(isFiniteNumber(usage.estimatedCostUsd)
        ? { estimatedCostUsd: usage.estimatedCostUsd }
        : {}),
    });
  };
  telemetry.beginRun({
    runId: randomUUID(),
    ...(baseSha ? { baseSha } : {}),
    ...(headSha ? { headSha } : {}),
    model,
    ...(auxModel !== model ? { auxModel } : {}),
  });
  const recordCoverage: SessionCoverageRecorder = (coverage) => telemetry.recordCoverage(coverage);
  const trackedAux: AuxiliarySession<unknown>[] = [];
  const trackAux = <T>(label: string, promise: Promise<T>): AuxiliarySession<T> => {
    const session = trackAuxiliarySession(label, promise);
    trackedAux.push(session as AuxiliarySession<unknown>);
    return session;
  };
  let telemetryDone = false;
  let telemetryTerminalState: RunTerminalState | undefined;
  let telemetryEmitted = false;
  let teardownPending = false;
  const emitTelemetry = () => {
    if (telemetryEmitted) return;
    telemetryEmitted = true;
    emitReviewTelemetry(telemetry, workspace, log);
  };
  const finishTelemetry = (state: RunTerminalState) => {
    if (telemetryDone) return;
    telemetryDone = true;
    telemetryTerminalState = state;
    if (!teardownPending) phases.finishOpen(state === 'failed' ? 'failed' : 'completed');
    telemetry.finishRun(state, Date.now() - runStartedAt);
    if (!teardownPending) emitTelemetry();
  };
  if (params.telemetryLifecycle) {
    // Installed AFTER the recorder exists so runPrReview's catch can finalize
    // any later throw — setup, sessions, or posting. Aux sessions still in
    // flight when the run dies are recorded as aborted: an absent row would
    // read as "never ran".
    params.telemetryLifecycle.onFailure = () => {
      for (const session of trackedAux) {
        if (!session.isSettled()) {
          recordCoverage({
            session: session.label,
            state: 'failed',
            error: new Error('aborted: the run failed while this session was in flight'),
          });
        }
      }
      finishTelemetry('failed');
    };
  }

  // Local checkouts are owned by the invoking user — dubious-ownership can't
  // trigger — so never touch the developer's global gitconfig from local mode.
  if (!localDiff) {
    await ensureGitSafeDirectory(workspace, log);
  }

  log(
    localDiff
      ? `Using local diff for ${owner}/${repo} (${localDiff.files.length} files)`
      : `Listing PR files for ${owner}/${repo}#${pullNumber}`,
  );
  let rawFiles = localDiff ? localDiff.files : await listPrFiles(octokit, owner, repo, pullNumber);
  log(`Files in PR: ${rawFiles.length} total`);
  if (!localDiff) {
    await params.preparePatchRecovery?.();
    const hydrated = await hydratePrFilePatches(
      rawFiles.filter((file) => !isNoiseFile(file.filename)),
      {
        workspace,
        baseSha,
        headSha,
      },
    );
    const hydratedByPath = new Map(hydrated.files.map((file) => [file.filename, file]));
    rawFiles = rawFiles.map((file) => hydratedByPath.get(file.filename) ?? file);
    if (hydrated.recovered.length > 0) {
      log(
        `Recovered ${hydrated.recovered.length} GitHub-omitted text patch(es) from the checkout diff: ${formatFileList(hydrated.recovered)}`,
      );
    }
  }
  // Fetch before the skip gates so a lightweight follow-up run can still
  // finalize manually resolved reviews. Full runs also need every open thread
  // for the review-done reaction, regardless of includePriorComments.
  const {
    threads: allPriorJbotThreads,
    reviewGroups: priorJbotReviewGroups,
    unresolvedAddressedThreadIds,
    outcomes: priorThreadOutcomes,
    lookupSucceeded: priorThreadStateKnown,
  } = localDiff
    ? {
        threads: [],
        reviewGroups: [],
        unresolvedAddressedThreadIds: [],
        outcomes: [],
        lookupSucceeded: true,
      }
    : await safeListPriorJbotThreads(octokit, owner, repo, pullNumber, log);
  if (telemetry.enabled && priorThreadOutcomes.length > 0) {
    // rawFiles (pre noise-filter) is the full current PR diff membership set.
    const inDiff = new Set(rawFiles.map((file) => file.filename));
    for (const outcome of priorThreadOutcomes) {
      telemetry.recordOutcome({ ...outcome, fileInDiff: inDiff.has(outcome.path) });
    }
    log(`Outcome telemetry: recorded ${priorThreadOutcomes.length} prior finding thread(s).`);
  }
  const finalizePriorResolvedReviews = async (resolvedThisRun: readonly string[]) => {
    if (options.dryRun) return;
    await finalizeResolvedReviews({
      octokit,
      threadResolutionOctokit: params.threadResolutionOctokit,
      owner,
      repo,
      pullNumber,
      reviews: priorJbotReviewGroups,
      resolvedThisRun,
      log,
    });
  };
  const files = rawFiles.filter((f) => f.patch && !isNoiseFile(f.filename));
  // The "review done" 🚀 reaction means "the PR has no open jbot findings".
  // Skip paths below do NOT touch it: a no-reviewable-files or docs-only push
  // doesn't change the review verdict, so leaving the reaction as-is keeps it
  // honest (a prior clean 🚀 stays; a PR with open findings stays 🚀-less).
  if (files.length === 0) {
    log('No reviewable files after filtering; leaving the review reaction unchanged.');
    await finalizePriorResolvedReviews([]);
    finishTelemetry('skipped');
    return;
  }
  const noiseCount = rawFiles.filter((file) => isNoiseFile(file.filename)).length;
  const patchlessCount = rawFiles.filter(
    (file) => !file.patch && !isNoiseFile(file.filename),
  ).length;
  log(
    `Reviewable files: ${files.length} (noise filtered: ${noiseCount}, patchless excluded: ${patchlessCount})`,
  );

  const addable = new Map<string, Set<number>>();
  const patchByPath = new Map<string, string>();
  const changedFiles: string[] = [];
  for (const f of files) {
    addable.set(f.filename, parseAddedLines(f.patch));
    if (f.patch) patchByPath.set(f.filename, f.patch);
    changedFiles.push(f.filename);
  }

  // Deterministic doc-only gate: when every REVIEWABLE file is prose, there
  // is nothing the model would review, so skip before any server boot or LLM
  // session. `changedFiles` is the reviewable set — noise files (lockfiles,
  // generated) and patchless binaries were already filtered out above and are
  // never reviewed regardless, so only never-reviewed files can be absent
  // here; a real code/config change always keeps a non-doc entry and forces a
  // full review.
  if (options.skipDocOnly && isDocOnlyChange(changedFiles)) {
    log(`Doc-only PR (${changedFiles.length} file(s)); skipping the full review.`);
    await finalizePriorResolvedReviews([]);
    finishTelemetry('skipped');
    return;
  }

  const piEngine = resolvePiEngine(
    options.sdkEngine ? { JBOT_SDK_ENGINE: options.sdkEngine } : process.env,
    process.version,
  );
  if (!piEngine.enabled && piEngine.reason) log(`pi engine disabled: ${piEngine.reason}`);
  const [mainPiModelAvailable, auxPiModelAvailable] = piEngine.enabled
    ? await Promise.all([
        piModelAvailable(providerID, modelID),
        piModelAvailable(auxProviderID, auxModelID),
      ])
    : [false, false];
  if (piEngine.enabled) {
    if (piSupportsProvider(providerID) && !mainPiModelAvailable) {
      log(`pi catalog has no ${model}; routing main sessions through opencode.`);
    }
    if (piSupportsProvider(auxProviderID) && !auxPiModelAvailable && auxModel !== model) {
      log(`pi catalog has no ${auxModel}; routing auxiliary sessions through opencode.`);
    }
  }
  const backendSelection = selectReviewBackends({
    providerID,
    modelID,
    apiKey,
    auxProviderID,
    auxModelID,
    auxApiKey: options.auxApiKey,
    piEnabled: piEngine.enabled,
    mainPiModelAvailable,
    auxPiModelAvailable,
  });
  const { mainCliBackend, auxCliBackend, needsOpencode } = backendSelection;
  const mainOnPi = backendSelection.mainSdkEngine === 'pi';
  const auxOnPi = backendSelection.auxSdkEngine === 'pi';
  const mainOnPoolside = backendSelection.mainSdkEngine === 'poolside';
  const auxOnPoolside = backendSelection.auxSdkEngine === 'poolside';
  const mainOnOpencode = !mainCliBackend && !mainOnPi && !mainOnPoolside;
  const auxOnOpencode = !auxCliBackend && !auxOnPi && !auxOnPoolside;
  if (mainOnPi || auxOnPi || mainOnPoolside || auxOnPoolside) {
    log(
      `Backend routing: main=${mainCliBackend ?? backendSelection.mainSdkEngine ?? 'opencode'} aux=${auxCliBackend ?? backendSelection.auxSdkEngine ?? 'opencode'}`,
    );
  }
  const mainPoolsideBackend = mainOnPoolside
    ? createPoolsideBackend(apiKey, options.modelOptions)
    : undefined;
  const auxPoolsideKey = options.auxApiKey || (auxProviderID === providerID ? apiKey : '');
  const auxPoolsideBackend = auxOnPoolside ? createPoolsideBackend(auxPoolsideKey) : undefined;

  const discoveredGuidelines = await discoverGuidelineDocs(workspace, changedFiles);
  const guidelines = formatGuidelines(discoveredGuidelines);
  const finderGuidelines = formatFinderGuidelines(discoveredGuidelines, {
    forFiles: changedFiles,
  });
  if (guidelines) {
    log(
      `Guidelines loaded (${guidelines.length} bytes; finder slice ${finderGuidelines.length} bytes).`,
    );
  }

  // A real review is about to run: clear the prior 🚀 so it only reappears if
  // this run leaves the PR with zero open findings. A removed reaction means
  // "review in flight"; a thrown/aborted run leaves it absent.
  if (!options.dryRun) {
    await safeRemoveReviewReaction(octokit, owner, repo, pullNumber, log);
  }

  // Always fetch prior reviews: whether the bot has reviewed this PR before
  // (the first-run decision) is independent of whether prior comments are
  // injected into the review CONTEXT. includePriorComments gates the context
  // use below; it must NOT gate the count, or quiet-clean re-runs break for
  // include-prior-comments: false (every run would look like a first run).
  // Local mode has no PR, so no prior bot output; the empty list also keeps
  // the incremental-delta compare below unreachable (no reviewedHead marker).
  const allPriorReviewComments = localDiff
    ? []
    : await listPrComments(octokit, owner, repo, pullNumber);
  const priorJbotReviewCount = allPriorReviewComments.filter(isJbotReviewBody).length;
  // jbot's own review bodies stay out of the flat context block: the
  // structured prior-threads block already carries every prior finding, so
  // including them here doubled the same text on mature PRs.
  const priorComments = options.includePriorComments
    ? allPriorReviewComments.filter((comment) => !isJbotReviewBody(comment))
    : [];
  if (!options.includePriorComments) {
    log('Prior review comments excluded from review context by configuration.');
  }
  const priorJbotThreads = options.includePriorComments ? allPriorJbotThreads : [];
  log(`Prior jbot-review threads available for addressed checks: ${priorJbotThreads.length}`);
  const priorJbotThreadBlock = formatPriorJbotThreadsForPrompt(priorJbotThreads);
  const summaryScopeBlock = buildSummaryScopeBlock();
  const changeShape = classifyChangeShape(files);
  const explorationTier = selectExplorationTier({
    changedFiles: files.length,
    touchesRiskyPath: touchesRiskyPath(files),
    testOnly: changeShape.testOnly,
  });
  const reviewFocusBlock = buildReviewFocusBlock(changedFiles, changeShape);
  const fanout = options.dynamicFanout
    ? planReviewFanout({
        requestedPasses: options.reviewPasses,
        requestedGuidelinePass: options.guidelinePass,
        files,
        shape: changeShape,
      })
    : null;
  const effectiveReviewPasses = fanout?.reviewPasses ?? options.reviewPasses;
  const effectiveGuidelinePass = fanout?.guidelinePass ?? options.guidelinePass;
  if (fanout?.tier === 'minimal') {
    log(
      `Dynamic fan-out: ${fanout.reason}; reviewPasses ${options.reviewPasses}→${effectiveReviewPasses}, guidelinePass ${options.guidelinePass}→${effectiveGuidelinePass} (main review + verify unchanged).`,
    );
  }
  const diffHunks = buildDiffHunksBlockWithMetadata(files);
  const diffHunksBlock = diffHunks.text;
  if (diffHunksBlock) log(`Embedded diff hunks block: ${diffHunksBlock.length} chars.`);
  const mainRequiresCompleteEmbeddedDiff = backendRequiresCompleteEmbeddedDiff(
    providerID,
    mainCliBackend,
  );
  const auxRequiresCompleteEmbeddedDiff = backendRequiresCompleteEmbeddedDiff(
    auxProviderID,
    auxCliBackend,
  );
  const embeddedOnlyBackend = mainRequiresCompleteEmbeddedDiff || auxRequiresCompleteEmbeddedDiff;
  const embeddedOnlyBackendDiffHunks = embeddedOnlyBackend
    ? buildDiffHunksBlockWithMetadata(files, EMBEDDED_ONLY_BACKEND_DIFF_HUNKS_OPTIONS)
    : undefined;
  const embeddedOnlyBackendIncompleteDiffFiles = embeddedOnlyBackendDiffHunks
    ? incompleteDiffFiles(embeddedOnlyBackendDiffHunks)
    : [];
  if (embeddedOnlyBackendDiffHunks?.text) {
    log(
      `Embedded-only backend diff hunks block: ${embeddedOnlyBackendDiffHunks.text.length} chars.`,
    );
  }
  const blastRadiusBlock = options.enhancedContext
    ? await buildBlastRadiusBlock(workspace, files)
    : '';
  if (blastRadiusBlock) log('Embedded changed-symbol usage block.');

  const diffScope = { baseRef, baseSha, headSha, worktree: !!localDiff };

  // The diff hunks deliberately stay OUT of the core context: each main
  // review shard appends its own slice, and the lens/aux sessions append the
  // full block. Hunks always go last — closest to the output reminder, where
  // small models attend most.
  let coreContext: string;
  // Populated on the enhanced path only; the basic branch has no droppable set.
  let baseCoreContext = '';
  let supplementaryBlocks: ContextBlock[] = [];
  // Captured for the slim verifier contract (TASK-065); enhanced path only.
  let slimVerifierIssueInputs: { linkedIssues: LinkedIssue[]; linkedIssuesOmitted: number } | undefined;
  if (options.enhancedContext) {
    const commits = localDiff
      ? localDiff.commits
      : await listPrCommits(octokit, owner, repo, pullNumber);
    const { issues: linkedIssues, omitted: linkedIssuesOmitted } = localDiff
      ? { issues: [], omitted: 0 }
      : await safeListClosingIssues(octokit, owner, repo, pullNumber, log);
    // Belt-and-braces: local mode never reaches GitHub for checks (the local
    // driver also passes no headSha, so the fallback text stays literally true).
    const checkSummary =
      headSha && !localDiff
        ? await getCheckStatusSummary(octokit, owner, repo, headSha)
        : 'Check status unavailable: PR head SHA was not provided.';
    coreContext = buildReviewContext({
      pullTitle,
      pullBody,
      changedFiles,
      priorComments,
      commits,
      checkSummary,
      // Guidelines are injected per pass via guidelinesForPrompt (defined just
      // before dispatch: the capped finder slice while the compliance pass
      // carries the full set, else the full set), kept out of the shared
      // context so they land in the early prompt slot (invariant #5) instead
      // of being buried mid-context.
      guidelines: '',
      diffScope,
      linkedIssues,
      linkedIssuesOmitted,
    });
    // Kept separate so the trim can rebuild without them once the real guideline
    // slice and Context7 block are known; this full form is what aux sessions get.
    supplementaryBlocks = buildSupplementaryBlocks({
      summaryScope: summaryScopeBlock,
      reviewFocus: reviewFocusBlock,
      priorJbotThreads: priorJbotThreadBlock,
      blastRadius: blastRadiusBlock,
    });
    baseCoreContext = coreContext;
    coreContext = joinContext(coreContext, ...supplementaryBlocks.map((block) => block.text));
    slimVerifierIssueInputs = { linkedIssues, linkedIssuesOmitted };
  } else {
    const commentsBlock =
      priorComments.length > 0
        ? '## Prior review comments\n' + priorComments.map((c) => `- ${c}`).join('\n')
        : '';
    coreContext = [
      '## Pull request',
      pullTitle && `Title: ${pullTitle}`,
      pullBody && `Description:\n${truncatePrBody(pullBody)}`,
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
  // PR-author prose (title/description/commits/prior comments) is untrusted;
  // mark it once here so every session derived from coreContext (main + aux)
  // carries the guard. Static text, so it stays in the cache-stable prefix.
  coreContext = joinContext(UNTRUSTED_PR_CONTENT_NOTE, coreContext);
  const auxHasCompleteEmbeddedDiff =
    !auxRequiresCompleteEmbeddedDiff || embeddedOnlyBackendIncompleteDiffFiles.length === 0;
  if (!auxHasCompleteEmbeddedDiff) {
    log(
      `Skipping auxiliary sessions: embedded diff exceeds the backend hard budget (${formatFileList(
        embeddedOnlyBackendIncompleteDiffFiles,
      )}). Main review continues without aux findings or verification.`,
    );
  }
  const auxDiffBlockText =
    auxRequiresCompleteEmbeddedDiff && embeddedOnlyBackendDiffHunks && auxHasCompleteEmbeddedDiff
      ? embeddedOnlyBackendDiffHunks.text
      : diffHunksBlock;
  const auxPrContext = joinContext(coreContext, auxDiffBlockText);
  // TASK-065 arm (JBOT_VERIFIER_SLIM_CONTEXT): the verifier judges a handful
  // of findings against the diff; the finder supplements around it are pure
  // prefill. Same diff block as the aux path, so a slim verifier never judges
  // from a diff the full context would have carried whole.
  const verifierPrContext =
    options.verifierSlimContext && slimVerifierIssueInputs
      ? buildSlimVerifierContext({
          pullTitle,
          pullBody,
          changedFiles,
          diffScope,
          ...slimVerifierIssueInputs,
          auxDiffBlockText,
        })
      : auxPrContext;

  // Use a per-run limiter around every backend so mixed Devin/OpenCode runs
  // honor one global cap. Disable opencode's older process-global limiter to
  // avoid double-limiting OpenCode sessions inside this runner path.
  configureSessionConcurrency(0);
  // Only the selected providers the gateway actually serves; a gateway
  // configured alongside an opencode/pi/other-CLI run must not touch it.
  const routedAgents = [...new Set([mainCliBackend, auxCliBackend])].filter(
    (id): id is CliBackendID =>
      Boolean(id) && (ACP_GATEWAY_PROVIDERS as readonly string[]).includes(id as string),
  );
  const remoteAcp = routedAgents.length > 0 ? remoteAcpConfigFromEnv() : undefined;
  // A missing main endpoint is fatal; an auxiliary-only endpoint fails open.
  // Cap sessions at the companion's available capacity.
  let sessionCap = options.maxConcurrentSessions;
  let auxGatewayPreflightError: unknown;
  if (remoteAcp && routedAgents.length > 0) {
    const mainGatewayAgent =
      mainCliBackend && routedAgents.includes(mainCliBackend) ? mainCliBackend : undefined;
    const auxGatewayAgent =
      auxCliBackend && routedAgents.includes(auxCliBackend) ? auxCliBackend : undefined;
    if (mainGatewayAgent) {
      const { freeSessions } = await checkGatewayEndpointReady(remoteAcp, mainGatewayAgent);
      if (sessionCap === 0 || freeSessions < sessionCap) sessionCap = freeSessions;
    }
    if (auxGatewayAgent && auxGatewayAgent !== mainGatewayAgent) {
      const ready = await checkAuxGatewayEndpointReady(remoteAcp, auxGatewayAgent);
      if ('error' in ready) {
        auxGatewayPreflightError = ready.error;
        recordCoverage({ session: 'aux-gateway-preflight', state: 'failed', error: ready.error });
        log(
          `Auxiliary ACP gateway backend unavailable; auxiliary sessions are disabled for this run (fail-open): ${
            ready.error instanceof Error ? ready.error.message : String(ready.error)
          }`,
        );
      } else if (sessionCap === 0 || ready.freeSessions < sessionCap) {
        sessionCap = ready.freeSessions;
      }
    }
    log(
      `ACP gateway: routing ${routedAgents.join(', ')} to ${remoteAcp.endpoint} via ${remoteAcp.gateway}`,
    );
  }
  const sessionSlots = sessionCap > 0 ? new Semaphore(sessionCap) : undefined;
  if (sessionCap > 0) log(`Model session concurrency capped at ${sessionCap}.`);

  let opencodeRuntime: Awaited<ReturnType<typeof startOpencode>> | undefined;
  let opencodeBackend: ReviewBackend | undefined;
  // With a gateway configured, these providers run on a remote companion's
  // agent instead of a local CLI — so their local setup (credentials, temp
  // homes) is skipped entirely.
  let devinBackend: ReviewBackend | undefined;
  let commandCodeBackend: ReviewBackend | undefined;
  let cursorBackend: ReviewBackend | undefined;
  let codexBackend: ReviewBackend | undefined;
  let clineBackend: ReviewBackend | undefined;
  let grokBackend: ReviewBackend | undefined;
  const serializedBackends = new Map<ReviewBackend, Semaphore>();
  let kiloBackend: ReviewBackend | undefined;
  let qoderBackend: ReviewBackend | undefined;
  let dimBackend: ReviewBackend | undefined;
  let devinHome: string | undefined;
  const cleanupDevinHome = (): void => {
    if (!devinHome) return;
    rmSync(devinHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    devinHome = undefined;
  };
  let commandCodeHome: string | undefined;
  const cleanupCommandCodeHome = (): void => {
    if (!commandCodeHome) return;
    rmSync(commandCodeHome, { recursive: true, force: true });
    commandCodeHome = undefined;
  };
  let codexHome: string | undefined;
  const cleanupCodexHome = (): void => {
    if (!codexHome) return;
    rmSync(codexHome, { recursive: true, force: true });
    codexHome = undefined;
  };
  // Cleaned like a credential home: symma links the auth in, and the link
  // becomes a copy where the filesystem has no symlinks.
  let codexRunHome: string | undefined;
  const cleanupCodexRunHome = (): void => {
    if (!codexRunHome) return;
    rmSync(codexRunHome, { recursive: true, force: true });
    codexRunHome = undefined;
  };
  let clineHome: string | undefined;
  const cleanupClineHome = (): void => {
    if (!clineHome) return;
    rmSync(clineHome, { recursive: true, force: true });
    clineHome = undefined;
  };
  let grokHome: string | undefined;
  const cleanupGrokHome = (): void => {
    if (!grokHome) return;
    rmSync(grokHome, { recursive: true, force: true });
    grokHome = undefined;
  };
  let dimHome: string | undefined;
  const cleanupDimHome = (): void => {
    if (!dimHome) return;
    rmSync(dimHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    dimHome = undefined;
  };
  // Multiple CLI homes can be live at once (e.g. main=codex, aux=commandcode), so
  // clean every one at every downstream failure/exit point.
  const cleanupCliHomes = (): void => {
    // Independently: force only suppresses a missing path, so one failed
    // removal would otherwise leave the remaining credential homes on disk.
    for (const cleanup of [
      cleanupDevinHome,
      cleanupCommandCodeHome,
      cleanupCodexHome,
      cleanupCodexRunHome,
      cleanupClineHome,
      cleanupGrokHome,
      cleanupDimHome,
    ]) {
      try {
        cleanup();
      } catch (error) {
        log(`CLI home teardown failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Also where the registration is dropped: the try that would otherwise
    // release it starts below the backend setup's own throws.
    unregisterCliHomes?.();
    unregisterCliHomes = undefined;
  };
  // Armed only once a home exists, so the setup throws above it — which reach
  // no cleanup of their own — cannot strand a registration. The homes hold
  // materialized provider credentials and must not outlive an interrupted run.
  let unregisterCliHomes: (() => void) | undefined;
  const guardCliHomes = (): void => {
    unregisterCliHomes ??= onFatalSignal(cleanupCliHomes);
  };

  if (!remoteAcp && (mainCliBackend === DEVIN_PROVIDER_ID || auxCliBackend === DEVIN_PROVIDER_ID)) {
    const devinApiKey = backendSelection.devinApiKey;
    if (!devinApiKey) {
      cleanupCliHomes();
      throw new Error(`Missing API key for ${DEVIN_PROVIDER_ID} provider.`);
    }
    let credentialsPath: string;
    try {
      devinHome = mkdtempSync(join(tmpdir(), 'jbot-devin-home-'));
      guardCliHomes();
      credentialsPath = writeDevinCredentials(devinApiKey, devinHome);
      devinBackend = createDevinCliBackend(workspace, devinHome);
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    log(`Devin CLI credentials configured at ${credentialsPath}.`);
    log('Devin CLI token usage is unavailable for these sessions.');
    serializedBackends.set(devinBackend, new Semaphore(1));
  }

  if (
    !remoteAcp &&
    (mainCliBackend === CURSOR_PROVIDER_ID || auxCliBackend === CURSOR_PROVIDER_ID)
  ) {
    const cursorApiKey = backendSelection.cursorApiKey;
    if (!cursorApiKey) {
      cleanupCliHomes();
      throw new Error(`Missing API key for ${CURSOR_PROVIDER_ID} provider.`);
    }
    // Cursor authenticates from CURSOR_API_KEY in each spawn's env — no
    // credential file and no temp HOME to write or clean up.
    log(
      'Cursor CLI authenticated via CURSOR_API_KEY; token usage is unavailable for those sessions.',
    );
    cursorBackend = createAcpBackend(cursorAcpSpec(cursorApiKey), workspace, backendToolTelemetry);
  }

  if (mainCliBackend === COMMANDCODE_PROVIDER_ID || auxCliBackend === COMMANDCODE_PROVIDER_ID) {
    const commandCodeAccessKey = backendSelection.commandCodeAccessKey;
    if (!commandCodeAccessKey) {
      cleanupCliHomes();
      throw new Error(`Missing access key for ${COMMANDCODE_PROVIDER_ID} provider.`);
    }
    let authPath: string;
    try {
      commandCodeHome = mkdtempSync(join(tmpdir(), 'jbot-commandcode-home-'));
      guardCliHomes();
      authPath = writeCommandCodeAuth(commandCodeAccessKey, commandCodeHome);
      writeCommandCodeReadOnlySettings(commandCodeHome);
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    log(`CommandCode CLI auth configured at ${authPath}.`);
    log('CommandCode CLI reports token usage; USD cost is a local estimate, not billed usage.');
    log('CommandCode reviews run with skills and tools disabled.');
    commandCodeBackend = createCommandCodeBackend(workspace, commandCodeHome);
  }

  if (!remoteAcp && (mainCliBackend === CODEX_PROVIDER_ID || auxCliBackend === CODEX_PROVIDER_ID)) {
    const codexAuth = backendSelection.codexAuth;
    if (!codexAuth) {
      cleanupCliHomes();
      throw new Error(`Missing auth for ${CODEX_PROVIDER_ID} provider.`);
    }
    let authPath: string;
    try {
      codexHome = mkdtempSync(join(tmpdir(), 'jbot-codex-home-'));
      codexRunHome = mkdtempSync(join(tmpdir(), 'jbot-codex-run-'));
      guardCliHomes();
      authPath = writeCodexAuth(codexAuth, codexHome);
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    log(`Codex CLI auth configured at ${authPath}.`);
    log('Codex CLI token usage is unavailable; review metadata may omit those sessions.');
    codexBackend = createAcpBackend(
      codexAcpSpec(codexHome, codexRunHome),
      workspace,
      backendToolTelemetry,
    );
  }

  if (mainCliBackend === CLINE_PROVIDER_ID || auxCliBackend === CLINE_PROVIDER_ID) {
    const clineAuth = backendSelection.clineAuth;
    if (!clineAuth) {
      cleanupCliHomes();
      throw new Error(`Missing auth for ${CLINE_PROVIDER_ID} provider.`);
    }
    let authPath: string;
    try {
      clineHome = mkdtempSync(join(tmpdir(), 'jbot-cline-home-'));
      guardCliHomes();
      authPath = writeClineAuth(clineAuth, clineHome);
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    log(`Cline CLI auth configured at ${authPath}.`);
    log('Cline CLI token usage is unavailable; review metadata may omit those sessions.');
    // cline stays on the argv driver: its ACP prompt loop returns end_turn
    // with no output (cline/cline#11015, reproduced on 3.0.34 and 3.0.46).
    clineBackend = createClineBackend(workspace, clineHome);
  }

  if (mainCliBackend === GROK_PROVIDER_ID || auxCliBackend === GROK_PROVIDER_ID) {
    const grokCredential = backendSelection.grokAuth;
    if (!grokCredential) {
      cleanupCliHomes();
      throw new Error(`Missing credential for ${GROK_PROVIDER_ID} provider.`);
    }
    let runtime: GrokRuntime;
    try {
      grokHome = mkdtempSync(join(tmpdir(), 'jbot-grok-home-'));
      guardCliHomes();
      runtime = configureGrokHome(grokCredential, grokHome);
      await assertGrokAuthenticated(runtime);
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    log(
      runtime.authMode === 'account'
        ? `Grok Build CLI account auth configured at ${runtime.authPath}.`
        : 'Grok Build CLI API-key auth configured.',
    );
    log(
      'Grok Build CLI runs against an empty read-only workspace; token usage is unavailable for those sessions.',
    );
    grokBackend = createGrokBackend(runtime);
    // Grok mutates shared auth state, so its sessions cannot overlap.
    serializedBackends.set(grokBackend, new Semaphore(1));
  }

  if (!remoteAcp && (mainCliBackend === KILO_PROVIDER_ID || auxCliBackend === KILO_PROVIDER_ID)) {
    const kiloAuth = backendSelection.kiloAuth;
    if (!kiloAuth) {
      cleanupCliHomes();
      throw new Error(`Missing auth for ${KILO_PROVIDER_ID} provider.`);
    }
    try {
      assertValidKiloAuth(kiloAuth); // fail fast on a malformed secret
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    // No credential file/home to allocate: KILO_AUTH_CONTENT is env-injected and each
    // session self-manages a temp HOME/XDG for kilo's SQLite data dir.
    log('Kilo CLI auth configured via KILO_AUTH_CONTENT (env-injected; per-session temp HOME).');
    log('Kilo CLI token usage is unavailable; review metadata may omit those sessions.');
    kiloBackend = createAcpBackend(kiloAcpSpec(kiloAuth), workspace, backendToolTelemetry);
  }

  if (mainCliBackend === QODER_PROVIDER_ID || auxCliBackend === QODER_PROVIDER_ID) {
    const qoderToken = backendSelection.qoderToken;
    if (!qoderToken) {
      cleanupCliHomes();
      throw new Error(`Missing personal access token for ${QODER_PROVIDER_ID} provider.`);
    }
    log(
      'Qoder CLI authenticated via a per-session PAT payload; user/project settings, hooks, MCP, writes, shell, web, and subagents are disabled.',
    );
    qoderBackend = createQoderBackend(workspace, qoderToken, backendToolTelemetry);
  }

  if (mainCliBackend === DIM_PROVIDER_ID || auxCliBackend === DIM_PROVIDER_ID) {
    const dimAuth = backendSelection.dimAuth;
    if (!dimAuth) {
      cleanupCliHomes();
      throw new Error(`Missing auth for ${DIM_PROVIDER_ID} provider.`);
    }
    let runtime: DimRuntime;
    try {
      const bundle = decodeDimBundle(dimAuth); // fail fast on a malformed secret
      dimHome = mkdtempSync(join(tmpdir(), 'jbot-dim-home-'));
      guardCliHomes();
      runtime = { parent: dimHome, bundle };
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    log(
      `dim CLI sessions get a per-spawn home under ${dimHome} (its SQLite store cannot be shared).`,
    );
    log('dim reviews run in plan mode with read/glob/grep/exec only; writes and skills are off.');
    dimBackend = createDimBackend(workspace, runtime, backendToolTelemetry);
  }

  // Both SDK roles on one engine but different providers: the aux provider gets
  // its own entry in that engine's credential map, so it MUST have its own key.
  // Falling back to the main key would hand the main provider's secret to a
  // different vendor's endpoint (and fail auth there anyway).
  const auxNeedsOwnKey =
    auxProviderID !== providerID && ((mainOnPi && auxOnPi) || (mainOnOpencode && auxOnOpencode));
  const auxModelOptions = auxModelOptionsFor(providerID, modelID, auxProviderID, auxModelID);
  // TASK-157: the verifier floors at the main-pass effort. An identity return
  // means the aux entry already delivers it, so no per-session override (and
  // no opencode alias entry) is needed.
  const verifyModelOptions = verificationModelOptions(
    supportedModelOptions(providerID, modelID, options.modelOptions),
    auxModelOptions,
  );
  const verifierNeedsOwnOptions =
    verifyModelOptions !== undefined && verifyModelOptions !== auxModelOptions;
  const verifierSessionOptions = verifierNeedsOwnOptions
    ? supportedModelOptions(auxProviderID, auxModelID, verifyModelOptions)
    : undefined;
  const auxNeedsOpencodeConfig =
    mainOnOpencode &&
    auxOnOpencode &&
    (needsAuxOpencodeConfig(providerID, modelID, auxProviderID, auxModelID) ||
      Boolean(auxModelOptions && Object.keys(auxModelOptions).length > 0) ||
      verifierNeedsOwnOptions);
  if (auxNeedsOwnKey && !options.auxApiKey) {
    cleanupCliHomes();
    throw new Error(`Missing API key for auxiliary provider "${auxProviderID}".`);
  }

  let piRuntime: Awaited<ReturnType<typeof startPi>> | undefined;
  let piBackend: ReviewBackend | undefined;
  if (backendSelection.pi) {
    const piConfig = backendSelection.pi;
    if (!piConfig.apiKey) {
      cleanupCliHomes();
      throw new Error(`Missing API key for provider "${piConfig.providerID}".`);
    }
    log('Starting pi engine');
    try {
      piRuntime = await startPi(
        workspace,
        piConfig.providerID,
        piConfig.modelID,
        piConfig.apiKey,
        log,
        {
          // pi's thinking level is runtime-wide, so a runtime shared by both
          // roles follows the main model. One serving aux alone takes the aux
          // effort instead of none.
          modelOptions: mainOnPi ? options.modelOptions : auxModelOptions,
          // pi's prompt caching is provider-managed (no setCacheKey knob);
          // resolvePromptCachePolicy applies to the opencode server only.
          additionalProviderKeys: auxNeedsOwnKey
            ? [{ providerID: auxProviderID, apiKey: options.auxApiKey }]
            : undefined,
          toolTelemetry: backendToolTelemetry,
          embeddedFirstPrompt: options.embeddedFirstPrompt,
          // Shell-less pi sessions recover omitted/truncated hunks through the
          // read-only git_diff tool (invariant 1); base and diff form mirror
          // the run's diff scope.
          diffScope: baseSha
            ? { base: baseSha, worktree: !!localDiff, ...(headSha ? { head: headSha } : {}) }
            : undefined,
        },
      );
      if (!baseSha) {
        log('pi git_diff tool unavailable (no base sha); large diffs may be reviewed truncated.');
      }
    } catch (error) {
      cleanupCliHomes();
      throw error;
    }
    piBackend = createPiBackend(piRuntime.runtime);
  }

  let auxOpencodeBootError: unknown;
  if (needsOpencode) {
    const { opencodeProviderID, opencodeModelID, opencodeApiKey } = backendSelection;
    try {
      if (!opencodeApiKey) {
        throw new Error(`Missing API key for provider "${opencodeProviderID}".`);
      }
      log('Starting opencode server');
      opencodeRuntime = await startOpencode(
        workspace,
        opencodeProviderID,
        opencodeModelID,
        opencodeApiKey,
        log,
        {
          // Symmetric to the pi runtime below: when main is not on opencode the
          // root model IS the aux model, so it carries the aux options — and
          // the verifier alias, since verification runs on the aux model.
          modelOptions: mainOnOpencode ? options.modelOptions : auxModelOptions,
          ...(!mainOnOpencode && verifierNeedsOwnOptions
            ? { verificationModelOptions: verifyModelOptions }
            : {}),
          baseURL: mainOnOpencode ? baseURL : options.auxBaseURL,
          promptCache: mainOnOpencode
            ? promptCachePolicy.providerPromptCache
            : promptCachePolicy.auxProviderPromptCache,
          port: options.opencodePort > 0 ? options.opencodePort : undefined,
          scrubEnv: options.scrubSessionEnv !== false,
          proxyEnv: options.opencodeProxyEnv,
          additionalProviderKeys: auxNeedsOpencodeConfig
            ? [
                {
                  providerID: auxProviderID,
                  apiKey: auxNeedsOwnKey ? options.auxApiKey : opencodeApiKey,
                  modelID: auxModelID,
                  baseURL: auxNeedsOwnKey ? options.auxBaseURL : baseURL,
                  promptCache: promptCachePolicy.auxProviderPromptCache,
                  ...(auxModelOptions ? { modelOptions: auxModelOptions } : {}),
                  ...(verifierNeedsOwnOptions
                    ? { verificationModelOptions: verifyModelOptions }
                    : {}),
                },
              ]
            : undefined,
        },
      );
      opencodeBackend = createOpencodeBackend(opencodeRuntime.client, backendToolTelemetry);
    } catch (error) {
      if (mainOnOpencode) {
        piRuntime?.stop();
        cleanupCliHomes();
        throw error;
      }
      // Opencode serves only aux roles here — invariant #3: a broken aux
      // backend must never fail the run. The auxSessionsEnabled gate below
      // keeps every aux session off; main review continues.
      auxOpencodeBootError = error;
      recordCoverage({ session: 'aux-opencode-boot', state: 'failed', error });
      log(
        `Auxiliary opencode backend unavailable; lens/guideline/addressed/changes-since/verification sessions are disabled for this run (fail-open): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const cliBackends: Record<CliBackendID, ReviewBackend | undefined> = {
    [DEVIN_PROVIDER_ID]: devinBackend,
    [COMMANDCODE_PROVIDER_ID]: commandCodeBackend,
    [CURSOR_PROVIDER_ID]: cursorBackend,
    [CODEX_PROVIDER_ID]: codexBackend,
    [CLINE_PROVIDER_ID]: clineBackend,
    [GROK_PROVIDER_ID]: grokBackend,
    [KILO_PROVIDER_ID]: kiloBackend,
    [QODER_PROVIDER_ID]: qoderBackend,
    [DIM_PROVIDER_ID]: dimBackend,
  };
  // The gateway serves these providers instead of a local CLI; their local
  // construction above is skipped for the same reason.
  if (remoteAcp) {
    for (const agent of ACP_GATEWAY_PROVIDERS) {
      cliBackends[agent] = createRemoteAcpBackend({ ...remoteAcp, agent });
    }
  }
  const mainBaseBackend = mainCliBackend
    ? requireCliBackend(cliBackends, mainCliBackend)
    : mainOnPi
      ? requireSdkBackend(piBackend, 'pi', 'main')
      : mainOnPoolside
        ? requireSdkBackend(mainPoolsideBackend, 'poolside', 'main')
        : requireSdkBackend(opencodeBackend, 'opencode', 'main');
  const auxBaseBackend = auxCliBackend
    ? requireCliBackend(cliBackends, auxCliBackend)
    : auxOnPi
      ? requireSdkBackend(piBackend, 'pi', 'aux')
      : auxOnPoolside
        ? requireSdkBackend(auxPoolsideBackend, 'poolside', 'aux')
        : auxOpencodeBootError
          ? // Fail-open stand-in only: auxSessionsEnabled keeps it undispatched.
            mainBaseBackend
          : requireSdkBackend(opencodeBackend, 'opencode', 'aux');
  const mainBackend = limitReviewBackendSessions(
    mainBaseBackend,
    'main',
    sessionSlots,
    serializedBackends.get(mainBaseBackend),
    sessionTelemetry,
  );
  const auxBackend = limitReviewBackendSessions(
    auxBaseBackend,
    'aux',
    sessionSlots,
    serializedBackends.get(auxBaseBackend),
    sessionTelemetry,
  );
  // Single gate for every aux session (lenses, guideline, addressed,
  // changes-since, verification): an incomplete embedded diff and a failed
  // aux-only opencode boot disable them the same way (invariant #3).
  const auxSessionsEnabled =
    auxHasCompleteEmbeddedDiff && !auxOpencodeBootError && !auxGatewayPreflightError;
  // Which engine each model ran on, for the review footer (main wins on
  // collision — same model ⇒ same engine anyway).
  const engineByModel: Record<string, string> = {
    [auxModel]: auxBackend.name,
    [model]: mainBackend.name,
  };
  // Best-effort teardown: stop() runs inside a finally, so it must never throw
  // (that would mask the real error and skip cleanupCliHomes). Each cleanup is
  // independent — a fault in one neither strands the other's temp dir nor hides
  // its error.
  const stop = () => {
    try {
      opencodeRuntime?.stop();
    } catch (error) {
      log(`opencode teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      piRuntime?.stop();
    } catch (error) {
      log(`pi teardown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  teardownPending = true;
  try {
    if (commandCodeBackend) {
      try {
        const models = await listCommandCodeModels(workspace, commandCodeHome);
        log(
          models.length > 0
            ? `Available models for ${COMMANDCODE_PROVIDER_ID} using supplied CLI auth:\n${models.join('\n')}`
            : `Available models for ${COMMANDCODE_PROVIDER_ID} using supplied CLI auth: none returned`,
        );
      } catch (e) {
        log(`(skipped CommandCode model listing: ${(e as Error).message})`);
      }
    }

    if (cursorBackend) {
      try {
        const models = await listCursorModels(workspace, backendSelection.cursorApiKey);
        log(
          models.length > 0
            ? `Available models for ${CURSOR_PROVIDER_ID} using supplied CLI auth:\n${models.join('\n')}`
            : `Available models for ${CURSOR_PROVIDER_ID} using supplied CLI auth: none returned`,
        );
      } catch (e) {
        log(`(skipped Cursor model listing: ${(e as Error).message})`);
      }
    }

    if (kiloBackend) {
      try {
        const models = await listKiloModels(workspace, backendSelection.kiloAuth);
        // Kilo's gateway catalog runs ~250 models; cap the inline log (unlike Cursor's full join).
        log(
          models.length > 0
            ? `Kilo models available (${models.length}): ${models.slice(0, 40).join(', ')}${models.length > 40 ? ', …' : ''}`
            : 'Kilo model listing returned no models.',
        );
      } catch (error) {
        log(
          `Kilo model listing failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (opencodeRuntime && mainBackend.name === 'opencode') {
      try {
        const modelListCacheKey = `${providerID}:${modelID}`;
        let models = providerModelListCache.get(modelListCacheKey);
        const fromCache = !!models;
        if (!models) {
          models = await listProviderModels(opencodeRuntime.client, providerID);
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
    } else if (mainBackend.name !== 'opencode') {
      log(
        `OpenCode provider model listing skipped: main review uses the ${mainBackend.name} backend.`,
      );
    }

    const context7 = decideContext7Mode({
      mode: options.context7Mode,
      files,
      apiKey: options.context7ApiKey,
    });
    let context7Active = false;
    let context7Block = '';
    if (context7.enabled && opencodeRuntime && mainBackend.name === 'opencode') {
      log(`Context7 MCP requested: ${context7.reason}`);
      context7Active = await enableContext7Mcp(opencodeRuntime.client, options.context7ApiKey, log);
      if (context7Active) context7Block = buildContext7PromptBlock(context7.reason);
    } else if (context7.enabled) {
      // pi has no MCP support; framework-behavior claims fall back to the
      // abstention discipline. CLI backends likewise run without Context7.
      log(
        `Context7 MCP skipped: main review uses the ${mainBackend.name} backend (${context7.reason}).`,
      );
    } else {
      log(`Context7 MCP skipped: ${context7.reason}.`);
    }

    // On a re-review, drop the recall supplements whose trigger class the
    // incremental delta (since the last reviewed head) doesn't touch. Best-effort
    // and dynamic-fanout-gated; a null delta (first review, fetch failure, or
    // escape hatch off) leaves the full set. Main review + verify are never gated.
    // Local mode never gets here: empty prior comments mean no reviewedHead.
    const reviewedHead = findLatestReviewedHead(allPriorReviewComments.filter(isJbotReviewBody));
    const incrementalDeltaFiles =
      options.dynamicFanout && reviewedHead && headSha
        ? await compareCommitFiles(octokit, owner, repo, reviewedHead, headSha).catch((error) => {
            log(
              `Incremental delta unavailable; running full lenses: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          })
        : null;
    const guidelineCandidate = effectiveGuidelinePass && auxSessionsEnabled;
    const candidateLensKeys = selectLensKeys(
      auxSessionsEnabled ? effectiveReviewPasses : 1,
      changedFiles,
      changeShape,
    );
    const incrementalLenses = planIncrementalLenses({
      candidateLensKeys,
      guidelinePass: guidelineCandidate,
      deltaFiles: incrementalDeltaFiles,
    });
    if (incrementalDeltaFiles && reviewedHead) {
      const skipped = [
        ...candidateLensKeys.filter((key) => !incrementalLenses.lensKeys.includes(key)),
        ...(guidelineCandidate && !incrementalLenses.guidelinePass ? ['guideline-compliance'] : []),
      ];
      if (skipped.length > 0) {
        log(
          `Incremental lenses since ${reviewedHead.slice(0, 7)}: running ${
            incrementalLenses.lensKeys.join(', ') || 'none'
          }; skipping ${skipped.join(', ')} (main review + verify unchanged).`,
        );
      }
    }

    // Finders get the capped, relevance-ranked slice while the compliance
    // session runs (keyed on the session's own final enable, not the option).
    // When it stays off (option, aux embedded-diff overflow, trivial-delta
    // trim), only checkout-blind finders widen to the full set — they cannot
    // recover an omitted doc; tool-capable finders keep the slice with the
    // omitted docs named for on-demand reads (JBOT_GUIDELINE_WIDEN=full
    // restores the old widen-everywhere behavior).
    const guidelinesForPrompt = selectFinderGuidelineText({
      discovered: discoveredGuidelines,
      forFiles: changedFiles,
      complianceRuns: incrementalLenses.guidelinePass,
      mainCanReadWorkspace: !mainRequiresCompleteEmbeddedDiff,
      widen: options.guidelineWiden,
      full: guidelines,
    });

    // Embedded-only main backends carry the unbounded block buildShardPlans
    // renders for them, not the 40KB default. Shared with the budget log so
    // both report the diff the main session actually receives.
    const mainDiffBlock =
      mainRequiresCompleteEmbeddedDiff && embeddedOnlyBackendDiffHunks
        ? embeddedOnlyBackendDiffHunks.text
        : diffHunksBlock;

    // Trimmed here, not at assembly: every other byte of a shard prompt is now
    // final, so the budget is exact rather than estimated. Only the main shards
    // get the trimmed context — aux sessions keep the full one, since the
    // dilution this targets is the finder's (#3 keeps them independent).
    const trimBudget = options.contextTrim
      ? ASSEMBLED_CONTEXT_WARN_BYTES -
        Buffer.byteLength(guidelinesForPrompt, 'utf8') -
        Buffer.byteLength(context7Block, 'utf8') -
        Buffer.byteLength(UNTRUSTED_PR_CONTENT_NOTE, 'utf8') -
        // The notice at its widest, so the reserve holds whatever gets dropped.
        Buffer.byteLength(
          buildContextTrimNotice(supplementaryBlocks.map((block) => block.name)),
          'utf8',
        ) -
        Buffer.byteLength(baseCoreContext, 'utf8') -
        Buffer.byteLength(mainDiffBlock, 'utf8')
      : Infinity;
    const { kept, dropped } = trimContextBlocks(supplementaryBlocks, trimBudget);
    if (dropped.length > 0) log(`Context trim dropped: ${dropped.join(', ')}`);
    const mainCoreContext =
      dropped.length === 0
        ? coreContext
        : joinContext(
            UNTRUSTED_PR_CONTENT_NOTE,
            baseCoreContext,
            ...kept.map((block) => block.text),
            buildContextTrimNotice(dropped),
          );

    const shards = shardFilesForReview(files, { requestedShards: options.reviewShards });
    const shardPlans = buildShardPlans({
      coreContext: mainCoreContext,
      fullDiffBlock: diffHunksBlock,
      fullDiffCoverage: diffHunks,
      explorationTier,
      context7Block,
      shards,
      requireCompleteEmbeddedDiff: mainRequiresCompleteEmbeddedDiff,
      diffHunksOptions: mainRequiresCompleteEmbeddedDiff
        ? EMBEDDED_ONLY_BACKEND_DIFF_HUNKS_OPTIONS
        : undefined,
      embeddedFirstPrompt: options.embeddedFirstPrompt,
    });

    // Opt-in via an operator-configured directory, NEVER a path inside the
    // reviewed checkout: the workspace is the PR author's tree, so a cache
    // read from it would let a PR commit a forged "clean" result for its own
    // shard and skip review entirely — resolveShardCacheDir enforces that
    // even for a misconfigured path. Local mode also has no headSha (the
    // right side is a worktree), so exact content-addressing is off there.
    // Fingerprints hash the shard's full prompt payload and are computed per
    // ATTEMPT in runShardedReview: the Context7-stripped retry produces a
    // different prompt and must never be cached under the primary key.
    const shardCacheDir =
      headSha && options.shardCachePath
        ? resolveShardCacheDir(options.shardCachePath, workspace)
        : undefined;
    if (headSha && options.shardCachePath && !shardCacheDir) {
      log(
        'Shard cache disabled: the configured directory resolves inside the reviewed checkout (forgeable).',
      );
    }
    const shardCache =
      shardCacheDir && headSha
        ? {
            dir: shardCacheDir,
            headSha,
            // Provider-call config changes output without changing the prompt;
            // a re-run under different options or endpoint must never hit the
            // old entry.
            config: JSON.stringify({
              engine: mainBackend.name,
              modelOptions: options.modelOptions,
              baseURL,
              ...(options.embeddedFirstPrompt ? { embeddedFirstPrompt: true } : {}),
            }),
          }
        : undefined;

    log(
      formatContextBudget([
        { name: 'guidelines', text: guidelinesForPrompt },
        { name: 'core', text: mainCoreContext },
        { name: 'diff', text: mainDiffBlock },
        { name: 'context7', text: context7Block },
      ]),
    );
    log(`Running review (${shardPlans.length} shard(s))`);
    contextAssemblyDone();
    const mainExecutionDone = phases.start({
      phase: 'main-execution',
      scope: 'run',
      backend: mainBackend.name,
      ...(telemetry.enabled
        ? { inputBytes: Buffer.byteLength(mainCoreContext) + Buffer.byteLength(mainDiffBlock) }
        : {}),
    });
    // Submit every main shard before auxiliary work. Priority ordering also
    // keeps a later main-shard retry ahead of queued auxiliary sessions.
    const mainReview = runShardedReview({
      backend: mainBackend,
      model,
      guidelinesForPrompt,
      shardPlans,
      changedFiles,
      timeoutMs: finderTimeoutMs,
      deadlineAt: computeRunDeadline(options.timeBudgetMinutes, runStartedAt),
      context7Active,
      context7ApiKey: options.context7ApiKey,
      disableContext7: opencodeRuntime
        ? () => disableContext7Mcp(opencodeRuntime!.client, log)
        : undefined,
      evidenceQuotes: options.evidenceQuotes,
      embeddedFirstPrompt: options.embeddedFirstPrompt,
      // Local mode has no PR to go stale; GitHub runs re-check before a retry
      // of a long attempt. Fetch failures fail open inside runShardedReview.
      ...(!localDiff && headSha
        ? {
            staleCheck: async () => {
              const fresh = await getPullFreshness(octokit, owner, repo, pullNumber);
              if (fresh.merged) return new StaleReviewError('merged');
              if (fresh.state === 'closed') return new StaleReviewError('closed');
              if (fresh.headSha && fresh.headSha !== headSha) {
                return new StaleReviewError('head-moved');
              }
              return undefined;
            },
          }
        : {}),
      log,
      onTokenUsage: recordTokenUsage,
      onCoverage: recordCoverage,
      cache: shardCache,
    });

    const addressedPriorCheck = trackAux(
      'addressed-prior-comments',
      startAddressedPriorCommentsCheck({
        backend: auxBackend,
        model: auxModel,
        prContext: auxPrContext,
        priorJbotThreads: auxSessionsEnabled ? priorJbotThreads : [],
        timeoutMs: finderTimeoutMs,
        log,
        onTokenUsage: recordTokenUsage,
        onCoverage: recordCoverage,
      }),
    );

    const guidelineComplianceCheck = trackAux(
      'guideline-compliance',
      startGuidelineComplianceCheck({
        backend: auxBackend,
        model: auxModel,
        prContext: auxPrContext,
        guidelinesForPrompt: guidelines,
        hasGuidelines: Boolean(guidelines),
        enabled: incrementalLenses.guidelinePass,
        timeoutMs: finderTimeoutMs,
        log,
        onTokenUsage: recordTokenUsage,
        onCoverage: recordCoverage,
      }),
    );

    const changesSinceLastReview = trackAux(
      'changes-since-last-review',
      startChangesSinceLastReviewSummary({
        backend: auxBackend,
        model: auxModel,
        prContext: auxPrContext,
        workspace,
        // Use allPriorReviewComments (always fetched), NOT the
        // includePriorComments-gated priorComments: whether to summarize the
        // delta is a re-review decision, independent of whether prior comments
        // are injected into the finder CONTEXT. Same rule as priorJbotReviewCount
        // (see the comment above its definition). Gating on priorComments here
        // silently disables the block whenever include-prior-comments is false.
        reviewedHead,
        headSha,
        enabled:
          shouldSummarizeChangesSinceLastReview(allPriorReviewComments, headSha) &&
          auxSessionsEnabled,
        timeoutMs: finderTimeoutMs,
        log,
        onTokenUsage: recordTokenUsage,
        onCoverage: recordCoverage,
      }),
    );

    // Lens passes run on the aux model (recall supplement, not the deep
    // pass) and use the aux context (no Context7 block): they have no
    // Context7 retry path, so a Context7 hiccup must not be able to zero a
    // pass's findings.
    const lensPasses = trackAux(
      `${incrementalLenses.lensKeys.length} lens pass(es)`,
      startLensPasses({
        backend: auxBackend,
        model: auxModel,
        prContext: auxPrContext,
        guidelinesForPrompt,
        lensKeys: incrementalLenses.lensKeys,
        timeoutMs: finderTimeoutMs,
        evidenceQuotes: options.evidenceQuotes,
        embeddedFirstPrompt: options.embeddedFirstPrompt,
        log,
        onTokenUsage: recordTokenUsage,
        onCoverage: recordCoverage,
      }),
    );

    let summary: string;
    let findings: Finding[];
    try {
      ({ summary, findings } = await mainReview);
    } catch (error) {
      // TASK-155: the PR merged, closed, or moved mid-review — nothing this
      // run produces can post against the reviewed state. Not a failure: the
      // freshest-head run (or none) is the correct outcome.
      if (error instanceof StaleReviewError) {
        mainExecutionDone('failed');
        log(`Review abandoned before retry: ${error.message}. Posting nothing.`);
        recordCoverage({ session: 'stale-before-retry', state: 'skipped' });
        finishTelemetry('skipped');
        return;
      }
      throw error;
    }
    mainExecutionDone(
      'completed',
      telemetry.enabled
        ? Buffer.byteLength(summary) + Buffer.byteLength(JSON.stringify(findings))
        : undefined,
    );
    const auxiliaryWaitLabels = pendingAuxiliarySessionLabels([
      lensPasses,
      addressedPriorCheck,
      guidelineComplianceCheck,
      changesSinceLastReview,
    ]);
    if (auxiliaryWaitLabels.length > 0) {
      log(
        `Main review shards complete; waiting for auxiliary session(s) to settle: ${auxiliaryWaitLabels.join(
          ', ',
        )}.`,
      );
    }
    // Started together, not awaited in turn: each grace begins when its call is
    // made, so awaiting them one by one would give the group N graces of tail
    // rather than one. Each falls back to its own empty result — the same value
    // these sessions produce when they fail open on their own.
    const graceDone = phases.start({ phase: 'grace-wait', scope: 'run' });
    // Abandonment aborts the underlying sessions where the backend supports it
    // (pi + opencode today): the fallback is already settled, so everything
    // the session still generates is waste — decode, a held slot the verifier
    // can queue behind, and process linger.
    const abandonAuxSessions = (labels: string[]) => () => {
      for (const label of labels) auxBackend.abortSessionsByLabel?.(label, log);
    };
    const [
      lensFindingLists,
      // The dedicated parallel session is the single owner of addressed-thread
      // verification; the main review no longer reports them.
      verifiedAddressedPriorComments,
      complianceFindings,
      changesSinceText,
    ] = await Promise.all([
      settleWithinGrace(
        lensPasses,
        [],
        log,
        AUXILIARY_SETTLE_GRACE_MS,
        abandonAuxSessions(incrementalLenses.lensKeys.map((key) => `review-${key}`)),
      ),
      settleWithinGrace(
        addressedPriorCheck,
        [],
        log,
        AUXILIARY_SETTLE_GRACE_MS,
        abandonAuxSessions(['addressed-prior-comments']),
      ),
      settleWithinGrace(
        guidelineComplianceCheck,
        [],
        log,
        AUXILIARY_SETTLE_GRACE_MS,
        abandonAuxSessions(['guideline-compliance']),
      ),
      settleWithinGrace(
        changesSinceLastReview,
        '',
        log,
        AUXILIARY_SETTLE_GRACE_MS,
        abandonAuxSessions(['changes-since-last-review']),
      ),
    ]);
    graceDone();
    // Gate confidence BEFORE deduping so each finding carries its effective
    // severity into collision resolution; otherwise a low-confidence main
    // finding could win a path:line collision and then be demoted to P3,
    // dropping a stronger compliance finding at the same location.
    // Tag findings with telemetry ids per source session; a disabled recorder
    // returns the lists untouched.
    const initialFilteringDone = phases.start({ phase: 'filtering', scope: 'run' });
    const producedLists = [
      telemetry.produced('main-review', findings),
      ...lensFindingLists.map((list, i) =>
        telemetry.produced(`review-${incrementalLenses.lensKeys[i]}`, list),
      ),
      telemetry.produced('guideline-compliance', complianceFindings),
    ];
    const gatedLists = producedLists.map(demoteLowConfidenceBlockingFindings);
    telemetry.snapshot(
      'gated',
      gatedLists.flatMap((gated) => gated.findings),
    );
    const demotedCount = gatedLists.reduce((sum, gated) => sum + gated.demotedCount, 0);
    if (demotedCount > 0) {
      log(`Demoted ${demotedCount} low-confidence blocking finding(s) to P3.`);
    }
    // Must precede dedupe and suppression — both compare path:line.
    const reanchored = gatedLists.flatMap((gated) =>
      resolveFindingAnchors(gated.findings, addable, patchByPath, options.evidenceQuotes),
    );
    if (reanchored.length > 0) {
      log(`Re-anchored ${reanchored.length} finding(s) from their evidence quote.`);
    }
    // Main review first: on equal-strength path:line collisions its richer
    // general context wins over lens and compliance findings.
    const combinedFindings = dedupeFindings(...gatedLists.map((gated) => gated.findings));
    telemetry.snapshot('deduped', combinedFindings);
    const dedupeDropped =
      gatedLists.reduce((sum, gated) => sum + gated.findings.length, 0) - combinedFindings.length;
    if (dedupeDropped > 0) {
      log(`Deduped ${dedupeDropped} finding(s) that collided on path:line across sessions.`);
    }
    // Full-diff re-review means repeats are possible by design; this is the
    // in-code backstop that drops findings prior jbot threads already cover.
    const suppression = suppressPreviouslyReported(
      combinedFindings,
      priorJbotThreads,
      headSha ? addable : undefined,
    );
    telemetry.snapshot('suppressed', suppression.findings);
    if (suppression.suppressedCount > 0) {
      log(
        `Suppressed ${suppression.suppressedCount} finding(s) already covered by prior jbot-review threads.`,
      );
    }
    initialFilteringDone(
      'completed',
      telemetry.enabled ? Buffer.byteLength(JSON.stringify(suppression.findings)) : undefined,
    );
    const verificationDone = phases.start({ phase: 'verification', scope: 'run' });
    const verifiedFindings = await verifyBlockingFindings({
      backend: auxBackend,
      model: auxModel,
      prContext: verifierPrContext,
      timeoutMs: computeVerificationTimeoutMs(options.timeBudgetMinutes, Date.now() - runStartedAt),
      findings: suppression.findings,
      enabled: options.verifyFindings && auxSessionsEnabled,
      modelOptions: verifierSessionOptions,
      log,
      onTokenUsage: recordTokenUsage,
      onCoverage: recordCoverage,
    });
    verificationDone(
      'completed',
      telemetry.enabled ? Buffer.byteLength(JSON.stringify(verifiedFindings)) : undefined,
    );
    telemetry.snapshot('verified', verifiedFindings);
    const finalFilteringDone = phases.start({ phase: 'filtering', scope: 'run' });
    const filteredFindings = filterFindings(verifiedFindings, options);
    telemetry.snapshot('filtered', filteredFindings);
    log(
      `Review complete: ${findings.length} main + ${lensFindingLists.flat().length} lens + ${complianceFindings.length} compliance finding(s), ${filteredFindings.length} after filters, ${verifiedAddressedPriorComments.length} addressed prior comment(s)`,
    );

    const { inline, fileLevel, orphaned, anchorMissed } = anchorFindings(
      filteredFindings,
      addable,
      !!headSha,
    );
    // Re-anchoring runs before dedupe/verify/filter, so some of it did not
    // survive; telemetry's rescued set must stay a subset of what was posted.
    const reanchoredIds = new Set(reanchored.map((f) => f.id));
    telemetry.route({
      inline,
      fileLevel,
      orphaned,
      // Ids exist only while telemetry is on, and an undefined id matches every
      // other finding that lacks one — so never look one up.
      rescued: inline.filter((f) => f.id !== undefined && reanchoredIds.has(f.id)),
      anchorMissed,
    });
    const verdict = decideVerdict(filteredFindings);
    finalFilteringDone(
      'completed',
      telemetry.enabled ? Buffer.byteLength(JSON.stringify(filteredFindings)) : undefined,
    );
    const postingDone = phases.start({ phase: 'posting', scope: 'run' });

    // Report the final filtered findings + summary on EVERY completed review (dry-run or
    // real post), so a caller can forward per-severity counts (the worker → check-run gate).
    // Isolated: this is a side-channel hook and must not abort the actual review post below.
    // Terminal telemetry is NOT written here: 'completed' is only earned after
    // the posting/approval phase below succeeds.
    try {
      options.onReviewResult?.({
        summary,
        findings: filteredFindings,
        addressedPriorComments: verifiedAddressedPriorComments,
        ...(telemetry.enabled ? { telemetry: telemetry.toJsonl() } : {}),
      });
    } catch (err) {
      log(`onReviewResult hook threw (ignored): ${String(err)}`);
    }

    if (options.dryRun) {
      const body = buildBody(
        changesSinceText,
        summary,
        filteredFindings,
        orphaned,
        model,
        owner,
        repo,
        headSha,
        tokenUsage.snapshot(),
        engineByModel,
      );
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
      postingDone();
      finishTelemetry('completed');
      return;
    }

    // Don't post a redundant "all clear" comment on a re-run.
    // `priorJbotReviewCount` is computed
    // up front (independent of includePriorComments). Addressed-thread replies
    // (below) still run regardless.
    const findingCount = inline.length + fileLevel.length + orphaned.length;
    const shouldPostComment = shouldPostReviewComment(priorJbotReviewCount, findingCount);
    const deferCleanComment = options.autoApprove && verifiedFindings.length === 0;
    const buildCurrentBody = () =>
      buildBody(
        changesSinceText,
        summary,
        filteredFindings,
        orphaned,
        model,
        owner,
        repo,
        headSha,
        tokenUsage.snapshot(),
        engineByModel,
      );
    const postCurrentReviewIfNeeded = async (): Promise<void> => {
      if (!shouldPostComment) {
        log('No new findings on a re-run; skipping the review comment (reacting instead).');
        return;
      }

      // File-level comments go first so a posting failure can still fall back
      // into the review body, which is built afterwards.
      const fileLevelCommentIds: number[] = [];
      for (const finding of fileLevel) {
        try {
          fileLevelCommentIds.push(
            await postFileLevelComment(
              octokit,
              owner,
              repo,
              pullNumber,
              headSha as string,
              finding,
            ),
          );
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

      const body = buildCurrentBody();
      log(
        `Posting review: verdict=${verdict} inline=${inline.length} file-level=${fileLevel.length} orphaned=${orphaned.length}`,
      );
      const { inlinePosted, inlineDropped } = await postReview(
        octokit,
        owner,
        repo,
        pullNumber,
        verdict,
        body,
        inline,
        fileLevelCommentIds,
        headSha as string,
      );
      log(
        inlineDropped > 0
          ? `Review posted; ${inlineDropped} inline comment(s) failed to anchor (${inlinePosted} salvaged).`
          : 'Review posted.',
      );
    };

    if (!deferCleanComment) await postCurrentReviewIfNeeded();

    const resolvedThisRun = await acknowledgeAddressedPriorComments({
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
    // Retry-close threads jbot already marked addressed whose resolve never
    // landed (e.g. a past run lacked the permission it now has).
    if (unresolvedAddressedThreadIds.length > 0) {
      const reResolved = await resolveUnresolvedAddressedThreads({
        octokit,
        threadResolutionOctokit: params.threadResolutionOctokit,
        threadIds: unresolvedAddressedThreadIds,
        log,
      });
      resolvedThisRun.push(...reResolved);
    }
    await finalizePriorResolvedReviews(resolvedThisRun);
    // React 🚀 only when the PR has NO open jbot findings after this run.
    // Open = threads that are not already resolved AND were not resolved this
    // run (a model-claimed "addressed" whose reply/resolve failed stays open,
    // and a human-resolved thread counts as closed). Uses allPriorJbotThreads,
    // not the includePriorComments-gated list, so the gate is honest even when
    // prior context is disabled. An addressed thread whose resolve retry failed
    // (permission/error) is still visibly open, so it counts too — else 🚀
    // would claim "clean" over an open thread.
    const failedAddressedResolves = unresolvedAddressedThreadIds.filter(
      (id) => !resolvedThisRun.includes(id),
    ).length;
    const openThreadCount =
      openFindingThreadIds(allPriorJbotThreads, resolvedThisRun).length + failedAddressedResolves;
    const approvalClean = isPrCleanAfterRun(
      verifiedFindings.length,
      openThreadCount,
      priorThreadStateKnown,
    );
    let approved = false;
    if (options.autoApprove && approvalClean) {
      const reviewedHeadSha = headSha!;
      let decision: AutoApprovalDecision | undefined;
      try {
        decision = await checkAutoApprovalEligibility(
          octokit,
          owner,
          repo,
          pullNumber,
          reviewedHeadSha,
        );
      } catch (error) {
        log(
          `Could not verify auto-approval safety; leaving a comment instead: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (decision?.status === 'eligible') {
        try {
          await postApprovalReview(
            octokit,
            owner,
            repo,
            pullNumber,
            buildCurrentBody(),
            reviewedHeadSha,
          );
          approved = true;
          log(`Approved reviewed head ${reviewedHeadSha}.`);
        } catch (error) {
          if (!isDefinitiveApprovalRejection(error)) throw error;
          log(
            `GitHub rejected auto-approval; leaving a comment instead: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else if (decision?.status === 'already-approved') {
        approved = true;
        log(`Reviewed head ${reviewedHeadSha} already has a jbot approval; skipping a duplicate.`);
      } else if (decision?.status === 'blocked') {
        log(`Auto-approval skipped: ${decision.reason}.`);
      }
    } else if (options.autoApprove && !priorThreadStateKnown) {
      log('Auto-approval skipped: prior jbot-review thread state is unavailable.');
    }

    if (deferCleanComment && !approved) await postCurrentReviewIfNeeded();

    if (isPrCleanAfterRun(findingCount, openThreadCount, priorThreadStateKnown)) {
      await safeAddReviewReaction(octokit, owner, repo, pullNumber, log);
    } else if (!priorThreadStateKnown) {
      log('Prior jbot-review thread state is unavailable; not adding the review-done reaction.');
    } else {
      log('Open findings remain; not adding the review-done reaction.');
    }

    postingDone();
    finishTelemetry('completed');
  } finally {
    const teardownDone = phases.start({ phase: 'teardown', scope: 'run' });
    let teardownCompleted = false;
    try {
      stop();
      cleanupCliHomes();
      teardownCompleted = true;
    } finally {
      teardownDone(teardownCompleted ? 'completed' : 'failed');
      phases.finishOpen(teardownCompleted ? 'aborted' : 'failed');
      if (!teardownCompleted) {
        telemetryDone = true;
        telemetryTerminalState = 'failed';
      }
      teardownPending = false;
      if (telemetryTerminalState) {
        telemetry.finishRun(telemetryTerminalState, Date.now() - runStartedAt);
        emitTelemetry();
      }
    }
  }
}

/**
 * Public entry: runs the review pipeline and, when the observer is enabled
 * (`JBOT_OBSERVER_URL`), reports the run's verdict and flushes the tee. All
 * observer calls are no-ops otherwise, so this wrapper is free for normal runs.
 *
 * Everything a run still needs must finish before this resolves: single-run
 * entries arm `exitOnLingeringHandles` on settle, and that is a kill clock.
 */
export async function runPrReview(params: Parameters<typeof runReviewPipeline>[0]): Promise<void> {
  setRunName(`pr-${params.owner}-${params.repo}-${params.pullNumber}`);
  // Announce the run as in-progress so live/mid-run viewers see "reviewing"
  // until the terminal verdict overwrites it.
  reportRun('reviewing');
  const telemetryLifecycle: { onFailure?: () => void } = {};
  try {
    await runReviewPipeline({ ...params, telemetryLifecycle });
    reportRun('completed');
  } catch (error) {
    telemetryLifecycle.onFailure?.();
    reportRun('failed');
    throw error;
  } finally {
    // The streaming tee holds the event loop open, so this explicit close is
    // what lets an observer-enabled process exit (beforeExit can't fire).
    await closeObserver();
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
    log(`(could not add ${REVIEW_DONE_REACTION} reaction: ${describeReactionError(error)})`);
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
    log(
      `(could not clear prior ${REVIEW_DONE_REACTION} reaction: ${describeReactionError(error)})`,
    );
  }
}

/**
 * Reaction failures are most often a missing permission: PR reactions use the
 * issues API, and listing/deleting them needs `issues: write` (creating one
 * happens to work under `pull-requests: write`, which is why an unclearable
 * reaction can appear). Surface the fix in the log.
 */
function describeReactionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return isResourceNotAccessibleByIntegration(message)
    ? `${message} — grant the workflow \`issues: write\` so jbot can manage its review reaction`
    : message;
}

type NormalizedReviewRunOptions = Required<Omit<ReviewRunOptions, 'onReviewResult'>> &
  Pick<ReviewRunOptions, 'onReviewResult'>;

/** Exported for defaults tests; runPrReview is the only production caller. */
export function normalizeOptions(
  options: ReviewRunOptions | undefined,
): NormalizedReviewRunOptions {
  // Only the count-rationed lenses scale with passes; the frontend lens is
  // content-triggered and added on top (see selectLensKeys), so it does not
  // raise the useful pass ceiling.
  const maxPasses = 1 + COUNTED_LENS_KEYS.length;
  return {
    enhancedContext: options?.enhancedContext ?? false,
    scrubSessionEnv: options?.scrubSessionEnv ?? true,
    opencodeProxyEnv: options?.opencodeProxyEnv ?? {},
    sdkEngine: options?.sdkEngine ?? '',
    dryRun: options?.dryRun ?? false,
    autoApprove: options?.autoApprove ?? false,
    maxFindings: options?.maxFindings ?? 0,
    minSeverity: options?.minSeverity ?? 'nit',
    includePriorComments: options?.includePriorComments ?? true,
    context7Mode: options?.context7Mode ?? 'auto',
    context7ApiKey: options?.context7ApiKey ?? '',
    guidelinePass: options?.guidelinePass ?? true,
    shardCachePath: options?.shardCachePath ?? '',
    contextTrim: options?.contextTrim ?? false,
    embeddedFirstPrompt: options?.embeddedFirstPrompt ?? true,
    guidelineWiden: options?.guidelineWiden ?? 'auto',
    verifierSlimContext: options?.verifierSlimContext ?? false,
    auxModel: options?.auxModel ?? '',
    auxApiKey: options?.auxApiKey ?? '',
    auxBaseURL: options?.auxBaseURL ?? '',
    reviewPasses: Math.min(Math.max(options?.reviewPasses ?? 1, 1), maxPasses),
    verifyFindings: options?.verifyFindings ?? true,
    timeBudgetMinutes: Math.max(options?.timeBudgetMinutes ?? 0, 0),
    reviewShards: Math.max(options?.reviewShards ?? 0, 0),
    modelOptions: options?.modelOptions ?? {},
    promptCache: options?.promptCache ?? true,
    skipDocOnly: options?.skipDocOnly ?? true,
    dynamicFanout: options?.dynamicFanout ?? true,
    // Capped by default: throttled tiers serialize upstream anyway, and an
    // uncapped burst turns session deadlines into queue-time measurements
    // (see the flash-tier note in opencode.ts). 3 matches the dogfood-proven
    // cap; explicit 0 = unlimited.
    maxConcurrentSessions: Math.max(options?.maxConcurrentSessions ?? 3, 0),
    opencodePort: Math.max(options?.opencodePort ?? 0, 0),
    reviewTelemetry: options?.reviewTelemetry ?? true,
    evidenceQuotes: options?.evidenceQuotes ?? true,
    onReviewResult: options?.onReviewResult,
  };
}

/**
 * Post-review telemetry sink: disposition summary log line + JSONL under
 * `.jbot-review/` (CI uploads it). Fail-open; no-op when disabled.
 */
export function emitReviewTelemetry(
  telemetry: TelemetryRecorder,
  workspace: string,
  log: (msg: string) => void,
): void {
  if (!telemetry.enabled) return;
  const rows = telemetry.findingRows();
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.disposition, (counts.get(row.disposition) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .map(([disposition, n]) => `${n} ${disposition}`)
    .join(', ');
  log(`Telemetry: ${rows.length} finding(s) produced${breakdown ? ` (${breakdown})` : ''}.`);
  try {
    const dir = join(workspace, '.jbot-review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'telemetry.jsonl'), `${telemetry.toJsonl()}\n`);
    log('Telemetry written to .jbot-review/telemetry.jsonl');
  } catch (err) {
    log(`(telemetry write skipped: ${err instanceof Error ? err.message : String(err)})`);
  }
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
  backend: ReviewBackend;
  model: string;
  prContext: string;
  guidelinesForPrompt: string;
  lensKeys: string[];
  timeoutMs?: number;
  evidenceQuotes?: boolean;
  embeddedFirstPrompt?: boolean;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
  onCoverage?: SessionCoverageRecorder;
}): Promise<Finding[][]> {
  const { lensKeys } = params;
  if (lensKeys.length === 0) return Promise.resolve([]);

  params.log(`Starting ${lensKeys.length} lens pass(es) in parallel: ${lensKeys.join(', ')}.`);
  return Promise.all(
    lensKeys.map((key) => {
      const startedAt = Date.now();
      return params.backend
        .runReview(params.model, params.prContext, params.guidelinesForPrompt, params.log, {
          lensAddendum: REVIEW_LENSES[key],
          label: `review-${key}`,
          timeoutMs: params.timeoutMs,
          onTokenUsage: params.onTokenUsage,
          evidenceQuotes: params.evidenceQuotes,
          embeddedFirstPrompt: params.embeddedFirstPrompt,
        })
        .then((result) => {
          params.log(`${key} lens pass complete: ${result.findings.length} finding(s).`);
          params.onCoverage?.({
            session: `review-${key}`,
            state: 'completed',
            durationMs: Date.now() - startedAt,
          });
          return result.findings;
        })
        .catch((error) => {
          params.log(
            `(skipped ${key} lens pass: ${error instanceof Error ? error.message : String(error)})`,
          );
          params.onCoverage?.({
            session: `review-${key}`,
            state: 'failed',
            error,
            durationMs: Date.now() - startedAt,
          });
          return [];
        });
    }),
  );
}

interface AuxiliarySession<T> {
  label: string;
  promise: Promise<T>;
  isSettled: () => boolean;
}

function trackAuxiliarySession<T>(label: string, promise: Promise<T>): AuxiliarySession<T> {
  let settled = false;
  return {
    label,
    promise: promise.finally(() => {
      settled = true;
    }),
    isSettled: () => settled,
  };
}

function pendingAuxiliarySessionLabels(
  sessions: { label: string; isSettled: () => boolean }[],
): string[] {
  return sessions.filter((session) => !session.isSettled()).map((session) => session.label);
}

/**
 * Grace an auxiliary session gets once the main review is done. Aux work is a
 * recall supplement that already fails open (invariant #3), so past this point
 * it is pure tail: the deep pass has landed and the run is only waiting. The
 * finder budget is the wrong bound here — it is sized for a session that gates
 * the review, and lets one lens (or its JSON repair) add many minutes to a run
 * whose useful work has finished.
 */
const AUXILIARY_SETTLE_GRACE_MS = 120_000;

/** Distinguishes the grace expiring from the session failing on its own. */
const GRACE_EXPIRED = 'jbot: auxiliary settle grace expired';

/**
 * Resolves to the session's value, or to `fallback` if it has not settled
 * within the grace. Never rejects: aux work fails open (invariant #3), so a
 * session that already failed yields the fallback just like one that runs out
 * of grace — otherwise a settled rejection would abort the run through the
 * caller's Promise.all.
 *
 * Bounds the wait AND, where the backend supports it, the session: once the
 * fallback is settled, `onAbandon` fires so the caller can abort the
 * underlying prompt (TASK-076/077) — otherwise it runs on and keeps its
 * concurrency slot until teardown, and with every slot held the verifier can
 * still queue behind one. Settle-first ordering is deliberate (RISK-007): a
 * result racing the abort keeps the result, and aborting an
 * already-completed session is a backend no-op.
 */
export function settleWithinGrace<T>(
  session: AuxiliarySession<T>,
  fallback: T,
  log: (msg: string) => void,
  graceMs = AUXILIARY_SETTLE_GRACE_MS,
  onAbandon?: () => void,
): Promise<T> {
  if (session.isSettled()) return session.promise.catch(() => fallback);
  return withTimeout(session.promise, graceMs, GRACE_EXPIRED).catch((error: unknown) => {
    // Only the grace expiring is worth a line; a session that failed on its own
    // already logged why.
    if (error instanceof Error && error.message === GRACE_EXPIRED) {
      log(
        `${session.label} still running ${graceMs / 1000}s after the main review; abandoning it.`,
      );
      if (!session.isSettled()) onAbandon?.();
    }
    return fallback;
  });
}

/**
 * Adversarial precision gate: blocking findings are re-checked by a verifier
 * session prompted to refute them. Refuted findings are dropped, uncertain
 * ones demoted to advisory. Fail-open everywhere — when verification cannot
 * run or returns garbage, findings pass through unchanged.
 */
async function verifyBlockingFindings(params: {
  backend: ReviewBackend;
  model: string;
  prContext: string;
  findings: Finding[];
  enabled: boolean;
  timeoutMs?: number;
  /** TASK-157: the verifier's floored options when the aux entry lacks them. */
  modelOptions?: Record<string, unknown>;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
  onCoverage?: SessionCoverageRecorder;
}): Promise<Finding[]> {
  const session = 'finding-verification';
  if (!params.enabled) {
    params.onCoverage?.({ session, state: 'skipped' });
    return params.findings;
  }
  if (params.timeoutMs === 0) {
    params.log(
      'Skipping finding verification: time budget exhausted; posting findings unverified (fail-open).',
    );
    params.onCoverage?.({ session, state: 'skipped' });
    return params.findings;
  }

  const selectedIndexes = selectBlockingFindingIndexes(params.findings, MAX_VERIFIED_FINDINGS);
  if (selectedIndexes.length === 0) {
    params.onCoverage?.({ session, state: 'skipped' });
    return params.findings;
  }

  const targets = selectedIndexes.map((index) => params.findings[index]);
  params.log(`Verifying ${targets.length} blocking finding(s) before posting.`);

  const startedAt = Date.now();
  let verdicts;
  try {
    verdicts = await params.backend.runFindingVerification(
      params.model,
      params.prContext,
      targets,
      params.log,
      params.timeoutMs,
      params.onTokenUsage,
      params.modelOptions,
    );
  } catch (error) {
    params.log(
      `(skipped finding verification: ${error instanceof Error ? error.message : String(error)})`,
    );
    params.onCoverage?.({ session, state: 'failed', error, durationMs: Date.now() - startedAt });
    return params.findings;
  }
  if (!verdicts) {
    params.log('(finding verification output unusable; keeping findings unverified)');
    params.onCoverage?.({ session, state: 'failed', durationMs: Date.now() - startedAt });
    return params.findings;
  }
  params.onCoverage?.({ session, state: 'completed', durationMs: Date.now() - startedAt });

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
  return `- ${formatFindingLocation(finding)} ${formatFindingLabel(finding)} ${finding.title}\n  ${indentedBody}`;
}

function formatAddressedPriorComment(comment: AddressedPriorComment): string {
  const commit = comment.addressedByCommit ? ` (${comment.addressedByCommit})` : '';
  return `- ${comment.id}${commit}`;
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
  /** Budget and the coverage gaps this shard is allowed to recover. */
  exploration: ExplorationPlan;
}

/**
 * One plan per main-review session. A single shard reproduces the classic
 * whole-PR review; multiple shards each get the full core context (PR
 * metadata, guidelines pointers, prior threads, blast radius) plus their own
 * assignment block and diff slice, so every shard can reason across the
 * whole PR but anchors only in its files.
 */
export function buildShardPlans(params: {
  coreContext: string;
  fullDiffBlock: string;
  fullDiffCoverage: { truncatedFiles: string[]; omittedFiles: string[] };
  explorationTier: ExplorationTier;
  context7Block: string;
  shards: ReturnType<typeof shardFilesForReview>;
  requireCompleteEmbeddedDiff?: boolean;
  diffHunksOptions?: DiffHunksOptions;
  embeddedFirstPrompt?: boolean;
}): ShardPlan[] {
  const {
    coreContext,
    fullDiffBlock,
    fullDiffCoverage,
    explorationTier,
    context7Block,
    shards,
    requireCompleteEmbeddedDiff = false,
    diffHunksOptions,
  } = params;
  const explorationFor = (result: { truncatedFiles: string[]; omittedFiles: string[] }) => {
    const plan = planExploration({ tier: explorationTier, ...result });
    assertRecoverableCoverage(plan);
    return plan;
  };
  if (shards.length <= 1) {
    const diffResult = requireCompleteEmbeddedDiff
      ? buildDiffHunksBlockWithMetadata(shards[0] ?? [], diffHunksOptions)
      : { text: fullDiffBlock, ...fullDiffCoverage };
    if (requireCompleteEmbeddedDiff) {
      assertCompleteEmbeddedDiff(diffResult, 'review');
    }
    const baseContext = joinContext(coreContext, diffResult.text);
    return [
      {
        label: 'review',
        context: joinContext(baseContext, context7Block),
        baseContext,
        assignedFiles: (shards[0] ?? []).map((file) => file.filename),
        exploration: explorationFor(diffResult),
      },
    ];
  }
  return shards.map((shard, index) => {
    const assignedFiles = shard.map((file) => file.filename);
    const assignment = buildShardAssignmentBlock(
      assignedFiles,
      index,
      shards.length,
      params.embeddedFirstPrompt,
    );
    const diffResult = buildDiffHunksBlockWithMetadata(shard, diffHunksOptions);
    if (requireCompleteEmbeddedDiff) {
      assertCompleteEmbeddedDiff(diffResult, `review-shard-${index + 1}`);
    }
    return {
      label: `review-shard-${index + 1}`,
      context: joinContext(coreContext, context7Block, assignment, diffResult.text),
      baseContext: joinContext(coreContext, assignment, diffResult.text),
      assignedFiles,
      exploration: explorationFor(diffResult),
    };
  });
}

function assertCompleteEmbeddedDiff(
  result: ReturnType<typeof buildDiffHunksBlockWithMetadata>,
  label: string,
): void {
  const incomplete = incompleteDiffFiles(result);
  if (incomplete.length === 0) return;
  throw new Error(
    `Embedded-only backend ${label} would receive an incomplete embedded diff (${formatFileList(
      incomplete,
    )}). ` +
      'The embed budget for these backends is unbounded, so this means it was reinstated somewhere; the provider cannot read the checkout, and partial coverage must never be reported as a whole review.',
  );
}

function incompleteDiffFiles(result: ReturnType<typeof buildDiffHunksBlockWithMetadata>): string[] {
  return [...new Set([...result.truncatedFiles, ...result.omittedFiles])];
}

/**
 * Runs the main review as parallel shard sessions and merges the results.
 * Wall clock is the slowest shard, not the whole PR. Each shard owns a slice
 * of the changed files, so an unrecovered main-shard failure is a coverage
 * hole and fails the main review. Auxiliary sessions fail open; main shards
 * do not. In sharded mode each shard's findings are clamped in code to its
 * assigned files so parallel shards cannot duplicate or poach each other.
 */
/**
 * The verifier's slim context (TASK-065, JBOT_VERIFIER_SLIM_CONTEXT): the
 * claim-checking inputs — untrusted-input guard, PR title/body/diff scope,
 * linked issues, changed files, and the SAME full diff block the aux path
 * carries — without the commits, prior comments/threads, playbooks, and
 * summary instructions the verifier never cites. Exported for tests.
 */
export function buildSlimVerifierContext(params: {
  pullTitle: string;
  pullBody: string;
  changedFiles: string[];
  diffScope?: Parameters<typeof buildReviewContext>[0]['diffScope'];
  linkedIssues: LinkedIssue[];
  linkedIssuesOmitted: number;
  auxDiffBlockText: string;
}): string {
  return joinContext(
    UNTRUSTED_PR_CONTENT_NOTE,
    buildReviewContext({
      pullTitle: params.pullTitle,
      pullBody: params.pullBody,
      changedFiles: params.changedFiles,
      priorComments: [],
      commits: [],
      checkSummary: 'Omitted for verification.',
      guidelines: '',
      ...(params.diffScope ? { diffScope: params.diffScope } : {}),
      linkedIssues: params.linkedIssues,
      linkedIssuesOmitted: params.linkedIssuesOmitted,
    }),
    params.auxDiffBlockText,
  );
}

/** Exported for retry-policy tests; runReviewPipeline is the only production caller. */
export async function runShardedReview(params: {
  backend: ReviewBackend;
  model: string;
  guidelinesForPrompt: string;
  shardPlans: ShardPlan[];
  changedFiles: string[];
  timeoutMs?: number;
  /** Absolute run deadline (budget minus posting reserve); bounds retries. */
  deadlineAt?: number;
  context7Active: boolean;
  context7ApiKey: string;
  disableContext7?: () => Promise<void>;
  evidenceQuotes?: boolean;
  embeddedFirstPrompt?: boolean;
  /**
   * TASK-155: re-checks PR state before a retry of a long attempt; a returned
   * error aborts the run (thrown) instead of retrying against a stale head.
   * Absent in local mode.
   */
  staleCheck?: () => Promise<StaleReviewError | undefined>;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
  onCoverage?: SessionCoverageRecorder;
  /** Content-addressed reuse of completed shard results. */
  cache?: { dir: string; headSha: string; config: string };
}): Promise<{ summary: string; findings: Finding[] }> {
  const { backend, model, guidelinesForPrompt, shardPlans, timeoutMs, log } = params;
  const sharded = shardPlans.length > 1;
  const changed = new Set(params.changedFiles);

  let context7Disabled = false;
  const disableContext7Once = async () => {
    if (context7Disabled) return;
    context7Disabled = true;
    await params.disableContext7?.();
  };
  // At most one freshness fetch per run: the first long-failed shard checks;
  // a stale result aborts everything through the Promise.all rejection anyway.
  let staleChecked = false;
  const checkStaleOnce = async (): Promise<StaleReviewError | undefined> => {
    if (staleChecked || !params.staleCheck) return undefined;
    staleChecked = true;
    // A broken freshness fetch must not block the retry (fail open).
    return params.staleCheck().catch(() => undefined);
  };

  const outcomes: ShardOutcome[] = await Promise.all(
    shardPlans.map(async (plan): Promise<ShardOutcome> => {
      const startedAt = Date.now();
      const promptBytes =
        Buffer.byteLength(plan.context, 'utf8') + Buffer.byteLength(guidelinesForPrompt, 'utf8');
      const oversized = assembledContextWarning(plan.label, promptBytes);
      if (oversized) log(oversized);
      const cover = (state: 'completed' | 'failed', error?: unknown) =>
        params.onCoverage?.({
          session: plan.label,
          state,
          ...(error !== undefined ? { error } : {}),
          durationMs: Date.now() - startedAt,
          promptBytes,
        });
      // Keyed by the exact prompt DELIVERED: the retry uses baseContext (no
      // Context7 block), a different prompt, so its result must never be
      // stored or found under the primary key.
      const fingerprintFor = (context: string) =>
        params.cache
          ? shardFingerprint({
              headSha: params.cache.headSha,
              model,
              context,
              guidelines: guidelinesForPrompt,
              evidenceQuotes: !!params.evidenceQuotes,
              config: params.cache.config,
            })
          : undefined;
      const primaryFingerprint = fingerprintFor(plan.context);
      if (params.cache && primaryFingerprint) {
        const cached = loadCachedShardResult(params.cache.dir, primaryFingerprint);
        if (cached) {
          log(
            `${plan.label}: reusing cached result for identical content (${primaryFingerprint}).`,
          );
          params.onCoverage?.({ session: plan.label, state: 'reused', promptBytes });
          return { plan, result: cached };
        }
      }
      const persist = (result: ReviewResultLike, fingerprint: string | undefined) => {
        if (params.cache && fingerprint) {
          saveShardResult(params.cache.dir, fingerprint, {
            summary: result.summary,
            findings: result.findings,
          });
        }
      };
      try {
        const result = await backend.runReview(model, plan.context, guidelinesForPrompt, log, {
          label: plan.label,
          timeoutMs,
          onTokenUsage: params.onTokenUsage,
          evidenceQuotes: params.evidenceQuotes,
          embeddedFirstPrompt: params.embeddedFirstPrompt,
          ...(enforcesExplorationBudget(backend.observability)
            ? { exploration: plan.exploration }
            : {}),
        });
        persist(result, primaryFingerprint);
        cover('completed');
        return { plan, result };
      } catch (error) {
        // One retry per shard in a fresh session, for ANY failure: upstream
        // streams drop ("Upstream idle timeout exceeded"), providers blip,
        // and a shard that died early still has budget left. Context7 is a
        // possible culprit, so the retry always uses the base context.
        // The failed primary attempt gets its row HERE, once for every
        // sub-path below — a later reuse/complete must not erase its trace.
        cover('failed', error);
        if (params.context7Active) await disableContext7Once();
        // The retry is its own attempt: its rows carry the -retry session
        // label (matching its token-usage rows), the base-context prompt
        // size, and a duration clocked from the retry itself.
        const retryPromptBytes =
          Buffer.byteLength(plan.baseContext, 'utf8') +
          Buffer.byteLength(guidelinesForPrompt, 'utf8');
        // A prior run's successful retry was saved under the base-context
        // key; the lookup costs no model time, so it runs even with no
        // retry budget left.
        const retryFingerprint = fingerprintFor(plan.baseContext);
        if (params.cache && retryFingerprint) {
          const cached = loadCachedShardResult(params.cache.dir, retryFingerprint);
          if (cached) {
            log(`${plan.label}: reusing cached retry result (${retryFingerprint}).`);
            params.onCoverage?.({
              session: `${plan.label}-retry`,
              state: 'reused',
              promptBytes: retryPromptBytes,
            });
            return { plan, result: cached };
          }
        }
        // TASK-150: a deterministic failure re-buys the identical error for up
        // to another finder window; only plausibly-transient classes retry.
        const { failureClass, retryable } = classifyMainShardFailure(error);
        if (!retryable) {
          log(
            `${plan.label} failed with a non-retryable ${failureClass} error; skipping the retry.`,
          );
          return { plan, error };
        }
        // TASK-155: a long attempt leaves room for the PR to merge, close, or
        // move; re-check before spending another window on a stale head.
        if (Date.now() - startedAt > STALE_CHECK_MIN_ATTEMPT_MS) {
          const stale = await checkStaleOnce();
          if (stale) throw stale;
        }
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
        const retryStartedAt = Date.now();
        const coverRetry = (state: 'completed' | 'failed', retryError?: unknown) =>
          params.onCoverage?.({
            session: `${plan.label}-retry`,
            state,
            ...(retryError !== undefined ? { error: retryError } : {}),
            durationMs: Date.now() - retryStartedAt,
            promptBytes: retryPromptBytes,
          });
        try {
          const result = await backend.runReview(
            model,
            plan.baseContext,
            guidelinesForPrompt,
            log,
            {
              label: `${plan.label}-retry`,
              timeoutMs: retryTimeoutMs,
              onTokenUsage: params.onTokenUsage,
              evidenceQuotes: params.evidenceQuotes,
              embeddedFirstPrompt: params.embeddedFirstPrompt,
              ...(enforcesExplorationBudget(backend.observability)
                ? { exploration: plan.exploration }
                : {}),
            },
          );
          persist(result, retryFingerprint);
          coverRetry('completed');
          return { plan, result };
        } catch (retryError) {
          coverRetry('failed', retryError);
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

export interface ReviewTokenUsage {
  models: string[];
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  creditCost?: number;
  acuCost?: number;
}

function createReviewTokenUsageAccumulator(): {
  add: TokenUsageRecorder;
  snapshot: () => ReviewTokenUsage | undefined;
} {
  let total: ReviewTokenUsage | undefined;
  const models = new Set<string>();
  return {
    add: (usage: PromptTokenUsage, model: string) => {
      total ??= { models: [], input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      models.add(model);
      total.input += usage.input;
      total.output += usage.output;
      total.reasoning += usage.reasoning;
      total.cacheRead += usage.cacheRead;
      total.cacheWrite += usage.cacheWrite;
      if (isFiniteNumber(usage.costUsd)) {
        total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
      }
      if (isFiniteNumber(usage.estimatedCostUsd)) {
        total.estimatedCostUsd = (total.estimatedCostUsd ?? 0) + usage.estimatedCostUsd;
      }
      if (isFiniteNumber(usage.creditCost)) {
        total.creditCost = (total.creditCost ?? 0) + usage.creditCost;
      }
      if (isFiniteNumber(usage.acuCost)) total.acuCost = (total.acuCost ?? 0) + usage.acuCost;
    },
    snapshot: () => (total ? { ...total, models: [...models] } : undefined),
  };
}

/**
 * The changes-since-last-review pass runs only on a re-review with a real
 * delta: prior jbot reviews exist AND the latest reviewed head differs from the
 * current head. First review or unchanged head → skip (block omitted).
 */
export function shouldSummarizeChangesSinceLastReview(
  priorComments: string[],
  headSha?: string,
): boolean {
  const priorJbotReviews = priorComments.filter(isJbotReviewBody);
  if (priorJbotReviews.length === 0) return false;
  const latestReviewedHead = findLatestReviewedHead(priorJbotReviews);
  return Boolean(latestReviewedHead && headSha && latestReviewedHead !== headSha);
}

/**
 * Summary-field instructions ONLY. This block must never narrow review
 * scope: an earlier wording ("summarize only what changed since the latest
 * reviewed head... use git log/diff for prior..head") leaked into review
 * behavior on small models, which then reviewed only the delta and missed
 * cross-commit bugs — the single biggest recall gap versus competitor bots.
 */
export function buildSummaryScopeBlock(): string {
  return [
    '## Summary instructions',
    '- These instructions affect ONLY the text of the "summary" field. They never change what you review: findings always come from the complete PR diff.',
    '- Prefer concise Markdown bullet points in the "summary" field when they make the review easier to scan.',
    '- Summarize your review conclusions for the changes you examined. Do not restate the overall PR; a separate "Changes since last review" note covers what changed.',
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
): Promise<PriorJbotThreads & { lookupSucceeded: boolean }> {
  try {
    return {
      ...(await listPriorJbotThreads(octokit, owner, repo, pullNumber)),
      lookupSucceeded: true,
    };
  } catch (error) {
    log(
      `Prior jbot-review thread lookup skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      threads: [],
      reviewGroups: [],
      unresolvedAddressedThreadIds: [],
      outcomes: [],
      lookupSucceeded: false,
    };
  }
}

/** Intent context is a recall supplement — its lookup must never fail the run. */
async function safeListClosingIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  log: (msg: string) => void,
): Promise<{ issues: LinkedIssue[]; omitted: number }> {
  try {
    const result = await listClosingIssues(octokit, owner, repo, pullNumber);
    if (result.issues.length > 0) {
      log(
        `Linked issues for intent context: ${result.issues
          .map((issue) => `#${issue.number}`)
          .join(', ')}${result.omitted > 0 ? ` (+${result.omitted} not embedded)` : ''}.`,
      );
    }
    return result;
  } catch (error) {
    log(`Linked-issue lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
    return { issues: [], omitted: 0 };
  }
}

function startAddressedPriorCommentsCheck(params: {
  backend: ReviewBackend;
  model: string;
  prContext: string;
  priorJbotThreads: PriorJbotThread[];
  timeoutMs?: number;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
  onCoverage?: SessionCoverageRecorder;
}): Promise<AddressedPriorComment[]> {
  const session = 'addressed-prior-comments';
  if (params.priorJbotThreads.length === 0) {
    params.onCoverage?.({ session, state: 'skipped' });
    return Promise.resolve([]);
  }

  const startedAt = Date.now();
  params.log('Starting addressed-prior-comments check in parallel.');
  return params.backend
    .runAddressedPriorCommentsCheck(
      params.model,
      params.prContext,
      params.log,
      params.timeoutMs,
      params.onTokenUsage,
    )
    .then((independentlyAddressed) => {
      params.log(
        `Addressed-prior-comments check complete: ${independentlyAddressed.length} addressed prior comment(s)`,
      );
      params.onCoverage?.({ session, state: 'completed', durationMs: Date.now() - startedAt });
      return independentlyAddressed;
    })
    .catch((error) => {
      params.log(
        `(skipped addressed-prior-comments check: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      params.onCoverage?.({ session, state: 'failed', error, durationMs: Date.now() - startedAt });
      return [];
    });
}

const execFileAsync = promisify(execFile);
const GIT_LOG_TIMEOUT_MS = 15_000;

/** Commit subjects (`<short-sha> <subject>`) added between two revisions, in the checkout. */
async function collectCommitSubjects(
  workspace: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--no-merges', '--format=%h %s', `${fromSha}..${toSha}`],
    { cwd: workspace, timeout: GIT_LOG_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  return stdout.split('\n').filter(Boolean);
}

/**
 * Summarizes the reviewed..head delta once for the whole PR (non-finder pass).
 * Fail-open: any failure (git, backend, parse) resolves to '' so the block is
 * simply omitted. Enabled only on a re-review with a real delta.
 */
function startChangesSinceLastReviewSummary(params: {
  backend: ReviewBackend;
  model: string;
  prContext: string;
  workspace: string;
  reviewedHead?: string;
  headSha?: string;
  enabled: boolean;
  timeoutMs?: number;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
  onCoverage?: SessionCoverageRecorder;
}): Promise<string> {
  const session = 'changes-since-last-review';
  if (!params.enabled || !params.reviewedHead || !params.headSha) {
    params.onCoverage?.({ session, state: 'skipped' });
    return Promise.resolve('');
  }
  const reviewedHead = params.reviewedHead;
  const headSha = params.headSha;
  const startedAt = Date.now();
  let modelRan = false;
  params.log('Starting changes-since-last-review summary in parallel.');
  return (async () => {
    const subjects = await collectCommitSubjects(params.workspace, reviewedHead, headSha);
    if (subjects.length === 0) {
      params.log('changes-since-last-review skipped: no commits since last reviewed head.');
      return '';
    }
    const deltaContext = buildChangesSinceContextBlock(reviewedHead, headSha, subjects);
    modelRan = true;
    return params.backend.runChangesSinceLastReview(
      params.model,
      params.prContext,
      deltaContext,
      params.log,
      params.timeoutMs,
      params.onTokenUsage,
    );
  })()
    .then((text) => {
      params.log(`changes-since-last-review summary complete: ${text.length} chars`);
      params.onCoverage?.(
        modelRan
          ? { session, state: 'completed', durationMs: Date.now() - startedAt }
          : { session, state: 'skipped' },
      );
      return text;
    })
    .catch((error) => {
      params.log(
        `(skipped changes-since-last-review summary: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      // A git failure before any model session is a skip, not a failed model
      // session — that distinction is what modelRan exists for.
      params.onCoverage?.(
        modelRan
          ? { session, state: 'failed', error, durationMs: Date.now() - startedAt }
          : { session, state: 'skipped' },
      );
      return '';
    });
}

function startGuidelineComplianceCheck(params: {
  backend: ReviewBackend;
  model: string;
  prContext: string;
  guidelinesForPrompt: string;
  hasGuidelines: boolean;
  enabled: boolean;
  timeoutMs?: number;
  log: (msg: string) => void;
  onTokenUsage?: TokenUsageRecorder;
  onCoverage?: SessionCoverageRecorder;
}): Promise<Finding[]> {
  const session = 'guideline-compliance';
  if (!params.enabled) {
    params.onCoverage?.({ session, state: 'skipped' });
    return Promise.resolve([]);
  }
  if (!params.hasGuidelines) {
    params.log('Guideline-compliance check skipped: no repository guidelines discovered.');
    params.onCoverage?.({ session, state: 'skipped' });
    return Promise.resolve([]);
  }

  const startedAt = Date.now();
  params.log('Starting guideline-compliance check in parallel.');
  return params.backend
    .runGuidelineComplianceCheck(
      params.model,
      params.prContext,
      params.guidelinesForPrompt,
      params.log,
      params.timeoutMs,
      params.onTokenUsage,
    )
    .then((findings) => {
      params.log(`Guideline-compliance check complete: ${findings.length} finding(s)`);
      params.onCoverage?.({ session, state: 'completed', durationMs: Date.now() - startedAt });
      return findings;
    })
    .catch((error) => {
      params.log(
        `(skipped guideline-compliance check: ${
          error instanceof Error ? error.message : String(error)
        })`,
      );
      params.onCoverage?.({ session, state: 'failed', error, durationMs: Date.now() - startedAt });
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
}): Promise<string[]> {
  // Returns the thread ids actually resolved this run — only a successful
  // resolve counts, so the reaction gate never trusts a reply/resolve that
  // failed to post. An already-resolved thread is handled by the gate's
  // isResolved check, so it is not included here.
  const resolved: string[] = [];
  if (params.addressedPriorComments.length === 0 || params.priorJbotThreads.length === 0) {
    return resolved;
  }

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
      });
      params.log(`Posted addressed reply for prior thread ${thread.id}`);
    } catch (error) {
      // The reply is a courtesy; a failure must not block the resolve — always
      // try to close an addressed thread.
      params.log(
        `Failed to reply to addressed prior thread ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (thread.isResolved) continue;
    if (await resolveThreadBestEffort(params, thread.id)) resolved.push(thread.id);
  }
  return resolved;
}

/**
 * Resolves threads jbot already replied to as addressed but that never closed
 * (e.g. a prior run's resolve failed). Reply-free — the addressed marker is
 * already on the thread — so it just retries the resolve. Best-effort; returns
 * the ids actually resolved this run.
 */
async function resolveUnresolvedAddressedThreads(params: {
  octokit: Octokit;
  threadResolutionOctokit?: Octokit;
  threadIds: string[];
  log: (msg: string) => void;
}): Promise<string[]> {
  const resolved: string[] = [];
  for (const threadId of params.threadIds) {
    if (await resolveThreadBestEffort(params, threadId)) resolved.push(threadId);
  }
  return resolved;
}

async function finalizeResolvedReviews(params: {
  octokit: Octokit;
  threadResolutionOctokit?: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  reviews: readonly JbotReviewGroup[];
  resolvedThisRun: readonly string[];
  log: (msg: string) => void;
}): Promise<void> {
  const reviews = selectResolvedJbotReviewsToFinalize(params.reviews, params.resolvedThisRun);
  for (const review of reviews) {
    const body = compactJbotReviewBody(review.body, review.threads.length);
    if (body !== review.body) {
      try {
        await updateReviewBody(
          params.octokit,
          params.owner,
          params.repo,
          params.pullNumber,
          review.id,
          body,
        );
        params.log(`Compacted resolved jbot-review ${review.id}.`);
      } catch (error) {
        params.log(
          `Failed to compact resolved jbot-review ${review.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (review.isMinimized) continue;
    try {
      await minimizePullRequestReview(
        params.threadResolutionOctokit ?? params.octokit,
        review.nodeId,
      );
      params.log(`Minimized resolved jbot-review ${review.id}.`);
    } catch (error) {
      params.log(
        `Failed to minimize resolved jbot-review ${review.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Shared resolve with the permission hint. Returns whether it resolved. */
async function resolveThreadBestEffort(
  params: { octokit: Octokit; threadResolutionOctokit?: Octokit; log: (msg: string) => void },
  threadId: string,
): Promise<boolean> {
  try {
    await resolveReviewThread(params.threadResolutionOctokit ?? params.octokit, threadId);
    params.log(`Resolved prior jbot-review thread ${threadId}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint =
      !params.threadResolutionOctokit && isResourceNotAccessibleByIntegration(message)
        ? ' Set the thread-resolution-token input to a token that can resolve review threads.'
        : '';
    params.log(`Failed to resolve prior jbot-review thread ${threadId}: ${message}${hint}`);
    return false;
  }
}

function isResourceNotAccessibleByIntegration(message: string): boolean {
  return message.toLowerCase().includes('resource not accessible by integration');
}

export function buildBody(
  changesSinceLastReview: string,
  summary: string,
  all: Finding[],
  orphaned: Finding[],
  model: string,
  owner: string,
  repo: string,
  headSha?: string,
  tokenUsage?: ReviewTokenUsage,
  engineByModel?: Record<string, string>,
): string {
  const total = all.length;
  const lines = ['## J-Bot Code Review', ''];
  if (changesSinceLastReview.trim()) {
    lines.push('**Changes since last review**', '', changesSinceLastReview.trim(), '');
  }
  // A clean review's per-shard verification narrative is low-value restatement:
  // the verdict lines and "No new findings" below already convey "clean", and on
  // multi-shard runs that narrative overlaps across shards (the dogfood verbosity
  // we are cutting). Render the grouped summary only when findings exist AND the
  // summary survives all-clear suppression — a single trivial finding must not
  // unlock a wall of "looks correct" prose, and an empty/fully-suppressed summary
  // renders nothing rather than a filler placeholder. The "Changes since last
  // review" block above is independent and still renders on re-reviews.
  const renderedSummary = summary.trim()
    ? formatSummaryMarkdown(summary, { suppressNoFindingVerdicts: true })
    : '';
  if (total > 0 && renderedSummary.trim()) {
    lines.push(renderedSummary, '');
  }
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
  lines.push(...renderReviewMetadataBlock(model, tokenUsage));
  lines.push('', `<sup>${formatReviewedWith(model, tokenUsage, engineByModel)}</sup>`);
  return lines.join('\n');
}

export function renderReviewMetadataBlock(model: string, tokenUsage?: ReviewTokenUsage): string[] {
  if (!tokenUsage) return [];
  const models = uniqueModels(model, tokenUsage.models);
  return [
    '',
    '<details>',
    '<summary>Review metadata</summary>',
    '',
    '```text',
    models.length === 1 ? `model=${models[0]}` : `models=${models.join(', ')}`,
    `input=${tokenUsage.input}`,
    `output=${tokenUsage.output}`,
    `reasoning=${tokenUsage.reasoning}`,
    `cache read=${tokenUsage.cacheRead}`,
    `cache write=${tokenUsage.cacheWrite}`,
    ...(isFiniteNumber(tokenUsage.costUsd) ? [`cost usd=${tokenUsage.costUsd.toFixed(4)}`] : []),
    ...(isFiniteNumber(tokenUsage.estimatedCostUsd)
      ? [`estimated cost usd=${tokenUsage.estimatedCostUsd.toFixed(4)}`]
      : []),
    ...(isFiniteNumber(tokenUsage.creditCost)
      ? [`credit cost=${formatUsageCost(tokenUsage.creditCost)}`]
      : []),
    ...(isFiniteNumber(tokenUsage.acuCost)
      ? [`acu cost=${formatUsageCost(tokenUsage.acuCost)}`]
      : []),
    '```',
    '',
    '</details>',
  ];
}

export function formatReviewedWith(
  model: string,
  tokenUsage?: ReviewTokenUsage,
  // Model → SDK engine / CLI ('pi', 'opencode', 'kilo', …). The model prefix no
  // longer implies the engine (opencode/… can run on pi), so name it explicitly.
  engineByModel?: Record<string, string>,
): string {
  const withEngine = (usageModel: string): string => {
    const engine = engineByModel?.[usageModel];
    return engine ? `\`${usageModel}\` via ${engine}` : `\`${usageModel}\``;
  };
  const auxiliaryModels = uniqueModels(model, tokenUsage?.models ?? []).filter(
    (usageModel) => usageModel !== model,
  );
  if (auxiliaryModels.length === 0) return `Reviewed with ${withEngine(model)}.`;
  return `Reviewed with ${withEngine(model)}; auxiliary sessions used ${auxiliaryModels
    .map(withEngine)
    .join(', ')}.`;
}

function uniqueModels(primary: string, others: string[]): string[] {
  return [...new Set([primary, ...others])];
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
