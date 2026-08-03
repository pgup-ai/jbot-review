import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parseEnvBoolean, parseEnvInt, parseEnvJsonObject } from '../app/app.ts';
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
import { defaultModelOptions, resolvePoolCredentials } from '../shared/config.ts';
import {
  CURSOR_CLI_BIN,
  CURSOR_PROVIDER_ID,
  DEVIN_CLI_BIN,
  DEVIN_PROVIDER_ID,
} from '@symma/protocol';
import { isNoiseFile } from '../shared/filter.ts';
import { observerEnabled, setRunName } from '../shared/observer.ts';
import { GROK_CLI_BIN, GROK_PROVIDER_ID } from '../shared/grok.ts';
import { KILO_CLI_BIN, KILO_PROVIDER_ID, parseModelName } from '@symma/protocol';
import {
  pickAuxModel,
  pickPooledModel,
  resolveAuxModel,
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
import { GIT_DIFF_ARGS, parseGitDiff } from '../shared/git.ts';
import {
  buildDiffHunksBlockWithMetadata,
  classifyChangeShape,
  shardFilesForReview,
} from '../shared/diff-context.ts';
import { planReviewFanout } from '../shared/fanout.ts';
import { selectLensKeys } from '../shared/prompt.ts';
import { loadDotEnv, parseOwnerRepo, renderReport, renderReviewPreview } from './util.ts';

/**
 * Local review driver (`npm run review:local`): runs the real review pipeline
 * against merge-base→worktree changes with zero GitHub dependency — no token,
 * no PR, no API call, no fetch. See shared/git.ts for the diff-side semantics
 * (invariant #7). Routing to the ACP gateway moves the right side to HEAD, so
 * the driver and the companion's clone describe the same commit.
 */

const execFileAsync = promisify(execFile);
const REPORT_DIR = '.jbot-review';

const log = (msg: string) => console.log(`[jbot-review] ${msg}`);

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function gitOrEmpty(args: string[]): Promise<string> {
  try {
    return await git(args);
  } catch {
    return '';
  }
}

/** No `git fetch` anywhere — a stale base ref widens the diff; fetching is the user's call. */
async function resolveBase(): Promise<{ baseRef: string; mergeBase: string }> {
  let baseRef = process.env.JBOT_LOCAL_BASE?.trim() || '';
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
async function pickOpencodePort(): Promise<number | undefined> {
  if (process.env.JBOT_OPENCODE_PORT?.trim()) return undefined; // opencode.ts reads the env itself
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
  [CURSOR_CLI_BIN]: 'curl -fsSL https://cursor.com/install | sh',
  [DEVIN_CLI_BIN]: 'curl -fsSL https://cli.devin.ai/install.sh | sh',
};

/** The runner writes telemetry under the workspace, which is the throwaway
 * checkout when gateway-routed — keep it in the repo before that goes away. */
function keepTelemetry(from: string): void {
  const source = join(from, REPORT_DIR, 'telemetry.jsonl');
  if (!existsSync(source)) return;
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    copyFileSync(source, join(REPORT_DIR, 'telemetry.jsonl'));
  } catch (error) {
    log(`Could not keep telemetry: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  // Adopted from review() once it knows whether the run routes to the gateway;
  // checkoutHead covers the signal path itself from the moment it has a
  // directory, so this only has to handle the ordinary return and throw.
  let isolated: IsolatedCheckout | undefined;
  try {
    await review((checkout) => {
      isolated = checkout;
    });
  } finally {
    if (isolated) keepTelemetry(isolated.path);
    isolated?.remove();
  }
}

async function review(adopt: (checkout: IsolatedCheckout) => void): Promise<void> {
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
  const pool = resolveModelSelection(process.env.MODEL, process.env.PROVIDER);
  // HEAD, not the worktree: iterating on uncommitted edits keeps the same
  // reviewer, so a before/after comparison is not confounded by the pick.
  const headSha = (await git(['rev-parse', 'HEAD'])).trim();
  const model = pickPooledModel(pool, headSha);
  const provider = parseModelName(model).providerID;
  // After the pick: a pool may span providers, so an aux id naming none
  // belongs to the model this run actually chose, not to the pool's first.
  const auxPool = resolveAuxModel(
    process.env.JBOT_REVIEW_AUX_MODEL,
    provider,
    process.env.JBOT_AUX_PROVIDER || process.env.PROVIDER,
  );
  const auxModel = pickAuxModel(auxPool, headSha);
  const auxProviderID = auxModel ? parseModelName(auxModel).providerID : provider;
  for (const warning of swallowedProviderWarnings([...pool, ...auxPool])) log(warning);

  // Preview never spawns checkouts or sessions: it inspects the worktree diff
  // exactly as the non-gateway path would review it.
  const preview = process.argv.includes('--preview');

  // The companion checks out repo@ref, and both are optional. With neither it
  // works in an empty workspace, so the worktree diff stands — there is nothing
  // to align with. With both, the diff has to describe that same commit.
  const gateway = remoteAcpConfigFromEnv();
  const routed =
    !preview && gateway && gatewayRoutedModels([model, auxModel]) ? gateway : undefined;
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

  const { baseRef, mergeBase } = await resolveBase();
  const shortBase = mergeBase.slice(0, 12);
  // Deepen target for the companion: a shallow clone that stops short of the
  // base cannot run the merge-base diff this prompt describes.
  if (isolated) process.env.JBOT_ACP_GATEWAY_BASE = mergeBase;
  const rightSide = isolated ? `HEAD ${isolated.head.slice(0, 12)}` : 'the working tree';
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
  const diffText = await git([...GIT_DIFF_ARGS, mergeBase, ...(isolated ? [isolated.head] : [])]);
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

  const credentials = resolvePoolCredentials(
    [model, ...(auxModel ? [auxModel] : [])],
    ({ env }: { env: string }) => process.env[env],
    ' Local review needs only the provider configuration — no GitHub token; set it in the environment or in .env.',
  );
  const { apiKey, baseURL } = credentials.get(provider)!;
  const auxCredential = auxProviderID === provider ? undefined : credentials.get(auxProviderID);
  const auxApiKey = auxCredential?.apiKey;
  const auxBaseURL = auxCredential?.baseURL;

  // Backend-aware preflight: opencode only when the selection needs it; CLI
  // backends bring their own binary.
  const { providerID, modelID } = parseModelName(model);
  const aux = parseModelName(auxModel || model);
  // Preflight-only resolution (the runner re-resolves for its own routing):
  // roles served by the in-process pi engine need no opencode binary.
  const piEngine = resolvePiEngine(process.env, process.version);
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
  const { owner, repo } = parseOwnerRepo(remoteUrl) ?? { owner: 'local', repo: 'local' };
  const commits = await localCommits(mergeBase);

  log(`Reviewing ${reviewable.length} changed file(s) on ${branch} with ${model}.`);

  const opencodePort = await pickOpencodePort();
  let reviewResult: ReviewResult | undefined;
  await runPrReview({
    // No octokit and no headSha: reads come from localDiff, and the runner's
    // built-in "check status unavailable" fallback covers CI checks.
    owner,
    repo,
    pullNumber: 0,
    pullTitle: subject || `Local review of ${branch}`,
    pullBody: body,
    workspace: isolated?.path ?? process.cwd(),
    model,
    apiKey,
    baseURL,
    baseRef,
    baseSha: mergeBase,
    localDiff: { files, commits },
    options: {
      enhancedContext: true,
      dryRun: true,
      reviewPasses: parseEnvInt('JBOT_REVIEW_PASSES', 1),
      verifyFindings: process.env.JBOT_VERIFY_FINDINGS?.trim() !== 'false',
      auxModel,
      ...(auxApiKey ? { auxApiKey } : {}),
      ...(auxBaseURL ? { auxBaseURL } : {}),
      timeBudgetMinutes: parseEnvInt('JBOT_TIME_BUDGET_MINUTES', 30),
      reviewShards: parseEnvInt('JBOT_REVIEW_SHARDS', 0),
      dynamicFanout: parseEnvBoolean('JBOT_DYNAMIC_FANOUT', true),
      modelOptions: parseEnvJsonObject('JBOT_MODEL_OPTIONS', defaultModelOptions(provider)),
      promptCache: parseEnvBoolean('JBOT_PROMPT_CACHE', true),
      skipDocOnly: parseEnvBoolean('JBOT_SKIP_DOC_ONLY', true),
      maxConcurrentSessions: parseEnvInt('JBOT_MAX_CONCURRENT_SESSIONS', 3),
      reviewTelemetry: parseEnvBoolean('JBOT_REVIEW_TELEMETRY', true),
      evidenceQuotes: parseEnvBoolean('JBOT_EVIDENCE_QUOTES', true),
      ...(opencodePort ? { opencodePort } : {}),
      onReviewResult: (result) => {
        reviewResult = result;
      },
    },
    log,
  });

  if (!reviewResult) {
    // The runner returned before producing a result (doc-only skip or no
    // reviewable files) — the log above already says why.
    log('Review ended without findings output (skipped).');
    return;
  }

  const report = renderReport(reviewResult, { branch, baseRef, mergeBase, model });
  console.log(`\n${report}`);
  if (parseEnvBoolean('JBOT_LOCAL_REPORT', false)) {
    mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = join(REPORT_DIR, 'last-run.md');
    writeFileSync(reportPath, `${report}\n`);
    log(`Report written to ${reportPath}`);
  }
}

if (loadDotEnv()) log('Loaded .env');
// Run verdict + observer flush live in runPrReview; here we only surface the
// error and set the exit code.
main().catch((error: unknown) => {
  console.error(
    `[jbot-review] Local review failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
