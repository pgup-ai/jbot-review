import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';

import { parseModelName, spawnWithTimeout, truncateForLog } from '@symma/protocol';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  type VerifiableFinding,
} from './prompt.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  type PromptTokenUsage,
  type TokenUsageRecorder,
} from './opencode.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const DIM_PROMPT_TIMEOUT_MS = 20 * 60_000;
const DIM_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const DIM_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

export const DIM_PROVIDER_ID = 'dim';
export const DIM_CLI_BIN = 'dim';

/**
 * Tool allowlist for review sessions. `--tools` is the ONLY per-tool lever that
 * works — `--disallowed-tools` and `permissions.json` are accepted and then
 * silently ignored (measured 2026-08-17, dimcode 0.3.15), so never configure dim
 * through those. This set drops `write`/`edit` and `skill`; the last matters
 * because dim discovers repo-local skills from `.agents/skills` and `./skills`,
 * which are PR-author-controlled.
 *
 * `exec` stays, because exploring the checkout is the point. Measured alongside
 * the args below: `--policy read-only` declines a shell write (`echo x > f`) and
 * network (`curl`).
 *
 * It does NOT confine reads: `read` returns files outside the cwd (measured), and
 * dim has no `external_directory` deny like opencode's — `--tools` cannot express
 * a path scope and `--disallowed-tools` is ignored. Denying `curl` does not make
 * that safe, because the model API call is itself the channel: anything read can
 * be echoed into the response. In CI the ephemeral container bounds what exists
 * to read; `review:local` has no such bound and is only as safe as the branch
 * being reviewed — which for self-review is the operator's own code.
 */
const DIM_ALLOWED_TOOLS = 'read,glob,grep,exec';

export function isDimProvider(providerID: string): boolean {
  return providerID === DIM_PROVIDER_ID;
}

/**
 * dim splits its two files across one home: the OAuth token store sits at the
 * root while the sqlite store (and config, logs) nests under `v2/`. Putting
 * `auth.json` under `v2/` yields a silent "Not authenticated".
 */
export function dimHomePaths(home: string): { auth: string; store: string } {
  return { auth: join(home, 'auth.json'), store: join(home, 'v2', 'dimcode.sqlite') };
}

/**
 * The secret carries TWO files, because either alone is useless: `auth.json`
 * authenticates but leaves dim with "No connected provider" — the provider
 * connection lives in `dimcode.sqlite`, and no CLI command reconstructs it
 * (`provider enable`/`switch` both refuse for the OAuth provider). They must
 * also be refreshed together, so one blob keeps them from drifting apart.
 * `scripts/dim-bundle.ts` builds it from a local `dim auth login`.
 */
export interface DimBundle {
  auth: string;
  /** base64 of `dimcode.sqlite`, pruned to `provider` alone. */
  store: string;
  /** The one dim provider the store still carries a connection row for. */
  provider: string;
}

export function encodeDimBundle(bundle: DimBundle): string {
  return gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8')).toString('base64');
}

export function decodeDimBundle(credential: string): DimBundle {
  const content = credential.trim();
  if (!content) {
    throw new Error('Missing dim credential. Set dim-auth/DIM_AUTH_BUNDLE.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(gunzipSync(Buffer.from(content, 'base64')).toString('utf8'));
  } catch {
    throw new Error('Invalid DIM_AUTH_BUNDLE: expected the base64 blob from `npm run dim:bundle`.');
  }
  const bundle = parsed as Partial<DimBundle>;
  const present = (value: unknown): value is string => typeof value === 'string' && value !== '';
  if (!present(bundle?.auth) || !present(bundle?.store) || !present(bundle?.provider)) {
    throw new Error('Invalid DIM_AUTH_BUNDLE: missing auth, store, or provider.');
  }
  return { auth: bundle.auth, store: bundle.store, provider: bundle.provider };
}

/**
 * One throwaway home per spawn, under the run's parent dir. dim keeps its whole
 * store in a single `dimcode.sqlite`, so concurrent sessions sharing a home die
 * on "database is locked" — the same race kilo (an opencode fork) hits.
 */
function createDimSessionHome(parent: string, bundle: DimBundle): string {
  const home = mkdtempSync(join(parent, 'session-'));
  const paths = dimHomePaths(home);
  writeFileSync(paths.auth, `${bundle.auth}\n`, { mode: 0o600 });
  mkdirSync(dirname(paths.store), { recursive: true, mode: 0o700 });
  writeFileSync(paths.store, Buffer.from(bundle.store, 'base64'), { mode: 0o600 });
  return home;
}

/** Splits jbot's `dim/<dimProvider>/<model>` tail into dim's own two flags. */
function parseDimModel(model: string): { provider?: string; model?: string } {
  const { modelID } = parseModelName(model);
  if (modelID === 'default') return {};
  const slash = modelID.indexOf('/');
  if (slash < 0) return { model: modelID };
  return { provider: modelID.slice(0, slash), model: modelID.slice(slash + 1) };
}

export function buildDimCliArgs(model: string): string[] {
  const args = [
    'exec',
    // Mandatory pair. `--policy read-only` alone still permits every `git *`
    // including commit/reset --hard; `--mode plan` is what declines them.
    '--mode',
    'plan',
    '--policy',
    'read-only',
    '--tools',
    DIM_ALLOWED_TOOLS,
    '--json',
    '--stdin',
  ];
  const { provider, model: modelID } = parseDimModel(model);
  if (provider) args.push('--provider', provider);
  if (modelID) args.push('--model', modelID);
  return args;
}

const DIM_ENV_KEYS = [
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'CI',
] as const;

export function dimEnvForHome(home: string | undefined): NodeJS.ProcessEnv {
  const value = home?.trim();
  if (!value) {
    throw new Error('Missing dim home. A temp DIMCODE_HOME is required for auth.');
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of DIM_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = value;
  env.DIMCODE_HOME = value;
  // Without this, a read like `git status` refreshes the shared index — a write
  // to the checkout, and a race between parallel sessions.
  env.GIT_OPTIONAL_LOCKS = '0';
  // The CLI self-updates by default, which would drift from the pinned image.
  env.DIMCODE_DISABLE_AUTOUPDATE = '1';
  return env;
}

export interface DimRuntime {
  parent: string;
  bundle: DimBundle;
}

interface DimRunOutcome {
  text: string;
  usage?: PromptTokenUsage;
  failure?: string;
}

/**
 * Reads dim's `--json` JSONL. Assistant text arrives as `text:delta` chunks —
 * `message:*` carry ids only — and the terminal `run:ended` holds both the
 * status and the run's token usage.
 */
export function parseDimEventStream(stdout: string): DimRunOutcome {
  let text = '';
  let usage: PromptTokenUsage | undefined;
  let failure: string | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.eventType === 'text:delta' && typeof payload.delta === 'string') {
      text += payload.delta;
      continue;
    }
    if (event.eventType !== 'run:ended') continue;
    if (payload.status !== 'completed') {
      const error = (payload.error ?? {}) as Record<string, unknown>;
      failure =
        typeof error.message === 'string'
          ? error.message
          : `run ${String(payload.status)} (${String(payload.reason)})`;
    }
    const raw = (payload.usage ?? {}) as Record<string, unknown>;
    const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
    usage = {
      input: num(raw.promptTokens),
      output: num(raw.completionTokens),
      reasoning: 0,
      cacheRead: num(raw.cacheReadTokens),
      cacheWrite: 0,
    };
  }
  return { text: text.trim(), usage, failure };
}

export async function runDimReview(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  options: {
    lensAddendum?: string;
    evidenceQuotes?: boolean;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    runtime?: DimRuntime;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
  );
  log(`Prompt assembled (${label}, dim): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runDimPrompt(workspace, model, prompt, label, log, options);
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via dim: ${message}`);
    const repaired = await runDimPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: DIM_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: DIM_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runDimAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<AddressedPriorComment[]> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runDimGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<Finding[]> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runDimChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<string> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runDimFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<FindingVerdict[] | undefined> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings, true),
    'finding-verification',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runDimPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  options: { timeoutMs?: number; onTokenUsage?: TokenUsageRecorder; runtime?: DimRuntime },
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DIM_PROMPT_TIMEOUT_MS;
  const runtime = options.runtime;
  if (!runtime)
    throw new Error('Missing dim runtime. A decoded bundle and parent dir are required.');
  const requested = parseDimModel(model).provider;
  if (requested && requested !== runtime.bundle.provider) {
    throw new Error(
      `dim ${label}: model requests provider "${requested}" but DIM_AUTH_BUNDLE carries only ` +
        `"${runtime.bundle.provider}". Rebuild it with: npm run dim:bundle -- ${requested}`,
    );
  }
  const home = createDimSessionHome(runtime.parent, runtime.bundle);
  log(`Calling ${label} prompt (agent=dim-cli, model=${model})`);
  let result;
  try {
    result = await spawnWithTimeout(DIM_CLI_BIN, buildDimCliArgs(model), {
      cwd: workspace,
      env: dimEnvForHome(home),
      input: prompt,
      timeoutMs,
      timeoutMessage: `dim ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`,
    });
  } finally {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      // Never let teardown replace the error being unwound.
      log(`dim ${label}: session home teardown failed: ${String(error)}`);
    }
  }
  const { text, usage, failure } = parseDimEventStream(result.stdout);
  if (usage) options.onTokenUsage?.(usage, model, label);
  if (result.exitCode !== 0 || failure) {
    throw new Error(
      `dim ${label} failed (exit ${result.exitCode}): ${truncateForLog(
        failure ?? result.stderr ?? '',
        1000,
      )}`,
    );
  }
  log(`${label} prompt complete via dim: ${text.length} chars`);
  if (!text) {
    throw new Error(
      `dim ${label} produced no final message; stderr: ${truncateForLog(result.stderr, 1000)}`,
    );
  }
  return text;
}
