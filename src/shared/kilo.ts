import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelName } from './model.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  NO_TOOLS_REVIEW_DIRECTIVE,
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

const KILO_PROMPT_TIMEOUT_MS = 20 * 60_000;
const KILO_MODEL_LIST_TIMEOUT_MS = 60_000;
const KILO_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const KILO_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

export const KILO_PROVIDER_ID = 'kilo';
export const KILO_CLI_BIN = 'kilo';
/** Kilo's hardcoded free smart-router; the CI default. Gateway-prefixed (see buildKiloCliArgs). */
export const KILO_GATEWAY_FREE_MODEL = 'kilo-auto/free';

export function isKiloProvider(providerID: string): boolean {
  return providerID === KILO_PROVIDER_ID;
}

/**
 * Static `kilo run` argv. Read-only is enforced here (invariant #8): `--agent plan`
 * denies edit/write/terminal headless (POC: a write tool is auto-denied, no hang), and
 * the bypass flags (`--auto`, `--dangerously-skip-permissions`) are never emitted.
 * `--format json` yields the NDJSON we parse. The prompt goes on stdin (runKiloPrompt).
 *
 * Model mapping: jbot's provider id (`kilo`) is also Kilo's gateway provider id, so
 * parseModelName strips the leading `kilo/`; we re-add it so `--model` stays
 * gateway-qualified (`kilo/kilo-auto/free`) — the bare form 404s (POC). `default` maps
 * to the free smart-router.
 */
export function buildKiloCliArgs(input: { model: string }): string[] {
  const { modelID } = parseModelName(input.model);
  const model = modelID === 'default' ? KILO_GATEWAY_FREE_MODEL : modelID;
  return ['run', '--format', 'json', '--agent', 'plan', '--model', `${KILO_PROVIDER_ID}/${model}`];
}

/** Prompt input: the no-tools directive (a denied tool under `--agent plan` yields empty
 * text — POC) prepended so the model reviews the embedded context instead of stalling. */
export function buildKiloPromptInput(prompt: string): string {
  return `${NO_TOOLS_REVIEW_DIRECTIVE}\n\n${prompt}`;
}

// Provider api-key envs Kilo could read above the injected KILO_AUTH_CONTENT; stripped so
// an ambient key can't silently redirect provider/billing (Kilo is multi-provider).
export const KILO_STRIPPED_ENV_KEYS = [
  'KILO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
] as const;

/**
 * Validates the `KILO_AUTH_CONTENT` secret — the contents of
 * `~/.local/share/kilo/auth.json` — is present and JSON, returning the trimmed content.
 * Throws a clear error so a bad secret fails fast at startup.
 */
export function assertValidKiloAuth(auth: string): string {
  const content = auth.trim();
  if (!content) {
    throw new Error('Missing Kilo auth. Set kilo-auth or KILO_AUTH_CONTENT.');
  }
  try {
    JSON.parse(content);
  } catch {
    throw new Error(
      'Invalid KILO_AUTH_CONTENT: expected the JSON contents of ~/.local/share/kilo/auth.json.',
    );
  }
  return content;
}

/**
 * Child env carrying the Kilo credential via `KILO_AUTH_CONTENT` (env-injected, no file
 * written). `HOME`/`XDG_DATA_HOME` point at a per-process temp dir so concurrent
 * sessions don't race kilo's SQLite data dir (every invocation opens/migrates
 * ~/.local/share/kilo/kilo.db) or any token-refresh writeback. Ambient provider api-key
 * envs are stripped so the carried auth wins.
 */
export function kiloEnvForAuth(auth: string, home: string): NodeJS.ProcessEnv {
  const content = assertValidKiloAuth(auth);
  const h = home?.trim();
  if (!h) {
    throw new Error('Missing Kilo home. A temp HOME is required for the kilo data dir.');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_AUTH_CONTENT: content,
    HOME: h,
    XDG_DATA_HOME: join(h, '.local/share'),
  };
  for (const key of KILO_STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

/**
 * The clean final message is the LAST `type:"text"` event's `part.text` (NDJSON stdout).
 * POC: text lives at part.text and events are cumulative snapshots, so take-last
 * (concatenating would double-count). Non-JSON log lines are skipped.
 */
export function parseKiloFinalMessage(stdout: string): string {
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
    if (event && typeof event === 'object' && (event as { type?: unknown }).type === 'text') {
      const part = (event as { part?: { text?: unknown } }).part;
      if (part && typeof part.text === 'string') text = part.text;
    }
  }
  return text;
}

/**
 * Parses `kilo models` output. Each model line is a bare `provider/model-id` token; the
 * CLI's INFO log lines (which contain spaces) and headers/blanks are skipped. Pure.
 */
export function parseKiloModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (/^[A-Za-z0-9~][^\s]*\/[^\s]+$/.test(trimmed)) models.push(trimmed);
  }
  return models;
}

export function formatKiloPromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `kilo ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}

export async function runKiloReview(
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
    auth?: string;
  } = {},
): Promise<ReviewResult> {
  void options.onTokenUsage; // kilo --format json usage not wired; mirror the other CLI backends.
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(prContext, guidelines, options.lensAddendum ?? '');
  log(`Prompt assembled (${label}, kilo): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runKiloPrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.auth,
    options.timeoutMs,
  );
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via kilo: ${message}`);
    const repaired = await runKiloPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: KILO_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: KILO_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.auth,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runKiloAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    auth,
    timeoutMs,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runKiloGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<Finding[]> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    auth,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runKiloChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<string> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    auth,
    timeoutMs,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runKiloFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  auth?: string,
): Promise<FindingVerdict[] | undefined> {
  void onTokenUsage;
  const raw = await runKiloPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    auth,
    timeoutMs,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

/**
 * Lists the models the auth can use via `kilo models`, for the startup observability log
 * (mirrors listCursorModels). Best-effort: the runner logs and continues on failure.
 */
export async function listKiloModels(workspace: string, auth: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-kilo-'));
  try {
    const result = await spawnWithTimeout(KILO_CLI_BIN, ['models'], {
      cwd: workspace,
      env: kiloEnvForAuth(auth, dir),
      timeoutMs: KILO_MODEL_LIST_TIMEOUT_MS,
      timeoutMessage: `kilo model listing timed out after ${Math.round(
        KILO_MODEL_LIST_TIMEOUT_MS / 1000,
      )}s`,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `kilo model listing exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    return parseKiloModelList(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runKiloPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  auth: string | undefined,
  timeoutMs = KILO_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const args = buildKiloCliArgs({ model });
  const input = buildKiloPromptInput(prompt);
  log(`Calling ${label} prompt (agent=kilo-cli, model=${model})`);
  // Per-process HOME/XDG so concurrent sessions don't race kilo's SQLite data dir or any
  // token-refresh writeback; the prompt goes on stdin (no argv size limit).
  const dir = mkdtempSync(join(tmpdir(), 'jbot-kilo-'));
  try {
    const result = await spawnWithTimeout(KILO_CLI_BIN, args, {
      cwd: workspace,
      input,
      env: kiloEnvForAuth(auth ?? '', dir),
      timeoutMs,
      timeoutMessage: formatKiloPromptTimeoutMessage(label, model, timeoutMs),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `kilo ${label} exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    const finalMessage = parseKiloFinalMessage(result.stdout).trim();
    log(
      `${label} prompt complete via kilo: stdout=${result.stdout.length} chars last-message=${finalMessage.length} chars`,
    );
    if (!finalMessage) {
      throw new Error(
        `kilo ${label} produced no text event; stderr: ${truncateForLog(result.stderr || result.stdout, 1000)}`,
      );
    }
    return finalMessage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
