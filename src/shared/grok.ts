import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelName } from './model.ts';
import {
  NO_TOOLS_REVIEW_DIRECTIVE,
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
  type TokenUsageRecorder,
} from './opencode.ts';
import { spawnWithTimeout } from './cli-process.ts';
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const GROK_PROMPT_TIMEOUT_MS = 20 * 60_000;
const GROK_AUTH_CHECK_TIMEOUT_MS = 30_000;
const GROK_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const GROK_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const GROK_MAX_TURNS = 12;
const GROK_CONFIG = '[cli]\nauto_update = false\n';

export const GROK_MAX_PROMPT_BYTES = 1024 * 1024;
export const GROK_PROVIDER_ID = 'grok';
export const GROK_CLI_BIN = 'grok';

export type GrokRuntime =
  | { home: string; authMode: 'account'; authPath: string }
  | { home: string; authMode: 'api-key'; apiKey: string };

export function isGrokProvider(providerID: string): boolean {
  return providerID === GROK_PROVIDER_ID;
}

export function grokAuthPath(home: string): string {
  return join(home, '.grok', 'auth.json');
}

export function configureGrokHome(credential: string, home: string): GrokRuntime {
  const content = credential.trim();
  if (!content) {
    throw new Error(
      'Missing Grok credential. Set grok-auth/GROK_AUTH_JSON or xai-api-key/XAI_API_KEY.',
    );
  }
  const accountAuth = content.startsWith('{') || content.startsWith('[');
  let parsed: unknown;
  if (accountAuth) {
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Invalid GROK_AUTH_JSON: expected the JSON contents of ~/.grok/auth.json.');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Invalid GROK_AUTH_JSON: expected a JSON object.');
    }
  }

  const dir = join(home, '.grok');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.toml'), GROK_CONFIG, { mode: 0o600 });
  if (!accountAuth) return { home, authMode: 'api-key', apiKey: content };

  const path = grokAuthPath(home);
  writeFileSync(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return { home, authMode: 'account', authPath: path };
}

export interface GrokCliArgsInput {
  model: string;
  promptFile: string;
}

export function buildGrokCliArgs(input: GrokCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    '--sandbox',
    'strict',
    '--permission-mode',
    'dontAsk',
    '--no-memory',
    '--no-subagents',
    '--disable-web-search',
    '--no-plan',
    '--verbatim',
    '--tools',
    '',
    '--disallowed-tools',
    'Bash,Edit,Read,Grep,MCPTool,WebFetch',
    '--max-turns',
    String(GROK_MAX_TURNS),
    '--prompt-file',
    input.promptFile,
    '--output-format',
    'plain',
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  return args;
}

const GROK_ENV_KEYS = [
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

export function grokEnvForHome(home: string | undefined, apiKey?: string): NodeJS.ProcessEnv {
  const value = home?.trim();
  if (!value) {
    throw new Error('Missing Grok home. A temp HOME is required for auth.');
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of GROK_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = value;
  env.GROK_HOME = join(value, '.grok');
  if (apiKey) env.XAI_API_KEY = apiKey;
  return env;
}

export function buildGrokPrompt(prompt: string): string {
  return `${NO_TOOLS_REVIEW_DIRECTIVE}\n\n${prompt}`;
}

export function assertGrokPromptWithinBudget(label: string, prompt: string): void {
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > GROK_MAX_PROMPT_BYTES) {
    throw new Error(
      `grok ${label} prompt is ${promptBytes} bytes, over the ${GROK_MAX_PROMPT_BYTES}-byte Grok prompt budget`,
    );
  }
}

export function formatGrokPromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `grok ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}

export function isGrokModelsAuthenticated(output: string): boolean {
  return !/\bnot authenticated\b/i.test(output);
}

export async function assertGrokAuthenticated(runtime: GrokRuntime): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-grok-auth-check-'));
  try {
    const result = await spawnWithTimeout(GROK_CLI_BIN, ['--sandbox', 'strict', 'models'], {
      cwd: dir,
      env: grokEnvForHome(
        runtime.home,
        runtime.authMode === 'api-key' ? runtime.apiKey : undefined,
      ),
      timeoutMs: GROK_AUTH_CHECK_TIMEOUT_MS,
      timeoutMessage: 'Grok authentication check timed out after 30s.',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.exitCode !== 0) {
      throw new Error(`Grok authentication check failed (exit ${result.exitCode}).`);
    }
    if (!isGrokModelsAuthenticated(output)) {
      throw new Error(
        runtime.authMode === 'account'
          ? 'Grok authentication is invalid or expired. Run `grok login --device-auth`, then refresh GROK_AUTH_JSON.'
          : 'Grok API-key authentication failed. Check XAI_API_KEY or xai-api-key.',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function runGrokReview(
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
    runtime?: GrokRuntime;
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
  log(`Prompt assembled (${label}, grok): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runGrokPrompt(model, prompt, label, log, options.runtime, options.timeoutMs);
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via grok: ${message}`);
    const repaired = await runGrokPrompt(
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: GROK_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: GROK_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.runtime,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runGrokAddressedPriorCommentsCheck(
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: GrokRuntime,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runGrokPrompt(
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    runtime,
    timeoutMs,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runGrokGuidelineComplianceCheck(
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: GrokRuntime,
): Promise<Finding[]> {
  void onTokenUsage;
  const raw = await runGrokPrompt(
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    runtime,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runGrokChangesSinceLastReview(
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: GrokRuntime,
): Promise<string> {
  void onTokenUsage;
  const raw = await runGrokPrompt(
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    runtime,
    timeoutMs,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runGrokFindingVerification(
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: GrokRuntime,
): Promise<FindingVerdict[] | undefined> {
  void onTokenUsage;
  const raw = await runGrokPrompt(
    model,
    assembleFindingVerificationPrompt(prContext, findings, true),
    'finding-verification',
    log,
    runtime,
    timeoutMs,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runGrokPrompt(
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  runtime: GrokRuntime | undefined,
  timeoutMs = GROK_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const fullPrompt = buildGrokPrompt(prompt);
  assertGrokPromptWithinBudget(label, fullPrompt);
  const env = grokEnvForHome(
    runtime?.home,
    runtime?.authMode === 'api-key' ? runtime.apiKey : undefined,
  );
  const dir = mkdtempSync(join(tmpdir(), 'jbot-grok-'));
  const reviewWorkspace = join(dir, 'workspace');
  const promptFile = join(reviewWorkspace, 'prompt.txt');
  mkdirSync(reviewWorkspace, { mode: 0o700 });
  writeFileSync(promptFile, fullPrompt, { mode: 0o400 });
  chmodSync(reviewWorkspace, 0o500);
  log(`Calling ${label} prompt (agent=grok-cli, model=${model})`);
  try {
    const result = await spawnWithTimeout(GROK_CLI_BIN, buildGrokCliArgs({ model, promptFile }), {
      cwd: reviewWorkspace,
      env,
      timeoutMs,
      timeoutMessage: formatGrokPromptTimeoutMessage(label, model, timeoutMs),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `grok ${label} exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    const finalMessage = result.stdout.trim();
    log(
      `${label} prompt complete via grok: stdout=${result.stdout.length} chars stderr=${result.stderr.length} chars`,
    );
    if (!finalMessage) {
      throw new Error(
        `grok ${label} produced no final message; stderr: ${truncateForLog(result.stderr, 1000)}`,
      );
    }
    return finalMessage;
  } finally {
    try {
      chmodSync(reviewWorkspace, 0o700);
    } catch {
      // The temp parent is still removed below; chmod is only cleanup hardening.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
