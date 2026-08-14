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
import { isFiniteNumber, isRecord } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const COMMANDCODE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const COMMANDCODE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const COMMANDCODE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const COMMANDCODE_MODEL_LIST_TIMEOUT_MS = 60_000;
// Print mode defaults to 10; keep the wall-clock timeout as the practical bound.
const COMMANDCODE_MAX_TURNS = 1000;

export const COMMANDCODE_PROVIDER_ID = 'commandcode';
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
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}

export interface CommandCodeCliArgsInput {
  model: string;
}

export function buildCommandCodeCliArgs(input: CommandCodeCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    '-p',
    // Trust only skips the project-trust prompt for headless runs; plan mode
    // keeps the session read-only.
    '--trust',
    '--skip-onboarding',
    '--no-auto-update',
    '--output-format',
    'json',
    '--permission-mode',
    'plan',
    '--max-turns',
    String(COMMANDCODE_MAX_TURNS),
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  return args;
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
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    home?: string;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
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

export function parseCommandCodeJsonOutput(output: string): {
  finalText: string;
  sessionId?: string;
  usage?: PromptTokenUsage;
} {
  let result: Record<string, unknown> | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new Error(`CommandCode returned invalid JSON output: ${truncateForLog(line, 1000)}`);
    }
    if (isRecord(frame) && frame.type === 'result') result = frame;
  }
  if (!result) throw new Error('CommandCode JSON output contained no result frame');
  if (result.subtype !== 'success') {
    throw new Error(`CommandCode JSON result was ${String(result.subtype ?? 'unknown')}`);
  }
  if (typeof result.finalText !== 'string') {
    throw new Error('CommandCode JSON result contained no finalText');
  }
  const usage = parseCommandCodeUsage(result.usage);
  return {
    finalText: result.finalText,
    ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {}),
    ...(usage ? { usage } : {}),
  };
}

export function parseCommandCodeSessionEstimatedCost(jsonl: string): number | undefined {
  let total: number | undefined;
  for (const line of jsonl.split(/\r?\n/)) {
    const cost = parseCommandCodeSessionEntryEstimatedCost(line);
    if (cost !== undefined) total = (total ?? 0) + cost;
  }
  return total;
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
): Promise<string> {
  const args = buildCommandCodeCliArgs({ model });
  log(`Calling ${label} prompt (agent=commandcode-cli, model=${model})`);
  const result = await spawnWithTimeout(COMMANDCODE_CLI_BIN, args, {
    cwd: workspace,
    input: prompt,
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
