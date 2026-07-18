import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { parseEnvBoolean, parseEnvInt, parseEnvJsonObject } from '../app/app.ts';
import { selectReviewBackends, type CliBackendID } from '../shared/backend-selection.ts';
import { CLINE_CLI_BIN, CLINE_PROVIDER_ID } from '../shared/cline.ts';
import { CODEX_CLI_BIN, CODEX_PROVIDER_ID } from '../shared/codex.ts';
import { COMMANDCODE_CLI_BIN, COMMANDCODE_PROVIDER_ID } from '../shared/commandcode.ts';
import {
  PROVIDERS,
  defaultModelOptions,
  providerCredentialSources,
  resolveProviderBaseURL,
  resolveProviderCredential,
  resolveProviderModel,
} from '../shared/config.ts';
import { CURSOR_CLI_BIN, CURSOR_PROVIDER_ID } from '../shared/cursor.ts';
import { DEVIN_PROVIDER_ID } from '../shared/devin.ts';
import { isNoiseFile } from '../shared/filter.ts';
import { GROK_CLI_BIN, GROK_PROVIDER_ID } from '../shared/grok.ts';
import { KILO_CLI_BIN, KILO_PROVIDER_ID } from '../shared/kilo.ts';
import {
  formatModelName,
  parseModelName,
  resolveAuxModelName,
  resolveModelName,
} from '../shared/model.ts';
import { resolvePiEngine } from '../shared/pi.ts';
import { QODER_PROVIDER_ID } from '../shared/qoder.ts';
import type { ReviewCommit } from '../shared/review-context.ts';
import { runPrReview } from '../shared/runner.ts';
import type { ReviewResult } from '../shared/types.ts';
import { GIT_DIFF_ARGS, parseGitDiff } from '../shared/git.ts';
import { loadDotEnv, parseOwnerRepo, renderReport } from './util.ts';

/**
 * Local review driver (`npm run review:local`): runs the real review pipeline
 * against merge-base→worktree changes with zero GitHub dependency — no token,
 * no PR, no API call, no fetch. See shared/git.ts for the diff-side semantics
 * (invariant #7).
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

// devin.ts spawns the literal 'devin' (no exported BIN constant).
const CLI_BINS: Record<CliBackendID, string | null> = {
  [DEVIN_PROVIDER_ID]: 'devin',
  [COMMANDCODE_PROVIDER_ID]: COMMANDCODE_CLI_BIN,
  [CURSOR_PROVIDER_ID]: CURSOR_CLI_BIN,
  [CODEX_PROVIDER_ID]: CODEX_CLI_BIN,
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
  [CODEX_CLI_BIN]: 'npm i -g @openai/codex',
  [CLINE_CLI_BIN]: 'npm i -g cline',
  [GROK_CLI_BIN]: 'npm i -g @xai-official/grok',
  [KILO_CLI_BIN]: 'npm i -g @kilocode/cli',
  [CURSOR_CLI_BIN]: 'curl -fsSL https://cursor.com/install | sh',
  devin: 'curl -fsSL https://cli.devin.ai/install.sh | sh',
};

async function main(): Promise<void> {
  const { baseRef, mergeBase } = await resolveBase();
  const shortBase = mergeBase.slice(0, 12);
  log(`Diff base: ${baseRef} (merge-base ${shortBase}); right side is the working tree.`);
  log('Note: a stale base ref widens the diff — fetch before reviewing if in doubt.');

  // Disclosed before the empty-diff exit: when the only changes are brand-new
  // untracked files, a bare "nothing to review" would be misleading.
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

  // Left side merge-base, right side worktree; see GIT_DIFF_ARGS for the
  // gitconfig pins that keep the output parseable.
  const diffText = await git([...GIT_DIFF_ARGS, mergeBase]);
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

  // Provider/model/key resolution mirrors src/app/server.ts. Deliberately
  // after the diff: a clean tree exits "nothing to review" with no key set.
  const provider = process.env.PROVIDER || 'opencode';
  const providerCfg = PROVIDERS[provider];
  if (!providerCfg) {
    throw new Error(
      `Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
    );
  }
  const apiKey = resolveProviderCredential(providerCfg, ({ env }) => process.env[env]);
  if (!apiKey) {
    const envNames = providerCredentialSources(providerCfg)
      .map(({ env }) => env)
      .join(' or ');
    throw new Error(
      `Missing ${envNames} for provider "${provider}". Local review needs only the ` +
        'provider configuration — no GitHub token. Set it in the environment or in .env.',
    );
  }
  const baseURL = resolveProviderBaseURL(provider, providerCfg, ({ env }) => process.env[env]);
  const model = formatModelName(
    resolveModelName(provider, resolveProviderModel(provider, providerCfg, process.env.MODEL)),
  );
  const auxModelInput = process.env.JBOT_REVIEW_AUX_MODEL?.trim();
  const auxProvider = auxModelInput ? process.env.JBOT_AUX_PROVIDER?.trim() || provider : provider;
  const auxCfg = auxModelInput ? PROVIDERS[auxProvider] : undefined;
  if (auxModelInput && !auxCfg) {
    throw new Error(
      `Unknown aux provider "${auxProvider}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
    );
  }
  const auxApiKey =
    auxModelInput && auxProvider !== provider && auxCfg
      ? resolveProviderCredential(auxCfg, ({ env }) => process.env[env])
      : undefined;
  const auxModel = resolveAuxModelName(provider, auxModelInput, auxProvider);
  const auxBaseURL =
    auxModelInput && auxProvider !== provider && auxCfg
      ? resolveProviderBaseURL(auxProvider, auxCfg, ({ env }) => process.env[env])
      : undefined;

  // Backend-aware preflight: opencode only when the selection needs it; CLI
  // backends bring their own binary.
  const { providerID, modelID } = parseModelName(model);
  const aux = parseModelName(auxModel || model);
  // Preflight-only resolution (the runner re-resolves for its own routing):
  // roles served by the in-process pi engine need no opencode binary.
  const piEngine = resolvePiEngine(process.env, process.version);
  const selection = selectReviewBackends({
    providerID,
    modelID,
    apiKey,
    auxProviderID: aux.providerID,
    auxModelID: aux.modelID,
    auxApiKey: auxApiKey ?? '',
    piEnabled: piEngine.enabled,
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
    workspace: process.cwd(),
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
      reviewShards: parseEnvInt('JBOT_REVIEW_SHARDS', 1),
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
main().catch((error: unknown) => {
  console.error(
    `[jbot-review] Local review failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
