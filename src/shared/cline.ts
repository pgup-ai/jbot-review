import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseModelName } from './model.ts';
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
  type TokenUsageRecorder,
} from './opencode.ts';
import { spawnWithTimeout } from './cli-process.ts';
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const CLINE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const CLINE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const CLINE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
// Cline is argv-only headless (ignores piped stdin) and Linux caps one arg at 128KB;
// cap guidelines to the finder budget so the prompt stays argv-safe. Guard is a backstop.
const CLINE_GUIDELINE_BUDGET_BYTES = 24 * 1024;
const CLINE_MAX_ARGV_BYTES = 120 * 1024;

export const CLINE_PROVIDER_ID = 'cline';
/** Cline subscription billing mode; same backend as `cline`, different `--provider`. */
export const CLINE_PASS_PROVIDER_ID = 'cline-pass';
export const CLINE_CLI_BIN = 'cline';

export function isClineProvider(providerID: string): boolean {
  return providerID === CLINE_PROVIDER_ID || providerID === CLINE_PASS_PROVIDER_ID;
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
}

/**
 * Static `cline` argv. Read-only is enforced here (invariant #8): `--auto-approve
 * false` denies every tool call headless (POC-proven), `--plan` is the secondary
 * behavioral layer, and the bypass flags (`--auto-approve true`, `--yolo`) are never
 * emitted. `--provider` is the billing mode = the jbot provider id (`cline` /
 * `cline-pass`); cline's `-P` defaults to `cline` and ignores lastUsedProvider, so jbot
 * sets it explicitly. `--json` yields the NDJSON we parse; prompt appended per call.
 */
export function buildClineCliArgs(input: ClineCliArgsInput): string[] {
  const { providerID, modelID } = parseModelName(input.model);
  const args = ['--json', '--plan', '--auto-approve', 'false', '--provider', providerID];
  if (modelID !== 'default') args.push('--model', modelID);
  return args;
}

// Provider api-key envs Cline could read above the carried providers.json; stripped so an
// ambient key can't silently redirect billing (Cline is multi-provider, unlike codex).
export const CLINE_STRIPPED_ENV_KEYS = [
  'CLINE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
] as const;

/** Child env with the temp `HOME` (Cline reads `~/.cline`); provider api-key envs stripped. */
export function clineEnvForHome(clineHome: string | undefined): NodeJS.ProcessEnv {
  const home = clineHome?.trim();
  if (!home) {
    throw new Error('Missing Cline home. A temp HOME is required for auth.');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const key of CLINE_STRIPPED_ENV_KEYS) delete env[key];
  return env;
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
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  options: {
    lensAddendum?: string;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    home?: string;
  } = {},
): Promise<ReviewResult> {
  // Cline run_result carries usage, but mirror the other CLI backends and skip it.
  void options.onTokenUsage;
  const label = options.label ?? 'review';
  const guidelinesForArgv = truncateUtf8WithNotice(
    guidelines,
    CLINE_GUIDELINE_BUDGET_BYTES,
    'Guidelines',
  );
  const prompt = assembleReviewPrompt(prContext, guidelinesForArgv, options.lensAddendum ?? '');
  log(`Prompt assembled (${label}, cline): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runClinePrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.home,
    options.timeoutMs,
  );
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via cline: ${message}`);
    const repaired = await runClinePrompt(
      workspace,
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
      options.home,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runClineAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runClinePrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    home,
    timeoutMs,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runClineGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
): Promise<Finding[]> {
  void onTokenUsage;
  const guidelinesForArgv = truncateUtf8WithNotice(
    guidelines,
    CLINE_GUIDELINE_BUDGET_BYTES,
    'Guidelines',
  );
  const raw = await runClinePrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelinesForArgv),
    'guideline-compliance',
    log,
    home,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runClineChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
): Promise<string> {
  void onTokenUsage;
  const raw = await runClinePrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    home,
    timeoutMs,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runClineFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
): Promise<FindingVerdict[] | undefined> {
  void onTokenUsage;
  const raw = await runClinePrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    home,
    timeoutMs,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runClinePrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  home: string | undefined,
  timeoutMs = CLINE_PROMPT_TIMEOUT_MS,
): Promise<string> {
  // Cline takes the prompt as a positional arg (it ignores piped stdin headlessly).
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > CLINE_MAX_ARGV_BYTES) {
    throw new Error(
      `cline ${label} prompt is ${promptBytes} bytes, over the ${CLINE_MAX_ARGV_BYTES}-byte argv limit`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), 'jbot-cline-'));
  log(`Calling ${label} prompt (agent=cline-cli, model=${model})`);
  try {
    // Per-process HOME: copy providers.json so concurrent sessions don't race on the
    // file cline rewrites when it refreshes the token.
    const providers = clineProvidersPath(dir);
    mkdirSync(dirname(providers), { recursive: true, mode: 0o700 });
    copyFileSync(clineProvidersPath(home ?? ''), providers);
    const args = [...buildClineCliArgs({ model }), prompt];
    const result = await spawnWithTimeout(CLINE_CLI_BIN, args, {
      cwd: workspace,
      env: clineEnvForHome(dir),
      timeoutMs,
      timeoutMessage: formatClinePromptTimeoutMessage(label, model, timeoutMs),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `cline ${label} exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
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
        `cline ${label} produced no run_result message; stderr: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    return finalMessage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
