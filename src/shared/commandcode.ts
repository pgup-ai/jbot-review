import { chmodSync, createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { parseModelName } from '@symma/protocol';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  withNoToolsReviewDirective,
  type VerifiableFinding,
} from './prompt.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  type PromptTokenUsage,
  type TokenUsageRecorder,
} from './opencode.ts';
import { spawnWithTimeout, truncateForLog } from '@symma/protocol';
import { clampReasoningEffort } from './config.ts';
import { isFiniteNumber, isRecord } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const COMMANDCODE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const COMMANDCODE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const COMMANDCODE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const COMMANDCODE_MODEL_LIST_TIMEOUT_MS = 60_000;
// Keep the wall-clock timeout as the practical bound for long reviews.
const COMMANDCODE_MAX_TURNS = 1000;

export const COMMANDCODE_PROVIDER_ID = 'commandcode';
export const COMMANDCODE_TELEMETRY_CAPABILITY = 'opaque' as const;
export const COMMANDCODE_MODEL_LIST_ARGS = ['--no-auto-update', '--list-models'];
// The command-code npm package exposes cmd, cmdc, commandcode, and command-code.
// Use the long alias so Windows local runs do not accidentally invoke cmd.exe.
export const COMMANDCODE_CLI_BIN = 'command-code';

export type CommandCodePromptFailureKind = 'rate_limit' | 'usage_exceeded';

export function isCommandCodeProvider(providerID: string): boolean {
  return providerID === COMMANDCODE_PROVIDER_ID;
}

export function commandCodeAuthPath(home = process.env.HOME || homedir()): string {
  return join(home, '.commandcode', 'auth.json');
}

function chmodCommandCodeFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
}

export function writeCommandCodeAuth(
  accessKey: string,
  home = process.env.HOME || homedir(),
): string {
  const key = accessKey.trim();
  if (!key) {
    throw new Error(
      'Missing CommandCode access key. Set commandcode-access-key or COMMANDCODE_ACCESS_KEY.',
    );
  }

  const path = commandCodeAuthPath(home);
  mkdirSync(join(home, '.commandcode'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ apiKey: key }, null, 2)}\n`, { mode: 0o600 });
  chmodCommandCodeFile(path);
  return path;
}

export function writeCommandCodeReadOnlySettings(home: string): string {
  const path = join(home, '.commandcode', 'settings.json');
  mkdirSync(join(home, '.commandcode'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ permissions: { deny: ['*'] } }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodCommandCodeFile(path);
  return path;
}

export interface CommandCodeCliArgsInput {
  model: string;
  effort?: string;
}

export function buildCommandCodeCliArgs(input: CommandCodeCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    '-p',
    // Trust only skips the project-trust prompt for headless runs; plan mode
    // keeps the session read-only.
    '--trust',
    '--skip-onboarding',
    '--no-skills',
    '--no-auto-update',
    '--output-format',
    'json',
    '--permission-mode',
    'plan',
    '--max-turns',
    String(COMMANDCODE_MAX_TURNS),
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  if (input.effort) args.push('--effort', input.effort);
  return args;
}

// Probed 2026-08-22: `--effort` validates per model and exits nonzero on
// values outside the model's set; muse-spark rejects the flag outright.
const COMMANDCODE_MODEL_EFFORTS: Record<string, readonly string[]> = {
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'meta/muse-spark-1.2-contributor': [],
};

/**
 * The `--effort` value for a session; undefined omits the flag. An explicit
 * effort clamps to the nearest declared tier (one knob: "low" means "as low
 * as this model goes"); the built-in defaults deliver only on an exact
 * match, so a default `medium` is never silently promoted to a `high` floor.
 */
function commandCodeReasoningEffort(
  model: string,
  modelOptions: Record<string, unknown> | undefined,
  explicit: boolean,
): string | undefined {
  const { modelID } = parseModelName(model);
  const effort = modelOptions?.reasoningEffort;
  const supported = COMMANDCODE_MODEL_EFFORTS[modelID];
  if (typeof effort !== 'string' || !supported?.length) return undefined;
  if (supported.includes(effort)) return effort;
  return explicit ? clampReasoningEffort(effort, supported) : undefined;
}

/**
 * Role-aware effort for one session: aux sessions run the built-in aux
 * defaults (never clamped); main options and the verifier's floored
 * override carry user intent, so they clamp when the options are explicit.
 */
export function commandCodeSessionEffort(
  model: string,
  override: Record<string, unknown> | undefined,
  ctx: {
    auxModel: string;
    auxModelOptions?: Record<string, unknown>;
    mainModelOptions?: Record<string, unknown>;
    explicit: boolean;
  },
): string | undefined {
  const auxCall =
    override === undefined && model === ctx.auxModel && ctx.auxModelOptions !== undefined;
  return commandCodeReasoningEffort(
    model,
    override ?? (auxCall ? ctx.auxModelOptions : ctx.mainModelOptions),
    !auxCall && ctx.explicit,
  );
}

export async function runCommandCodeReview(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  options: {
    lensAddendum?: string;
    evidenceQuotes?: boolean;
    embeddedFirstPrompt?: boolean;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    home?: string;
    effort?: string;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
    options.embeddedFirstPrompt ?? false,
  );
  log(
    `Prompt assembled (${label}, commandcode): ${prompt.length} chars, guidelines=${!!guidelines}`,
  );
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.timeoutMs,
    options.onTokenUsage,
    options.home,
    options.effort,
  );
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `${label} response unparseable; sending one JSON repair prompt via commandcode: ${message}`,
    );
    const repaired = await runCommandCodePrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: COMMANDCODE_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: COMMANDCODE_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.timeoutMs,
      options.onTokenUsage,
      options.home,
      options.effort,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runCommandCodeAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
  effort?: string,
): Promise<AddressedPriorComment[]> {
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    timeoutMs,
    onTokenUsage,
    home,
    effort,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runCommandCodeGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
  effort?: string,
): Promise<Finding[]> {
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    timeoutMs,
    onTokenUsage,
    home,
    effort,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runCommandCodeChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
  effort?: string,
): Promise<string> {
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    timeoutMs,
    onTokenUsage,
    home,
    effort,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runCommandCodeFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
  effort?: string,
): Promise<FindingVerdict[] | undefined> {
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    timeoutMs,
    onTokenUsage,
    home,
    effort,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

export async function listCommandCodeModels(workspace: string, home?: string): Promise<string[]> {
  const result = await spawnWithTimeout(COMMANDCODE_CLI_BIN, COMMANDCODE_MODEL_LIST_ARGS, {
    cwd: workspace,
    input: '',
    env: commandCodeEnvForHome(home),
    timeoutMs: COMMANDCODE_MODEL_LIST_TIMEOUT_MS,
    timeoutMessage: `commandcode model listing timed out after ${Math.round(
      COMMANDCODE_MODEL_LIST_TIMEOUT_MS / 1000,
    )}s`,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `commandcode model listing exited ${result.exitCode}: ${truncateForLog(
        result.stderr || result.stdout,
        1000,
      )}`,
    );
  }
  return parseCommandCodeModelList(result.stdout);
}

export function parseCommandCodeModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^([A-Za-z0-9._/-]+)\s{2,}\S/);
    if (match) models.push(match[1]);
  }
  return models;
}

export function classifyCommandCodePromptFailure(
  output: string,
): CommandCodePromptFailureKind | undefined {
  const normalized = output.toLowerCase();
  if (
    /\brate[\s_-]?limit(?:ed|s|ing)?(?:[\s_-]?(?:exceeded|error|hit|reached))?\b/.test(
      normalized,
    ) ||
    /\b429\b/.test(normalized) ||
    /\bthrottl(?:e|ed|ing)\b/.test(normalized) ||
    normalized.includes('too many requests') ||
    normalized.includes('retry-after')
  ) {
    return 'rate_limit';
  }
  if (
    /\busage[\s_-]exceeded\b/.test(normalized) ||
    normalized.includes('usage limit') ||
    normalized.includes('credits exhausted') ||
    normalized.includes('insufficient credits') ||
    /\bquota[\s_-]exceeded\b/.test(normalized)
  ) {
    return 'usage_exceeded';
  }
  return undefined;
}

function parseCommandCodeUsage(value: unknown): PromptTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [
    value.inputTokens,
    value.outputTokens,
    value.cacheReadTokens,
    value.cacheWriteTokens,
  ];
  if (!fields.every((field) => isFiniteNumber(field) && field >= 0)) return undefined;
  const [input, output, cacheRead, cacheWrite] = fields as number[];
  return { input, output, reasoning: 0, cacheRead, cacheWrite };
}

function parseCommandCodeJsonString(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function recoverCommandCodeRunEnd(line: string): Record<string, unknown> | undefined {
  const prefix =
    /^\{\s*"type"\s*:\s*"event"\s*,\s*"event"\s*:\s*\{\s*"type"\s*:\s*"run_end"\s*,\s*"result"\s*:\s*\{\s*"finalText"\s*:\s*("(?:\\.|[^"\\])*")/.exec(
      line,
    );
  if (!prefix) return undefined;
  const finalText = parseCommandCodeJsonString(prefix[1]);
  if (finalText === undefined) return undefined;

  let usage: unknown;
  const remainder = line.slice(prefix[0].length);
  const usageMatch = /,\s*"usage"\s*:\s*(\{[^{}]*\})/.exec(remainder);
  if (usageMatch) {
    try {
      usage = JSON.parse(usageMatch[1]);
    } catch {
      usage = undefined;
    }
  }
  const nextState = /,\s*"nextState"\s*:\s*\{\s*"sessionId"\s*:\s*("(?:\\.|[^"\\])*")/.exec(
    remainder,
  );
  const sessionId = nextState ? parseCommandCodeJsonString(nextState[1]) : undefined;
  return { finalText, ...(usage ? { usage } : {}), ...(sessionId ? { sessionId } : {}) };
}

export function parseCommandCodeJsonOutput(output: string): {
  finalText: string;
  sessionId?: string;
  usage?: PromptTokenUsage;
} {
  let result: Record<string, unknown> | undefined;
  let recoveredRunEnd: Record<string, unknown> | undefined;
  let invalidLine: string | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      invalidLine ??= line;
      recoveredRunEnd ??= recoverCommandCodeRunEnd(line);
      continue;
    }
    if (!isRecord(frame)) continue;
    if (frame.type === 'result') result = frame;
  }
  const finalResult = result ?? recoveredRunEnd;
  if (!finalResult) {
    if (invalidLine) {
      throw new Error(
        `CommandCode returned invalid JSON output: ${truncateForLog(invalidLine, 1000)}`,
      );
    }
    throw new Error('CommandCode JSON output contained no result frame');
  }
  if (result && result.subtype !== 'success') {
    throw new Error(`CommandCode JSON result was ${String(result.subtype ?? 'unknown')}`);
  }
  if (typeof finalResult.finalText !== 'string') {
    throw new Error('CommandCode JSON result contained no finalText');
  }
  const usage = parseCommandCodeUsage(finalResult.usage);
  return {
    finalText: finalResult.finalText,
    ...(typeof finalResult.sessionId === 'string' ? { sessionId: finalResult.sessionId } : {}),
    ...(usage ? { usage } : {}),
  };
}

function parseCommandCodeSessionEntryEstimatedCost(line: string): number | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry: unknown = JSON.parse(line);
    if (
      !isRecord(entry) ||
      entry.type !== 'message' ||
      !isRecord(entry.message) ||
      entry.message.role !== 'assistant' ||
      !isRecord(entry.usage)
    ) {
      return undefined;
    }
    const cost = entry.usage.costUsd;
    return isFiniteNumber(cost) && cost >= 0 ? cost : undefined;
  } catch {
    return undefined;
  }
}

export async function commandCodeSessionEstimatedCost(
  home: string,
  sessionId: string,
): Promise<number | undefined> {
  try {
    const root = join(home, '.commandcode', 'projects');
    const filename = `${sessionId}.jsonl`;
    const directory = await opendir(root, { recursive: true });
    let transcript: string | undefined;
    for await (const entry of directory) {
      if (entry.isFile() && entry.name === filename) {
        transcript = join(entry.parentPath, entry.name);
        break;
      }
    }
    if (!transcript) return undefined;

    let total: number | undefined;
    const lines = createInterface({ input: createReadStream(transcript), crlfDelay: Infinity });
    for await (const line of lines) {
      const cost = parseCommandCodeSessionEntryEstimatedCost(line);
      if (cost !== undefined) total = (total ?? 0) + cost;
    }
    return total;
  } catch {
    return undefined;
  }
}

async function runCommandCodePrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = COMMANDCODE_PROMPT_TIMEOUT_MS,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
  effort?: string,
): Promise<string> {
  const args = buildCommandCodeCliArgs({ model, effort });
  log(
    `Calling ${label} prompt (agent=commandcode-cli, model=${model}${effort ? `, effort=${effort}` : ''})`,
  );
  const result = await spawnWithTimeout(COMMANDCODE_CLI_BIN, args, {
    cwd: workspace,
    input: withNoToolsReviewDirective(prompt),
    env: commandCodeEnvForHome(home),
    timeoutMs,
    timeoutMessage: formatCommandCodePromptTimeoutMessage(label, model, timeoutMs),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      formatCommandCodePromptFailure(label, result.exitCode, result.stderr || result.stdout),
    );
  }
  const parsed = parseCommandCodeJsonOutput(result.stdout);
  const estimatedCostUsd =
    home && parsed.sessionId
      ? await commandCodeSessionEstimatedCost(home, parsed.sessionId)
      : undefined;
  const usage = parsed.usage
    ? {
        ...parsed.usage,
        ...(isFiniteNumber(estimatedCostUsd) ? { estimatedCostUsd } : {}),
      }
    : undefined;
  if (usage) {
    log(
      `${label} tokens: input=${usage.input} output=${usage.output} reasoning=${usage.reasoning} cache(read=${usage.cacheRead} write=${usage.cacheWrite})${
        isFiniteNumber(usage.estimatedCostUsd)
          ? ` estimated-cost=$${usage.estimatedCostUsd.toFixed(4)}`
          : ''
      }`,
    );
    onTokenUsage?.(usage, model, label);
  }
  log(
    `${label} prompt complete via commandcode: result=${parsed.finalText.length} chars stderr=${result.stderr.length} chars`,
  );
  return parsed.finalText;
}

function formatCommandCodePromptFailure(
  label: string,
  exitCode: number | null,
  output: string,
): string {
  const kind = classifyCommandCodePromptFailure(output);
  const suffix = kind ? ` (${kind.replace('_', ' ')})` : '';
  return `commandcode ${label} exited ${exitCode}${suffix}: ${truncateForLog(output, 1000)}`;
}

export function formatCommandCodePromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `commandcode ${label} prompt timed out after ${Math.round(
    timeoutMs / 1000,
  )}s (model=${model})`;
}

export function commandCodeEnvForHome(home: string | undefined): NodeJS.ProcessEnv | undefined {
  if (!home) return undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  // CommandCode gives this env var precedence over ~/.commandcode/auth.json.
  // The action input writes temp auth.json, so prevent ambient CI/local state
  // from overriding the selected credential.
  delete env.COMMAND_CODE_API_KEY;
  return env;
}

// The same alpha endpoint the pinned CLI's /usage view reads (fetchUsageData
// in its bundle), Bearer-authed with the access key. Alpha API: every shape
// drift parses to undefined — usage visibility must never fail a run.
const COMMANDCODE_USAGE_URL = 'https://api.commandcode.ai/alpha/billing/credits';
const COMMANDCODE_USAGE_TIMEOUT_MS = 4_000;

interface CommandCodeUsageWindow {
  used: number;
  cap: number;
  resetAt: number;
  exceeded: boolean;
}

export interface CommandCodePlanUsage {
  /** Included plan credits REMAINING this billing period. */
  monthlyCredits: number;
  /** Pay-as-you-go balance overage draws from once the plan runs out. */
  purchasedCredits: number;
  fiveHour?: CommandCodeUsageWindow;
  weekly?: CommandCodeUsageWindow;
}

export function parseCommandCodePlanUsage(payload: unknown): CommandCodePlanUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.credits)) return undefined;
  const { monthlyCredits, purchasedCredits } = payload.credits;
  if (!isFiniteNumber(monthlyCredits)) return undefined;
  // Only ABSENT fields degrade (older shapes); a present-but-invalid field is
  // drift and poisons the whole payload — a partial line would render trusted-
  // looking meters while hiding a real limit.
  if (purchasedCredits != null && !isFiniteNumber(purchasedCredits)) return undefined;
  const { windowLimits } = payload;
  if (windowLimits != null && !isRecord(windowLimits)) return undefined;
  const limits = isRecord(windowLimits) ? windowLimits : undefined;
  // null = present but malformed; undefined = absent.
  const windowOf = (value: unknown): CommandCodeUsageWindow | null | undefined => {
    if (value == null) return undefined;
    if (!isRecord(value)) return null;
    const { used, cap, resetAt, exceeded } = value;
    if (!isFiniteNumber(used) || used < 0 || !isFiniteNumber(cap) || cap <= 0) return null;
    if (!isFiniteNumber(resetAt) || typeof exceeded !== 'boolean') return null;
    return { used, cap, resetAt, exceeded };
  };
  const fiveHour = windowOf(limits?.fiveHour);
  const weekly = windowOf(limits?.weekly);
  if (fiveHour === null || weekly === null) return undefined;
  return {
    monthlyCredits,
    purchasedCredits: isFiniteNumber(purchasedCredits) ? purchasedCredits : 0,
    fiveHour,
    weekly,
  };
}

export function formatCommandCodePlanUsage(usage: CommandCodePlanUsage, now: number): string {
  const meter = (label: string, window?: CommandCodeUsageWindow): string | undefined => {
    if (!window) return undefined;
    const percent = (window.used / window.cap) * 100;
    // Sub-percent spend must stay distinguishable from a meter at zero.
    const percentLabel = percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`;
    return `${label} ${window.used.toFixed(1)}/${window.cap} (${percentLabel}${
      window.exceeded ? ', EXCEEDED' : ''
    }, resets in ${formatShortDuration(Math.max(window.resetAt - now, 0))})`;
  };
  const windows = [meter('5h', usage.fiveHour), meter('weekly', usage.weekly)]
    .filter(Boolean)
    .join(', ');
  const purchased =
    usage.purchasedCredits > 0 ? ` + ${usage.purchasedCredits.toFixed(1)} purchased` : '';
  return `CommandCode plan usage: ${windows ? `${windows}; ` : ''}${usage.monthlyCredits.toFixed(1)} plan credits remaining${purchased}.`;
}

function formatShortDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** One log line of live plan usage, or undefined on ANY failure — never throws. */
export async function fetchCommandCodePlanUsageLine(
  accessKey: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(COMMANDCODE_USAGE_URL, {
      headers: { Authorization: `Bearer ${accessKey}` },
      signal: AbortSignal.timeout(COMMANDCODE_USAGE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const usage = parseCommandCodePlanUsage(await response.json());
    return usage && formatCommandCodePlanUsage(usage, Date.now());
  } catch {
    return undefined;
  }
}
