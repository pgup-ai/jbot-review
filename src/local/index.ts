import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { parseEnvInt, parseEnvJsonObject } from '../app/app.ts';
import { gatewayRoutedModels, localRunId, remoteAcpConfigFromEnv } from '../shared/acp-remote.ts';
import {
  backendRequiresCompleteEmbeddedDiff,
  selectReviewBackends,
  swallowedProviderWarnings,
  type CliBackendID,
} from '../shared/backend-selection.ts';
import { CLINE_CLI_BIN, CLINE_PROVIDER_ID } from '../shared/cline.ts';
import { CODEX_ACP_BIN, CODEX_PROVIDER_ID } from '@symma/protocol';
import { COMMANDCODE_CLI_BIN, COMMANDCODE_PROVIDER_ID } from '../shared/commandcode.ts';
import {
  defaultModelOptions,
  parseEnvBoolean,
  parseEnvGuidelineWiden,
  resolvePoolCredentials,
  supportedModelOptions,
} from '../shared/config.ts';
import {
  CURSOR_CLI_BIN,
  CURSOR_PROVIDER_ID,
  DEVIN_CLI_BIN,
  DEVIN_PROVIDER_ID,
} from '@symma/protocol';
import { exitOnLingeringHandles } from '../shared/exit.ts';
import { isNoiseFile } from '../shared/filter.ts';
import { observerEnabled, setRunName } from '../shared/observer.ts';
import { withCredentialEnvWithheld } from '../shared/opencode.ts';
import { GROK_CLI_BIN, GROK_PROVIDER_ID } from '../shared/grok.ts';
import { DIM_CLI_BIN, DIM_PROVIDER_ID } from '../shared/dim.ts';
import { KILO_CLI_BIN, KILO_PROVIDER_ID, parseModelName } from '@symma/protocol';
import {
  pickReviewModels,
  removedAuxInputWarnings,
  resolveModelSelection,
} from '../shared/model.ts';
import { piModelAvailable, resolvePiEngine } from '../shared/pi.ts';
import { QODER_PROVIDER_ID } from '../shared/qoder.ts';
import {
  discoverGuidelineDocs,
  formatFinderGuidelines,
  formatGuidelines,
  type ReviewCommit,
} from '../shared/review-context.ts';
import { EMBEDDED_ONLY_BACKEND_DIFF_HUNKS_OPTIONS, runPrReview } from '../shared/runner.ts';
import { onFatalSignal } from '@symma/protocol';
import type { ReviewResult } from '../shared/types.ts';
import { ensureGitSafeDirectory, GIT_DIFF_ARGS, parseGitDiff } from '../shared/git.ts';
import {
  buildDiffHunksBlockWithMetadata,
  classifyChangeShape,
  isDocOnlyChange,
  shardFilesForReview,
} from '../shared/diff-context.ts';
import { planReviewFanout } from '../shared/fanout.ts';
import { selectLensKeys } from '../shared/prompt.ts';
import {
  benchmarkReviewOutput,
  loadDotEnv,
  parseOwnerRepo,
  renderReport,
  renderReviewPreview,
} from './util.ts';
import {
  assertArenaPathIsolation,
  parseLocalArgs,
  resolveLocalPaths,
  type LocalArgs,
  type LocalPaths,
} from './args.ts';
import {
  aggregateArenaUsage,
  classifyJbotArenaFailure,
  emptyArenaUsage,
  parseArenaAuthJson,
  sanitizeArenaFailureMessage,
  selectArenaModel,
  parseComparisonManifestJson,
  writeJbotArenaOutput,
  type ComparisonManifestV1,
  type JbotArenaOutputV1,
} from './arena-contract.ts';

/**
 * Local review driver (`npm run review:local`): runs the real review pipeline
 * against merge-base→worktree changes with zero GitHub dependency — no token,
 * no PR, no API call, no fetch. See shared/git.ts for the diff-side semantics
 * (invariant #7). Routing to the ACP gateway moves the right side to HEAD, so
 * the driver and the companion's clone describe the same commit.
 */

const execFileAsync = promisify(execFile);
const REPORT_DIR = '.jbot-review';

interface LocalInvocation {
  args: LocalArgs;
  paths: LocalPaths;
  comparison?: ComparisonManifestV1;
}

interface ArenaRunState {
  outputPath: string;
  artifactRoot: string;
  backend: string | null;
  sdkEngine: string | null;
  resolvedModelOptions: Record<string, unknown> | null;
  reviewStartedAt?: number;
  secretValues: string[];
  written: boolean;
}

let arenaRunState: ArenaRunState | undefined;

const log = (msg: string) => console.log(`[jbot-review] ${msg}`);

function arenaTelemetry(state: ArenaRunState): string | undefined {
  try {
    return readFileSync(join(state.artifactRoot, 'telemetry.jsonl'), 'utf8');
  } catch {
    return undefined;
  }
}

function writeArenaTerminal(output: JbotArenaOutputV1): void {
  if (!arenaRunState) return;
  writeJbotArenaOutput(arenaRunState.outputPath, output);
  arenaRunState.written = true;
}

function writeArenaSkipped(resolved = false): void {
  const state = arenaRunState;
  writeArenaTerminal({
    schemaVersion: 1,
    status: 'skipped',
    backend: resolved ? (state?.backend ?? null) : null,
    sdkEngine: resolved ? (state?.sdkEngine ?? null) : null,
    resolvedModelOptions: resolved ? (state?.resolvedModelOptions ?? null) : null,
    reviewMs: null,
    usage: resolved && state ? aggregateArenaUsage(arenaTelemetry(state)) : emptyArenaUsage(),
    review: null,
    failure: null,
  });
}

function writeArenaFailure(error: unknown): void {
  const state = arenaRunState;
  if (!state || state.written) return;
  const reviewMs =
    state.reviewStartedAt === undefined ? null : performance.now() - state.reviewStartedAt;
  writeArenaTerminal({
    schemaVersion: 1,
    status: 'failed',
    backend: state.backend,
    sdkEngine: state.sdkEngine,
    resolvedModelOptions: state.resolvedModelOptions,
    reviewMs,
    usage: aggregateArenaUsage(arenaTelemetry(state)),
    review: null,
    failure: {
      class: classifyJbotArenaFailure(error),
      message: sanitizeArenaFailureMessage(error, state.secretValues),
    },
  });
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    ...(cwd ? { cwd } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gitOrEmpty(args: string[], cwd?: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

async function resolveWorkspace(workspace: string): Promise<string> {
  const root = (await gitOrEmpty(['rev-parse', '--show-toplevel'], workspace)).trim();
  if (!root) throw new Error(`Workspace "${workspace}" is not an existing Git worktree.`);
  return root;
}

/** No `git fetch` anywhere — a stale base ref widens the diff; fetching is the user's call. */
async function resolveBase(
  configuredBase?: string,
): Promise<{ baseRef: string; mergeBase: string }> {
  let baseRef = configuredBase || '';
  if (!baseRef) {
    // origin/HEAD tracks the remote default branch when the clone set it up.
    const symbolic = (await gitOrEmpty(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']))
      .trim()
      .replace(/^refs\/remotes\//, '');
    baseRef = symbolic || 'origin/main';
  }
  try {
    await git(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  } catch {
    throw new Error(
      `Base ref "${baseRef}" not found locally. Fetch it first (e.g. \`git fetch origin main\`) ` +
        'or point JBOT_LOCAL_BASE at a local ref/SHA — this command never fetches on its own.',
    );
  }
  let mergeBase: string;
  try {
    mergeBase = (await git(['merge-base', baseRef, 'HEAD'])).trim();
  } catch {
    throw new Error(`No common ancestor between "${baseRef}" and HEAD.`);
  }
  return { baseRef, mergeBase };
}

async function localCommits(mergeBase: string): Promise<ReviewCommit[]> {
  // --reverse: oldest-first, matching GitHub's listPrCommits ordering.
  const out = await gitOrEmpty([
    'log',
    '--reverse',
    '--format=%H%x09%s%x09%an',
    `${mergeBase}..HEAD`,
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // First/last tab, not split: a subject containing a tab must stay whole.
      const shaEnd = line.indexOf('\t');
      const authorStart = line.lastIndexOf('\t');
      const sha = line.slice(0, shaEnd);
      const message = line.slice(shaEnd + 1, authorStart);
      const author = line.slice(authorStart + 1);
      return { sha, message, ...(author ? { author } : {}) };
    });
}

interface IsolatedCheckout {
  path: string;
  head: string;
  /** Synchronous so a signal handler can finish it before the process dies. */
  remove: () => void;
}

/**
 * A gateway review runs against the companion's clone of a committed ref, so
 * the driver has to read the same bytes — diffing the dirty worktree hands the
 * agent a diff its own checkout contradicts. A linked worktree is the cheap way
 * to get HEAD on disk without disturbing that tree.
 */
async function checkoutHead(): Promise<IsolatedCheckout> {
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const path = await mkdtemp(join(tmpdir(), 'jbot-review-'));
  const discard = (): void => {
    // Never throw: in a finally this would mask the review's own error.
    try {
      spawnSync('git', ['worktree', 'remove', '--force', path], { stdio: 'ignore' });
      // git leaves the directory if that failed, and a signal can land while
      // `worktree add` is still populating it — retry past its writes.
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      log(`Could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Guarded from the moment the directory exists rather than once the caller
  // holds it: `git worktree add` awaits, and a signal in that gap strands it.
  const unregister = onFatalSignal(discard);
  try {
    await git(['worktree', 'add', '--detach', '--quiet', path, head]);
  } catch (error) {
    unregister();
    discard();
    throw error;
  }
  return {
    path,
    head,
    remove: () => {
      unregister();
      discard();
    },
  };
}

/**
 * Ephemeral free port for the opencode server unless JBOT_OPENCODE_PORT pins
 * one — a developer's own opencode session often occupies the default 4096,
 * which CI never has to worry about.
 */
async function pickOpencodePort(forceEphemeral = false): Promise<number | undefined> {
  if (!forceEphemeral && process.env.JBOT_OPENCODE_PORT?.trim()) return undefined;
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(undefined)); // fall back to the default port
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Whether `bin` is present and runnable. A failure to *spawn* — ENOENT (not on
 * PATH), EACCES (not executable), ENOEXEC (wrong architecture), etc. — surfaces
 * as a string errno in `error.code` and means the binary can't run, so the
 * preflight fails clearly. A binary that *did* run but exited non-zero on
 * `--version` reports a numeric exit code; that's treated as usable, since some
 * CLIs exit non-zero on `--version` and false-blocking a working install is
 * worse than a later, self-explanatory invocation error.
 */
async function binaryUsable(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 10_000 });
    return true;
  } catch (error) {
    // execFile sets a string `code` (errno) only when the process never
    // spawned; a numeric code means it ran and exited non-zero.
    return typeof (error as { code?: unknown }).code !== 'string';
  }
}

const CLI_BINS: Record<CliBackendID, string | null> = {
  [DEVIN_PROVIDER_ID]: DEVIN_CLI_BIN,
  [COMMANDCODE_PROVIDER_ID]: COMMANDCODE_CLI_BIN,
  [CURSOR_PROVIDER_ID]: CURSOR_CLI_BIN,
  // codex reviews spawn the ACP adapter, not the codex CLI itself.
  [CODEX_PROVIDER_ID]: CODEX_ACP_BIN,
  [CLINE_PROVIDER_ID]: CLINE_CLI_BIN,
  [GROK_PROVIDER_ID]: GROK_CLI_BIN,
  [KILO_PROVIDER_ID]: KILO_CLI_BIN,
  // The Agent SDK resolves its bundled, overridden, or global runtime itself.
  [QODER_PROVIDER_ID]: null,
  [DIM_PROVIDER_ID]: DIM_CLI_BIN,
};

// Install hints mirror the Dockerfile's installer lines — the source of truth
// for each backend's real package/installer.
const INSTALL_HINTS: Record<string, string> = {
  opencode: 'npm i -g opencode-ai',
  [COMMANDCODE_CLI_BIN]: 'npm i -g command-code',
  [CODEX_ACP_BIN]: 'npm i -g @agentclientprotocol/codex-acp',
  [CLINE_CLI_BIN]: 'npm i -g cline',
  [GROK_CLI_BIN]: 'npm i -g @xai-official/grok',
  [KILO_CLI_BIN]: 'npm i -g @kilocode/cli',
  [DIM_CLI_BIN]: 'npm i -g dimcode',
  [CURSOR_CLI_BIN]: 'curl -fsSL https://cursor.com/install | sh',
  [DEVIN_CLI_BIN]: 'curl -fsSL https://static.devin.ai/cli/3000.4.25/setup.sh | sh',
};

async function main(invocation: LocalInvocation): Promise<void> {
  // Adopted from review() once it knows whether the run routes to the gateway;
  // checkoutHead covers the signal path itself from the moment it has a
  // directory, so this only has to handle the ordinary return and throw.
  let isolated: IsolatedCheckout | undefined;
  try {
    await review(invocation, (checkout) => {
      isolated = checkout;
    });
  } finally {
    isolated?.remove();
  }
}

async function review(
  invocation: LocalInvocation,
  adopt: (checkout: IsolatedCheckout) => void,
): Promise<void> {
  const { args, paths } = invocation;
  const comparison = invocation.comparison;
  const { benchmarkOutput } = paths;
  if (benchmarkOutput && process.env.JBOT_BENCHMARK_DRY_RUN !== 'true') {
    throw new Error('JBOT_BENCHMARK_OUTPUT requires JBOT_BENCHMARK_DRY_RUN=true.');
  }

  // Name the run after the branch under review. CI gets a unique id from the
  // workflow run and attempt; locally there is none, and without one every
  // local review collapses into the gateway's `jbot` fallback together — one
  // entry accumulating unattributable sessions. The timestamp keeps each
  // attempt its own entry.
  const headBranch = (await gitOrEmpty(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'head';
  if (observerEnabled) setRunName(`local-${headBranch}`);
  if (!process.env.JBOT_ACP_GATEWAY_RUN?.trim()) {
    process.env.JBOT_ACP_GATEWAY_RUN = localRunId(headBranch, new Date());
  }

  // Provider/model resolution mirrors src/app/server.ts. Credentials stay below
  // the diff so a clean tree still exits "nothing to review" without a key set;
  // the model names have to come first because they decide whether this run
  // routes to the gateway, which is what the diff's right side depends on.
  if (comparison && !process.env.MODEL?.trim()) {
    throw new Error('Arena review requires one explicit fully qualified MODEL.');
  }
  if (comparison && process.env.PROVIDER?.trim()) {
    throw new Error('Arena review does not accept the legacy PROVIDER pin.');
  }
  if (
    comparison &&
    [
      process.env.JBOT_ACP_GATEWAY_URL,
      process.env.JBOT_ACP_GATEWAY_REPO,
      process.env.JBOT_ACP_GATEWAY_REF,
    ].some((value) => value?.trim())
  ) {
    throw new Error('Arena review does not accept ACP gateway routing.');
  }
  const pool = resolveModelSelection(
    process.env.MODEL,
    comparison ? undefined : process.env.PROVIDER,
  );
  if (comparison) selectArenaModel(comparison, pool);
  // HEAD, not the worktree: iterating on uncommitted edits keeps the same
  // reviewer, so a before/after comparison is not confounded by the pick.
  const headSha = (await git(['rev-parse', 'HEAD'])).trim();
  if (comparison && headSha !== comparison.target.head.sha) {
    throw new Error(
      `Arena checkout HEAD ${headSha} does not match frozen head ${comparison.target.head.sha}.`,
    );
  }
  if (comparison && (await gitOrEmpty(['status', '--porcelain'])).trim()) {
    throw new Error('Arena checkout must be clean before review.');
  }
  const { model, auxModel } = pickReviewModels(pool, headSha);
  const provider = parseModelName(model).providerID;
  const auxProviderID = parseModelName(auxModel).providerID;
  for (const warning of swallowedProviderWarnings(pool)) log(warning);
  for (const warning of removedAuxInputWarnings((_, env) => process.env[env] ?? '')) log(warning);

  // Preview never spawns checkouts or sessions: it inspects the worktree diff
  // exactly as the non-gateway path would review it.
  const preview = args.preview;

  // The companion checks out repo@ref, and both are optional. With neither it
  // works in an empty workspace, so the worktree diff stands — there is nothing
  // to align with. With both, the diff has to describe that same commit.
  const routed =
    !comparison && !preview && gatewayRoutedModels([model, auxModel])
      ? remoteAcpConfigFromEnv()
      : undefined;
  if (routed?.repo && !routed.ref) {
    throw new Error(
      'JBOT_ACP_GATEWAY_REPO is set without JBOT_ACP_GATEWAY_REF: the companion would review a ' +
        'default-branch checkout, which matches neither the working tree nor HEAD. Set the ref ' +
        'to the commit under review, or unset the repo to run against an empty workspace.',
    );
  }
  // Both, not either: a ref without a repo still leaves the companion empty.
  const isolated = routed?.repo && routed.ref ? await checkoutHead() : undefined;
  if (isolated) {
    // Pin the companion to the commit actually diffed, read back below by
    // remoteAcpConfigFromEnv: the configured ref may name another branch, or be
    // a branch that advances mid-run, and either way the agent would read a
    // different revision from the one this prompt describes.
    process.env.JBOT_ACP_GATEWAY_REF = isolated.head;
  }
  if (isolated) adopt(isolated);

  const { baseRef, mergeBase } = await resolveBase(
    comparison ? comparison.target.base.sha : (args.base ?? process.env.JBOT_LOCAL_BASE?.trim()),
  );
  const shortBase = mergeBase.slice(0, 12);
  // Deepen target for the companion: a shallow clone that stops short of the
  // base cannot run the merge-base diff this prompt describes.
  if (isolated) process.env.JBOT_ACP_GATEWAY_BASE = mergeBase;
  const rightSide = isolated
    ? `HEAD ${isolated.head.slice(0, 12)}`
    : comparison
      ? `frozen HEAD ${headSha.slice(0, 12)}`
      : 'the working tree';
  log(`Diff base: ${baseRef} (merge-base ${shortBase}); right side is ${rightSide}.`);
  log('Note: a stale base ref widens the diff — fetch before reviewing if in doubt.');

  // Disclosed before the empty-diff exit, or a bare "nothing to review" misleads.
  if (isolated) {
    const pending = (await gitOrEmpty(['status', '--porcelain']))
      .split('\n')
      .filter(Boolean).length;
    log(
      `ACP gateway configured: reviewing committed HEAD from an isolated checkout so the diff ` +
        `matches the companion's clone${pending ? `; ${pending} uncommitted change(s) excluded` : ''}.`,
    );
  } else {
    const untracked = (await gitOrEmpty(['ls-files', '--others', '--exclude-standard']))
      .split('\n')
      .filter(Boolean);
    if (untracked.length > 0) {
      const shown = untracked.slice(0, 10).join(', ');
      const more = untracked.length > 10 ? ` … and ${untracked.length - 10} more` : '';
      log(
        `${untracked.length} untracked file(s) not reviewed (\`git add -N\` includes them): ${shown}${more}`,
      );
    }
  }

  // Left side merge-base; see GIT_DIFF_ARGS for the gitconfig pins that keep
  // the output parseable.
  const diffText = await git([
    ...GIT_DIFF_ARGS,
    mergeBase,
    ...(isolated ? [isolated.head] : comparison ? [headSha] : []),
  ]);
  const files = parseGitDiff(diffText);
  // Exit before requiring credentials when nothing the runner would review is
  // present: parseGitDiff yields patchless entries for binary/mode-only/pure-
  // rename sections that the runner drops (same `patch && !isNoiseFile` gate),
  // so keying off files.length alone would demand a key and boot the server
  // only to bail with "no reviewable files".
  const reviewable = files.filter((f) => f.patch && !isNoiseFile(f.filename));
  if (reviewable.length === 0) {
    const detail = files.length > 0 ? ' (only binary/mode-only/noise changes)' : '';
    log(`Nothing to review vs ${baseRef} (merge-base ${shortBase})${detail}.`);
    if (comparison) writeArenaSkipped();
    return;
  }

  if (comparison?.reviewConfig.skipDocOnly && isDocOnlyChange(reviewable.map((f) => f.filename))) {
    log(`Doc-only PR (${reviewable.length} file(s)); skipping the full review.`);
    writeArenaSkipped();
    return;
  }

  // Before credential resolution on purpose: a preview must cost nothing and
  // need no key.
  if (preview) {
    const changedFilenames = reviewable.map((f) => f.filename);
    const requestedPasses = parseEnvInt('JBOT_REVIEW_PASSES', 1);
    const shape = classifyChangeShape(reviewable);
    // true mirrors normalizeOptions: entries that leave guidelinePass unset
    // (this one included) run the compliance pass by default.
    const fanout = parseEnvBoolean('JBOT_DYNAMIC_FANOUT', true)
      ? planReviewFanout({
          requestedPasses,
          requestedGuidelinePass: true,
          files: reviewable,
          shape,
        })
      : null;
    const lensKeys = selectLensKeys(
      fanout?.reviewPasses ?? requestedPasses,
      changedFilenames,
      shape,
    );
    const shards = shardFilesForReview(reviewable, {
      requestedShards: parseEnvInt('JBOT_REVIEW_SHARDS', 0),
    });
    // Mirror the runner for complete-diff backends: their sessions embed
    // under the 512KiB hard budget, and an AUX overflow disables the
    // compliance pass (widening finders to the full guideline set). Main and
    // aux providers can differ, so each is checked separately. Provider id
    // stands in for the CLI-backend id — for these backends they coincide.
    const mainRequiresCompleteDiff = backendRequiresCompleteEmbeddedDiff(
      provider,
      provider as CliBackendID,
    );
    const auxRequiresCompleteDiff = backendRequiresCompleteEmbeddedDiff(
      auxProviderID,
      auxProviderID as CliBackendID,
    );
    const diffHunksOptions = mainRequiresCompleteDiff
      ? EMBEDDED_ONLY_BACKEND_DIFF_HUNKS_OPTIONS
      : undefined;
    const auxDiffComplete =
      !auxRequiresCompleteDiff ||
      (() => {
        const aux = buildDiffHunksBlockWithMetadata(
          reviewable,
          EMBEDDED_ONLY_BACKEND_DIFF_HUNKS_OPTIONS,
        );
        return aux.truncatedFiles.length === 0 && aux.omittedFiles.length === 0;
      })();
    const guidelinePass = (fanout?.guidelinePass ?? true) && auxDiffComplete;
    const discovered = await discoverGuidelineDocs(process.cwd(), changedFilenames);
    console.log(
      `\n${renderReviewPreview({
        shards: shards.map((shard, index) => {
          const embedded = buildDiffHunksBlockWithMetadata(shard, diffHunksOptions);
          return {
            label: shards.length > 1 ? `review-shard-${index + 1}` : 'main-review',
            files: shard.map((f) => f.filename),
            diffBytes: shard.reduce((sum, f) => sum + Buffer.byteLength(f.patch ?? '', 'utf8'), 0),
            embeddedBytes: Buffer.byteLength(embedded.text, 'utf8'),
            truncated: embedded.truncatedFiles.length,
            omitted: embedded.omittedFiles.length,
          };
        }),
        lensKeys,
        guidelinePass,
        ...(fanout ? { fanoutTier: fanout.tier, fanoutReason: fanout.reason } : {}),
        guidelines: {
          docCount: discovered.docs.length,
          fullBytes: Buffer.byteLength(formatGuidelines(discovered), 'utf8'),
          finderBytes: Buffer.byteLength(
            formatFinderGuidelines(discovered, { forFiles: changedFilenames }),
            'utf8',
          ),
        },
      })}\n`,
    );
    return;
  }

  // The whole pool, not just the picked pair: a missing key must fail the next
  // run rather than only the runs that happen to draw that provider. Still
  // below the no-review exits, so a clean tree needs no key at all.
  const arenaAuth = comparison ? parseArenaAuthJson(process.env.JBOT_AUTH_JSON) : undefined;
  const credentials = resolvePoolCredentials(
    pool,
    ({ env }: { env: string }) => (arenaAuth ? arenaAuth[env] : process.env[env]),
    ' Local review needs only the provider configuration — no GitHub token; set it in the environment or in .env.',
  );
  const { apiKey, baseURL } = credentials.get(provider)!;
  const auxCredential = auxProviderID === provider ? undefined : credentials.get(auxProviderID);
  const auxApiKey = auxCredential?.apiKey;
  const auxBaseURL = auxCredential?.baseURL;
  if (arenaRunState) {
    arenaRunState.secretValues.push(
      ...[apiKey, baseURL, auxApiKey, auxBaseURL].filter(
        (value): value is string => typeof value === 'string' && Boolean(value),
      ),
    );
  }

  // Backend-aware preflight: opencode only when the selection needs it; CLI
  // backends bring their own binary.
  const { providerID, modelID } = parseModelName(model);
  const aux = parseModelName(auxModel || model);
  // Preflight-only resolution (the runner re-resolves for its own routing):
  // roles served by the in-process pi engine need no opencode binary.
  const piEngine = resolvePiEngine(
    comparison ? { JBOT_SDK_ENGINE: comparison.reviewConfig.sdkEngine } : process.env,
    process.version,
  );
  const [mainPiModelAvailable, auxPiModelAvailable] = piEngine.enabled
    ? await Promise.all([
        piModelAvailable(providerID, modelID),
        piModelAvailable(aux.providerID, aux.modelID),
      ])
    : [false, false];
  const selection = selectReviewBackends({
    providerID,
    modelID,
    apiKey,
    auxProviderID: aux.providerID,
    auxModelID: aux.modelID,
    auxApiKey: auxApiKey ?? '',
    piEnabled: piEngine.enabled,
    mainPiModelAvailable,
    auxPiModelAvailable,
  });
  const configuredModelOptions = comparison
    ? (comparison.reviewConfig.modelOptions ?? defaultModelOptions(provider))
    : parseEnvJsonObject('JBOT_MODEL_OPTIONS', defaultModelOptions(provider));
  const resolvedModelOptions =
    supportedModelOptions(providerID, modelID, configuredModelOptions) ?? {};
  if (arenaRunState) {
    arenaRunState.backend = selection.mainCliBackend ?? selection.mainSdkEngine ?? 'opencode';
    arenaRunState.sdkEngine = selection.mainCliBackend
      ? null
      : (selection.mainSdkEngine ?? 'opencode');
    arenaRunState.resolvedModelOptions = resolvedModelOptions;
  }
  const requiredBins = new Set<string>();
  if (selection.needsOpencode) requiredBins.add('opencode');
  const addCliBin = (backend: CliBackendID | undefined): void => {
    if (!backend) return;
    const bin = CLI_BINS[backend];
    if (bin) requiredBins.add(bin);
  };
  addCliBin(selection.mainCliBackend);
  addCliBin(selection.auxCliBackend);
  for (const bin of requiredBins) {
    if (!(await binaryUsable(bin))) {
      const hint = INSTALL_HINTS[bin] ? ` Install: \`${INSTALL_HINTS[bin]}\`.` : '';
      throw new Error(
        `Required CLI "${bin}" not found or not executable on PATH for provider "${provider}".${hint}`,
      );
    }
  }

  const branch = (await gitOrEmpty(['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  const subject = (await gitOrEmpty(['log', '-1', '--format=%s'])).trim();
  const body = (await gitOrEmpty(['log', '-1', '--format=%b'])).trim();
  const remoteUrl = await gitOrEmpty(['remote', 'get-url', 'origin']);
  const { owner, repo } = comparison
    ? { owner: comparison.target.owner, repo: comparison.target.repository }
    : (parseOwnerRepo(remoteUrl) ?? { owner: 'local', repo: 'local' });
  const commits = await localCommits(mergeBase);
  const workspace = isolated?.path ?? process.cwd();

  log(`Reviewing ${reviewable.length} changed file(s) on ${branch} with ${model}.`);

  const opencodePort = await pickOpencodePort(Boolean(comparison));
  let reviewResult: (ReviewResult & { telemetry?: string }) | undefined;
  const reviewStartedAt = performance.now();
  if (arenaRunState) arenaRunState.reviewStartedAt = reviewStartedAt;
  const config = comparison?.reviewConfig;
  const reviewParams: Parameters<typeof runPrReview>[0] = {
    // Arena headSha is provenance only; localDiff keeps this path GitHub-free.
    owner,
    repo,
    pullNumber: comparison?.target.prNumber ?? 0,
    pullTitle: (comparison?.target.title ?? subject) || `Local review of ${branch}`,
    pullBody: comparison?.target.body ?? body,
    workspace,
    telemetryDirectory: paths.artifactRoot,
    model,
    apiKey,
    baseURL,
    ...(comparison ? { headSha } : {}),
    baseRef,
    baseSha: mergeBase,
    localDiff: { files, commits },
    options: {
      enhancedContext: config?.enhancedContext ?? true,
      scrubSessionEnv: config?.scrubSessionEnv ?? true,
      sdkEngine: config?.sdkEngine ?? '',
      dryRun: config?.dryRun ?? true,
      autoApprove: config?.autoApprove ?? false,
      maxFindings: config?.maxFindings ?? 0,
      minSeverity: config?.minSeverity ?? 'nit',
      includePriorComments: config?.includePriorComments ?? true,
      context7Mode: config?.context7Mode ?? 'auto',
      guidelinePass: config?.guidelinePass ?? true,
      shardCachePath: '',
      reviewPasses: config?.reviewPasses ?? parseEnvInt('JBOT_REVIEW_PASSES', 1),
      verifyFindings:
        config?.verifyFindings ?? process.env.JBOT_VERIFY_FINDINGS?.trim() !== 'false',
      auxModel,
      ...(auxApiKey ? { auxApiKey } : {}),
      ...(auxBaseURL ? { auxBaseURL } : {}),
      timeBudgetMinutes: config?.timeBudgetMinutes ?? parseEnvInt('JBOT_TIME_BUDGET_MINUTES', 30),
      reviewShards: config?.reviewShards ?? parseEnvInt('JBOT_REVIEW_SHARDS', 0),
      dynamicFanout: config?.dynamicFanout ?? parseEnvBoolean('JBOT_DYNAMIC_FANOUT', true),
      modelOptions: comparison ? resolvedModelOptions : configuredModelOptions,
      modelOptionsExplicit: comparison
        ? comparison.reviewConfig.modelOptions !== null
        : Boolean(process.env.JBOT_MODEL_OPTIONS?.trim()),
      promptCache: config?.promptCache ?? parseEnvBoolean('JBOT_PROMPT_CACHE', true),
      skipDocOnly: config?.skipDocOnly ?? parseEnvBoolean('JBOT_SKIP_DOC_ONLY', true),
      maxConcurrentSessions:
        config?.maxConcurrentSessions ?? parseEnvInt('JBOT_MAX_CONCURRENT_SESSIONS', 3),
      reviewTelemetry: config?.reviewTelemetry ?? parseEnvBoolean('JBOT_REVIEW_TELEMETRY', true),
      evidenceQuotes: config?.evidenceQuotes ?? parseEnvBoolean('JBOT_EVIDENCE_QUOTES', true),
      contextTrim: config?.contextTrim ?? parseEnvBoolean('JBOT_CONTEXT_TRIM', false),
      embeddedFirstPrompt:
        config?.embeddedFirstPrompt ?? parseEnvBoolean('JBOT_EMBEDDED_FIRST_PROMPT', true),
      guidelineWiden: config?.guidelineWiden ?? parseEnvGuidelineWiden('JBOT_GUIDELINE_WIDEN'),
      verifierSlimContext:
        config?.verifierSlimContext ?? parseEnvBoolean('JBOT_VERIFIER_SLIM_CONTEXT', false),
      verifyOverlapGrace:
        config?.verifyOverlapGrace ?? parseEnvBoolean('JBOT_VERIFY_OVERLAP_GRACE', false),
      ...(opencodePort ? { opencodePort } : {}),
      onReviewResult: (result) => {
        reviewResult = result;
      },
    },
    log,
  };
  if (comparison) await withCredentialEnvWithheld(() => runPrReview(reviewParams));
  else await runPrReview(reviewParams);
  const reviewDurationMs = performance.now() - reviewStartedAt;

  if (!reviewResult) {
    // The runner returned before producing a result (doc-only skip or no
    // reviewable files) — the log above already says why.
    log('Review ended without findings output (skipped).');
    if (comparison) writeArenaSkipped(true);
    return;
  }

  const finalizedReview = benchmarkReviewOutput(
    reviewResult,
    join(paths.artifactRoot, 'telemetry.jsonl'),
  );
  if (benchmarkOutput) {
    writeFileSync(benchmarkOutput, `${JSON.stringify(finalizedReview)}\n`);
  }
  if (comparison) {
    writeArenaTerminal({
      schemaVersion: 1,
      status: 'completed',
      backend: arenaRunState?.backend ?? null,
      sdkEngine: arenaRunState?.sdkEngine ?? null,
      resolvedModelOptions: arenaRunState?.resolvedModelOptions ?? null,
      reviewMs: reviewDurationMs,
      usage: aggregateArenaUsage(finalizedReview.telemetry),
      review: {
        summary: finalizedReview.summary,
        findings: finalizedReview.findings.map(({ id: _id, ...finding }) => finding),
      },
      failure: null,
    });
  }

  const report = renderReport(reviewResult, {
    branch,
    baseRef,
    mergeBase,
    model,
    durationMs: reviewDurationMs,
  });
  console.log(`\n${report}`);
  if (parseEnvBoolean('JBOT_LOCAL_REPORT', false)) {
    mkdirSync(paths.artifactRoot, { recursive: true });
    const reportPath = join(paths.artifactRoot, 'last-run.md');
    writeFileSync(reportPath, `${report}\n`);
    log(`Report written to ${args.workspace ? reportPath : join(REPORT_DIR, 'last-run.md')}`);
  }
}

async function bootstrap(): Promise<void> {
  const launchDirectory = process.cwd();
  const args = parseLocalArgs(process.argv.slice(2));
  if (!args.prContext && loadDotEnv(join(launchDirectory, '.env'))) log('Loaded .env');
  const paths = resolveLocalPaths(args, launchDirectory, process.env.JBOT_BENCHMARK_OUTPUT);
  if (paths.prContext) await ensureGitSafeDirectory(paths.workspace, log);
  const workspace = await resolveWorkspace(paths.workspace);
  let comparison: ComparisonManifestV1 | undefined;
  if (paths.prContext && paths.arenaOutput) {
    assertArenaPathIsolation(workspace, paths.prContext, paths.arenaOutput);
    arenaRunState = {
      outputPath: paths.arenaOutput,
      artifactRoot: paths.artifactRoot,
      backend: null,
      sdkEngine: null,
      resolvedModelOptions: null,
      secretValues: [],
      written: false,
    };
    comparison = parseComparisonManifestJson(readFileSync(paths.prContext, 'utf8'));
  }
  process.chdir(workspace);
  if (args.workspace) log(`Workspace: ${workspace}`);
  await main({ args, paths: { ...paths, workspace }, ...(comparison ? { comparison } : {}) });
}

// Run verdict + observer flush live in runPrReview; here we only surface the
// error, set the exit code, and guarantee the process actually ends.
bootstrap()
  .catch((error: unknown) => {
    try {
      writeArenaFailure(error);
    } catch (outputError) {
      console.error(
        `[jbot-review] Could not write arena failure output: ${
          outputError instanceof Error ? outputError.message : String(outputError)
        }`,
      );
    }
    const message = arenaRunState
      ? sanitizeArenaFailureMessage(error, arenaRunState.secretValues)
      : error instanceof Error
        ? error.message
        : String(error);
    console.error(`[jbot-review] Local review failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(() => exitOnLingeringHandles(log));
