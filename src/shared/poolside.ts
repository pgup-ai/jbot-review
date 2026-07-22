import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithTimeout } from './cli-process.ts';
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
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const POOLSIDE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const POOLSIDE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const POOLSIDE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const POOLSIDE_API_URL = 'https://inference.poolside.ai';
const POOLSIDE_STANDALONE_BASE_URL = `${POOLSIDE_API_URL}/v1`;
const POOLSIDE_SETTINGS = `tools:
  shell:
    disabled: true
paths:
  deny:
    - path: "/**"
`;

export const POOLSIDE_PROVIDER_ID = 'poolside';
export const POOLSIDE_CLI_BIN = 'pool';
export const POOLSIDE_DEFAULT_MODEL = 'poolside/laguna-s-2.1';

export function isPoolsideProvider(providerID: string): boolean {
  return providerID === POOLSIDE_PROVIDER_ID;
}

export function assertPoolsideApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('Missing Poolside API key. Set poolside-api-key or POOLSIDE_API_KEY.');
  }
  return key;
}

export function poolsideModelID(model: string): string {
  const { modelID } = parseModelName(model);
  if (modelID === 'default') return POOLSIDE_DEFAULT_MODEL;
  return `${POOLSIDE_PROVIDER_ID}/${modelID}`;
}

/**
 * `pool exec` accepts its prompt on stdin and streams NLJSON on stdout. It has
 * no model flag; POOLSIDE_STANDALONE_MODEL in poolsideEnvForRuntime selects it.
 * Auto-approval is safe here because explicit deny rules in the isolated Pool
 * settings still win, and the process runs in an empty read-only workspace.
 */
export function buildPoolsideCliArgs(workspace: string): string[] {
  return [
    'exec',
    '--directory',
    workspace,
    '--output',
    'json',
    '--prompt',
    '-',
    '--unsafe-auto-allow',
  ];
}

export function buildPoolsidePromptInput(prompt: string): string {
  return `${NO_TOOLS_REVIEW_DIRECTIVE}\n\n${prompt}`;
}

export function poolsideSettingsPath(home: string): string {
  return join(home, '.config', 'poolside', 'settings.yaml');
}

export function writePoolsideSettings(home: string): string {
  const value = home.trim();
  if (!value) throw new Error('Missing Poolside home. A temp HOME is required.');
  const path = poolsideSettingsPath(value);
  mkdirSync(join(value, '.config', 'poolside'), { recursive: true, mode: 0o700 });
  writeFileSync(path, POOLSIDE_SETTINGS, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}

const POOLSIDE_ENV_KEYS = [
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

export function poolsideEnvForRuntime(
  apiKey: string,
  model: string,
  home: string,
): NodeJS.ProcessEnv {
  const value = home.trim();
  if (!value) throw new Error('Missing Poolside home. A temp HOME is required.');
  const env: NodeJS.ProcessEnv = {};
  for (const key of POOLSIDE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = value;
  env.XDG_CONFIG_HOME = join(value, '.config');
  env.XDG_DATA_HOME = join(value, '.local', 'share');
  env.XDG_STATE_HOME = join(value, '.local', 'state');
  env.XDG_CACHE_HOME = join(value, '.cache');
  env.POOLSIDE_API_KEY = assertPoolsideApiKey(apiKey);
  env.POOLSIDE_API_URL = POOLSIDE_API_URL;
  env.POOLSIDE_STANDALONE_BASE_URL = POOLSIDE_STANDALONE_BASE_URL;
  env.POOLSIDE_STANDALONE_MODEL = poolsideModelID(model);
  return env;
}

export function parsePoolsideFinalMessage(stdout: string): string {
  let message = '';
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
      (event as { type?: unknown }).type === 'assistantMessage'
    ) {
      const value = (event as { message?: unknown }).message;
      if (typeof value === 'string') message = value;
    }
  }
  return message;
}

export function formatPoolsidePromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `pool ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}

export async function runPoolsideReview(
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
    apiKey?: string;
  } = {},
): Promise<ReviewResult> {
  void options.onTokenUsage;
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
  );
  log(`Prompt assembled (${label}, poolside): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runPoolsidePrompt(model, prompt, label, log, options.apiKey, options.timeoutMs);
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via pool: ${message}`);
    const repaired = await runPoolsidePrompt(
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: POOLSIDE_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: POOLSIDE_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.apiKey,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runPoolsideAddressedPriorCommentsCheck(
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runPoolsidePrompt(
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    apiKey,
    timeoutMs,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runPoolsideGuidelineComplianceCheck(
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<Finding[]> {
  void onTokenUsage;
  const raw = await runPoolsidePrompt(
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    apiKey,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runPoolsideChangesSinceLastReview(
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<string> {
  void onTokenUsage;
  const raw = await runPoolsidePrompt(
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    apiKey,
    timeoutMs,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runPoolsideFindingVerification(
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<FindingVerdict[] | undefined> {
  void onTokenUsage;
  const raw = await runPoolsidePrompt(
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    apiKey,
    timeoutMs,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runPoolsidePrompt(
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  apiKey: string | undefined,
  timeoutMs = POOLSIDE_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'jbot-poolside-'));
  try {
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o500 });
    writePoolsideSettings(home);
    log(`Calling ${label} prompt (agent=pool-cli, model=${poolsideModelID(model)})`);
    const result = await spawnWithTimeout(POOLSIDE_CLI_BIN, buildPoolsideCliArgs(workspace), {
      cwd: workspace,
      input: buildPoolsidePromptInput(prompt),
      env: poolsideEnvForRuntime(apiKey ?? '', model, home),
      timeoutMs,
      timeoutMessage: formatPoolsidePromptTimeoutMessage(label, model, timeoutMs),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `pool ${label} exited ${result.exitCode}: ${truncateForLog(result.stderr || result.stdout, 1000)}`,
      );
    }
    const finalMessage = parsePoolsideFinalMessage(result.stdout).trim();
    log(
      `${label} prompt complete via pool: stdout=${result.stdout.length} chars last-message=${finalMessage.length} chars`,
    );
    if (!finalMessage) {
      throw new Error(
        `pool ${label} produced no assistantMessage event; stderr: ${truncateForLog(result.stderr || result.stdout, 1000)}`,
      );
    }
    return finalMessage;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
