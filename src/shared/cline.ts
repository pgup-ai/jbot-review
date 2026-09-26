import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseModelName } from '@symma/protocol';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  truncateUtf8WithNotice,
  type VerifiableFinding,
} from './prompt.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  sessionEnvDenyKeys,
  type TokenUsageRecorder,
} from './opencode.ts';
import { truncateForLog } from '@symma/protocol';
import { runCliProcess } from './cli-process.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const CLINE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const CLINE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const CLINE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
// Linux caps a single argv entry at 128 KiB; Cline's complete diff must fit too.
const CLINE_GUIDELINE_BUDGET_BYTES = 24 * 1024;
export const CLINE_MAX_ARGV_BYTES = 120 * 1024;

// Free models use Cline 3.0.65's bundled catalog (2026-09-24); paid IDs use its live catalog (2026-09-20).
export const CLINE_MODEL_LIMITS: Record<string, { contextTokens: number; outputTokens: number }> = {
  'cline-free/deepseek-v4.1-flash': { contextTokens: 1048576, outputTokens: 131072 },
  'cline-free/gemini-3.8-flash': { contextTokens: 1048576, outputTokens: 65536 },
  'cline-free/mimo-v2.6-flash': { contextTokens: 1048576, outputTokens: 131072 },
  'cline-free/muse-spark-1.3-contributor': { contextTokens: 1048576, outputTokens: 943718 },
  'deepseek/deepseek-v4-flash': { contextTokens: 1048576, outputTokens: 384000 },
  'deepseek/deepseek-v4.1-flash': { contextTokens: 1048576, outputTokens: 384000 },
  'meta/muse-spark-1.3-contributor': { contextTokens: 1048576, outputTokens: 943718 },
  'stealth/space-bunny-alpha': { contextTokens: 1000000, outputTokens: 524288 },
};

export const CLINE_PROVIDER_ID = 'cline';
export const CLINE_TELEMETRY_CAPABILITY = 'opaque' as const;
/** Cline subscription billing mode; same backend as `cline`, different `--provider`. */
export const CLINE_PASS_PROVIDER_ID = 'cline-pass';
export const CLINE_CLI_BIN = 'cline';

export function isClineProvider(providerID: string): boolean {
  return providerID === CLINE_PROVIDER_ID || providerID === CLINE_PASS_PROVIDER_ID;
}

/** The per-run temp HOME holding the auth file, and the checkout Cline runs in. */
export interface ClineRuntime {
  home: string;
  workspace: string;
}

export function clineProvidersPath(clineHome: string): string {
  return join(clineHome, '.cline', 'data', 'settings', 'providers.json');
}

/**
 * Drop each provider's `model`/`reasoning` so the review uses only the auth token, not
 * the operator's local model/effort prefs. Throws on non-JSON (the caller maps it to a
 * clear error).
 */
export function stripClineModelReasoning(providersJson: string): string {
  const parsed = JSON.parse(providersJson) as {
    providers?: Record<string, { settings?: Record<string, unknown> }>;
  };
  for (const entry of Object.values(parsed.providers ?? {})) {
    if (entry?.settings) {
      delete entry.settings.model;
      delete entry.settings.reasoning;
    }
  }
  return JSON.stringify(parsed, null, 2);
}

/**
 * Writes the `CLINE_AUTH_JSON` secret (the contents of
 * `~/.cline/data/settings/providers.json`) under a temp `HOME`, keeping only the auth
 * token per provider (model/reasoning stripped). Invalid JSON fails fast.
 */
export function writeClineAuth(auth: string, clineHome: string): string {
  const content = auth.trim();
  if (!content) {
    throw new Error('Missing Cline auth. Set cline-auth or CLINE_AUTH_JSON.');
  }
  let tokenOnly: string;
  try {
    tokenOnly = stripClineModelReasoning(content);
  } catch {
    throw new Error(
      'Invalid CLINE_AUTH_JSON: expected the JSON contents of ~/.cline/data/settings/providers.json.',
    );
  }

  const path = clineProvidersPath(clineHome);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${tokenOnly}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}

export interface ClineCliArgsInput {
  model: string;
  promptArg: string;
}

/**
 * Complete `cline` argv. Headless Cline refuses every tool it cannot auto-approve, and
 * `--auto-approve` covers all tools at once, so reading the checkout means approving
 * shell and write tools too; `--plan` is what keeps it from editing. That is an accepted
 * risk on CI runners. `--yolo` is never emitted. `--provider` is the billing mode = the
 * jbot provider id (`cline` / `cline-pass`); cline's `-P` defaults to `cline` and ignores
 * lastUsedProvider, so jbot sets it explicitly. `--json` yields the NDJSON we parse; the
 * prompt is the final positional arg (cline ignores piped stdin headless) and carries
 * only PR content — credentials ride the per-session providers.json HOME file, never argv.
 */
export function buildClineCliArgs(input: ClineCliArgsInput): string[] {
  const { providerID, modelID } = parseModelName(input.model);
  const args = ['--json', '--plan', '--auto-approve', 'true', '--provider', providerID];
  if (modelID !== 'default') args.push('--model', clineModelId(input.model));
  args.push(input.promptArg);
  return args;
}

/**
 * Cline's model id is `modelType/model`: cline-pass models are namespaced under the
 * provider (`cline-pass/glm-5.2`); pay-as-you-go `cline` ids already carry their type.
 */
function clineModelId(model: string): string {
  const { providerID, modelID } = parseModelName(model);
  return providerID === CLINE_PASS_PROVIDER_ID ? `${providerID}/${modelID}` : modelID;
}

export function assertClinePromptArgWithinBudget(label: string, prompt: string): void {
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > CLINE_MAX_ARGV_BYTES) {
    throw new Error(
      `cline ${label} prompt is ${promptBytes} bytes, over the ${CLINE_MAX_ARGV_BYTES}-byte argv limit. ` +
        'Incomplete review coverage: the full assigned diff cannot be delivered. ' +
        'Increase review-shards or select a backend with repository tools; the diff will not be truncated.',
    );
  }
}

/** Child env with the temp `HOME` (Cline reads `~/.cline`); ambient credentials stripped. */
export function clineEnvForHome(clineHome: string | undefined): NodeJS.ProcessEnv {
  const home = clineHome?.trim();
  if (!home) {
    throw new Error('Missing Cline home. A temp HOME is required for auth.');
  }
  // Isolated homes cannot see other sessions when Cline decides whether it is safe to self-update.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLINE_NO_AUTO_UPDATE: '1' };
  for (const key of sessionEnvDenyKeys(Object.keys(env))) delete env[key];
  return env;
}

/**
 * Failure output minus Cline's `@/` mention warnings: it reads the diff's
 * `'@/api/x'` imports as file mentions and logs one harmless ENOENT each
 * (probed on 3.0.61), which would bury the real error under the log cap. The
 * swallowed closing quote or backtick marks them; a real missing file has
 * neither.
 */
const CLINE_MENTION_WARNING =
  /^\[warning\] ENOENT: no such file or directory, statx? '\/.*["'`][;,]?'$/;

export function clineFailureDetail(stderr: string, stdout: string, logged = ''): string {
  const lines = stderr.split('\n');
  const kept = lines.filter((line) => !CLINE_MENTION_WARNING.test(line));
  const dropped = lines.length - kept.length;
  const text = truncateForLog(kept.join('\n').trim() || stdout, 1000);
  const detail = dropped ? `${text} (${dropped} @-mention ENOENT warnings dropped)` : text;
  return logged ? `${detail} (cline.log: ${logged})` : detail;
}

/** Some Cline failures appear only in its own log, not on stderr. */
function clineLoggedErrors(dir: string): string {
  let text: string;
  try {
    text = readFileSync(join(dir, '.cline', 'data', 'logs', 'cline.log'), 'utf8');
  } catch {
    return '';
  }
  const errors = text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { level: number; msg?: string; err?: { message?: string } };
      return entry.level >= 50 ? [[entry.msg, entry.err?.message].filter(Boolean).join(': ')] : [];
    } catch {
      return [];
    }
  });
  return truncateForLog(errors.slice(-3).join(' | '), 600);
}

/** The clean final message is the `run_result` event's `text` (NDJSON stdout). */
export function parseClineFinalMessage(stdout: string): string {
  let text = '';
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      event &&
      typeof event === 'object' &&
      (event as { type?: unknown }).type === 'run_result' &&
      typeof (event as { text?: unknown }).text === 'string'
    ) {
      text = (event as { text: string }).text;
    }
  }
  return text;
}

export function formatClinePromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `cline ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}

export async function runClineReview(
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  options: {
    lensAddendum?: string;
    contextFirst?: boolean;
    contextPack?: boolean;
    evidenceQuotes?: boolean;
    embeddedFirstPrompt?: boolean;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    runtime: ClineRuntime;
  },
): Promise<ReviewResult> {
  // Cline run_result carries usage, but mirror the other CLI backends and skip it.
  void options.onTokenUsage;
  const label = options.label ?? 'review';
  const guidelinesForArgv = truncateUtf8WithNotice(
    guidelines,
    CLINE_GUIDELINE_BUDGET_BYTES,
    'Guidelines',
  );
  const prompt = assembleReviewPrompt(
    prContext,
    guidelinesForArgv,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
    options.embeddedFirstPrompt ?? false,
    { toolsAvailable: true, contextFirst: options.contextFirst, contextPack: options.contextPack },
  );
  log(`Prompt assembled (${label}, cline): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runClinePrompt(model, prompt, label, log, options.runtime, options.timeoutMs);
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via cline: ${message}`);
    const repaired = await runClinePrompt(
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: CLINE_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: CLINE_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.runtime,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runClineAddressedPriorCommentsCheck(
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs: number | undefined,
  onTokenUsage: TokenUsageRecorder | undefined,
  runtime: ClineRuntime,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runClinePrompt(
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    runtime,
    timeoutMs,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runClineGuidelineComplianceCheck(
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs: number | undefined,
  onTokenUsage: TokenUsageRecorder | undefined,
  runtime: ClineRuntime,
): Promise<Finding[]> {
  void onTokenUsage;
  const guidelinesForArgv = truncateUtf8WithNotice(
    guidelines,
    CLINE_GUIDELINE_BUDGET_BYTES,
    'Guidelines',
  );
  const raw = await runClinePrompt(
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelinesForArgv),
    'guideline-compliance',
    log,
    runtime,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runClineChangesSinceLastReview(
  model: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs: number | undefined,
  onTokenUsage: TokenUsageRecorder | undefined,
  runtime: ClineRuntime,
): Promise<string> {
  void onTokenUsage;
  const raw = await runClinePrompt(
    model,
    assembleChangesSinceLastReviewPrompt(
      truncateUtf8WithNotice(
        deltaContext,
        CLINE_MAX_ARGV_BYTES -
          256 - // Reserve the omission notice in the argv limit.
          Buffer.byteLength(assembleChangesSinceLastReviewPrompt('')),
        'Changes-since summary context',
      ),
    ),
    'changes-since-last-review',
    log,
    runtime,
    timeoutMs,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runClineFindingVerification(
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs: number | undefined,
  onTokenUsage: TokenUsageRecorder | undefined,
  runtime: ClineRuntime,
): Promise<FindingVerdict[] | undefined> {
  void onTokenUsage;
  const raw = await runClinePrompt(
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    runtime,
    timeoutMs,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runClinePrompt(
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  runtime: ClineRuntime,
  timeoutMs = CLINE_PROMPT_TIMEOUT_MS,
): Promise<string> {
  assertClinePromptArgWithinBudget(label, prompt);
  log(`Calling ${label} prompt (agent=cline-cli, model=${model})`);
  const deadline = Date.now() + timeoutMs;
  const timeoutMessage = formatClinePromptTimeoutMessage(label, model, timeoutMs);
  const run = () =>
    runClineOnce(model, prompt, runtime, Math.max(0, deadline - Date.now()), timeoutMessage, log);
  let result = await run();
  // Cline can exit 0 without printing anything; one fresh run is cheap.
  if (result.exitCode === 0 && !result.stdout && !result.stderr) {
    log(`${label} prompt exited without output via cline; retrying once.`);
    result = await run();
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `cline ${label} exited ${result.exitCode}: ${clineFailureDetail(result.stderr, result.stdout, result.logged)}`,
    );
  }
  const finalMessage = parseClineFinalMessage(result.stdout).trim();
  log(
    `${label} prompt complete via cline: stdout=${result.stdout.length} chars last-message=${finalMessage.length} chars`,
  );
  // No run_result message = the run failed or produced nothing; fail loud rather
  // than parse the noisy event stream.
  if (!finalMessage) {
    throw new Error(
      `cline ${label} produced no run_result message; stderr: ${clineFailureDetail(
        result.stderr,
        result.stdout,
        result.logged,
      )}`,
    );
  }
  return finalMessage;
}

async function runClineOnce(
  model: string,
  promptArg: string,
  runtime: ClineRuntime,
  timeoutMs: number,
  timeoutMessage: string,
  log: (msg: string) => void,
) {
  return inClineHome(runtime.home, log, async (dir) => {
    // In the checkout, so its read tools see the code; its hooks and rules load too.
    const result = await runCliProcess(CLINE_CLI_BIN, buildClineCliArgs({ model, promptArg }), {
      cwd: runtime.workspace,
      env: clineEnvForHome(dir),
      timeoutMs,
      timeoutMessage,
    });
    return { ...result, logged: clineLoggedErrors(dir) };
  });
}

async function inClineHome<T>(
  home: string,
  log: (msg: string) => void,
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-cline-'));
  try {
    // Per-process HOME: copy providers.json so concurrent sessions don't race on the
    // file cline rewrites when it refreshes the token.
    const providers = clineProvidersPath(dir);
    mkdirSync(dirname(providers), { recursive: true, mode: 0o700 });
    copyFileSync(clineProvidersPath(home), providers);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(
      (error: NodeJS.ErrnoException) => log(`Cline temporary-home cleanup failed: ${error.code}.`),
    );
  }
}

/** Cline refused the SDK route (HTTP 403): the findings stay unverified. */
export class ClineSdkForbiddenError extends Error {}

/**
 * Opt-in verifier (JBOT_CLINE_SDK_VERIFIER): @cline/sdk with read-only checkout tools,
 * in a child process with the CLI's environment and temp HOME (see cline-sdk-worker.ts).
 */
export async function runClineSdkFindingVerification(
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  runtime: ClineRuntime,
  timeoutMs = CLINE_PROMPT_TIMEOUT_MS,
): Promise<FindingVerdict[]> {
  // The CLI resolves `default` itself; the SDK needs a concrete model id.
  if (parseModelName(model).modelID === 'default')
    throw new Error('the Cline SDK needs a concrete model id');
  log(`Calling finding-verification prompt (agent=cline-sdk, model=${model})`);
  const bundled = fileURLToPath(new URL('../cline-sdk-worker.js', import.meta.url));
  const worker = existsSync(bundled)
    ? [bundled]
    : [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./cline-sdk-worker.ts', import.meta.url)),
      ];
  const result = await inClineHome(runtime.home, log, (dir) =>
    runCliProcess(process.execPath, worker, {
      cwd: dir,
      env: clineEnvForHome(dir),
      timeoutMs,
      timeoutMessage: formatClinePromptTimeoutMessage('finding-verification', model, timeoutMs),
      input: JSON.stringify({
        providerId: parseModelName(model).providerID,
        modelId: clineModelId(model),
        prompt: assembleFindingVerificationPrompt(prContext, findings),
        workspace: runtime.workspace,
        timeoutMs,
      }),
    }),
  );
  if (result.exitCode !== 0) throw clineSdkFailure(result.exitCode, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as {
    text: string;
    toolCalls: number;
    denied: number;
  };
  log(
    `finding-verification complete via cline-sdk: ${output.toolCalls} tool calls, ${output.denied} denied`,
  );
  const verdicts = parseFindingVerdicts(output.text, findings.length, log);
  if (!verdicts?.length)
    throw new Error('cline-sdk finding-verification returned no usable verdicts');
  return verdicts;
}

/** A 403 in the worker's error text means Cline refused the SDK route. */
export function clineSdkFailure(exitCode: number | null, stderr: string): Error {
  const detail = `cline-sdk finding-verification exited ${exitCode}: ${truncateForLog(stderr, 600)}`;
  return /\bError 403\b/.test(stderr) ? new ClineSdkForbiddenError(detail) : new Error(detail);
}

/**
 * A 403 leaves the findings unverified; any other SDK failure falls back to the CLI
 * single pass in the time left.
 */
export async function withClineSdkFallback<T>(
  sdk: (timeoutMs?: number) => Promise<T>,
  cli: (timeoutMs?: number) => Promise<T>,
  timeoutMs: number | undefined,
  log: (msg: string) => void,
): Promise<T> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  try {
    return await sdk(timeoutMs);
  } catch (error) {
    if (error instanceof ClineSdkForbiddenError) throw error;
    log(
      `Cline SDK verification failed (${error instanceof Error ? error.message : String(error)}); falling back to the CLI single pass.`,
    );
    return cli(deadline === undefined ? undefined : Math.max(0, deadline - Date.now()));
  }
}
