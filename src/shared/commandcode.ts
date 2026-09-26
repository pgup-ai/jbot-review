import type { NativeEvidenceStore } from './native-evidence.ts';
import { measureReviewPrompt, reviewPromptBudget } from './review-plan.ts';
import {
  commandCodeToolOutcome,
  parseCommandCodeUsage,
  parseCommandCodeBenchmark,
  createCommandCodeProgress,
  type CommandCodeProgress,
} from './commandcode-progress.ts';
import {
  chmodSync,
  createReadStream,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { opendir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { appendGuidelineSweep, type GuidelineSweep } from './guideline-sweep.ts';
import { parseModelName } from '@symma/protocol';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleGuidelineSweepPrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  withNoToolsReviewDirective,
  withCommandCodeToolsDirective,
  type VerifiableFinding,
} from './prompt.ts';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  sessionEnvDenyKeys,
  type PromptTokenUsage,
  type TokenUsageRecorder,
} from './opencode.ts';
import { truncateForLog } from '@symma/protocol';
import { runCliProcess } from './cli-process.ts';
import { clampReasoningEffort } from './config.ts';
import {
  formatShortDuration,
  isFiniteNumber,
  isNonArrayRecord,
  isRecord,
  percentLabel,
} from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';
import { IncompleteReviewError } from './types.ts';

const COMMANDCODE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const COMMANDCODE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const COMMANDCODE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
// Keep the wall-clock timeout as the practical bound for long reviews.
const COMMANDCODE_MAX_TURNS = 1000;

// Context windows from the pinned CommandCode 1.66.0 catalog.
export const COMMANDCODE_MODEL_LIMITS: Record<string, { contextTokens: number }> = {
  'xiaomi/mimo-v2.6-pro': { contextTokens: 1_048_576 },
  'xiaomi/mimo-v2.6-pro-ultraspeed': { contextTokens: 1_048_576 },
  'xiaomi/mimo-v2.6-flash': { contextTokens: 1_048_576 },
  'meta/muse-spark-1.3-contributor': { contextTokens: 1_048_576 },
  'meta/muse-spark-1.3': { contextTokens: 1_048_576 },
  'gpt-5.6-luna': { contextTokens: 1_050_000 },
  'qwen/qwen3.8-omni-flash': { contextTokens: 1_000_000 },
  'z-ai/glm-5.3-flashx': { contextTokens: 1_000_000 },
  'deepseek/deepseek-v4-flash-fast': { contextTokens: 1_000_000 },
  'deepseek/deepseek-v4-flash': { contextTokens: 1_000_000 },
  'deepseek/deepseek-v4.1-flash': { contextTokens: 1_000_000 },
  'stealth/pixel-canary': { contextTokens: 262_144 },
  'stealth/space-bunny-alpha': { contextTokens: 1_000_000 },
};

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

export function writeCommandCodeReadOnlySettings(home: string, workspace?: string): string {
  const path = join(home, '.commandcode', 'settings.json');
  mkdirSync(join(home, '.commandcode'), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    `${JSON.stringify({ tasteLearning: false, permissions: workspace ? { defaultMode: 'plan', additionalDirectories: [workspace] } : { deny: ['*'] } }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  chmodCommandCodeFile(path);
  mkdirSync(join(home, 'launch'), { mode: 0o700, recursive: true });
  return path;
}

export interface CommandCodeRuntime {
  home: string;
  tools: boolean;
  evidence?: NativeEvidenceStore;
  onProgress?: (label: string, model: string, progress: CommandCodeProgress) => void;
}

export interface CommandCodeCliArgsInput {
  model: string;
  effort?: string;
}

export function buildCommandCodeCliArgs(input: CommandCodeCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    '-p',
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

// The CLI rejects efforts outside its model catalog. Unsupported built-in
// defaults use the lowest supported tier; empty tiers mean no effort control.
const COMMANDCODE_MODEL_EFFORTS: Record<string, { tiers: readonly string[]; fallback?: string }> = {
  'deepseek/deepseek-v4-flash': { tiers: ['high', 'max'], fallback: 'high' },
  'deepseek/deepseek-v4.1-flash': { tiers: ['low', 'high', 'max'], fallback: 'low' },
  'deepseek/deepseek-v4-flash-fast': { tiers: ['low', 'high', 'max'], fallback: 'low' },
  'gpt-5.6-luna': { tiers: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'meta/muse-spark-1.3': { tiers: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'meta/muse-spark-1.2-contributor': { tiers: ['low', 'medium', 'high', 'xhigh'] },
  'meta/muse-spark-1.3-contributor': { tiers: ['low', 'medium', 'high', 'xhigh'] },
  'qwen/qwen3.8-omni-flash': { tiers: ['low', 'medium', 'xhigh'] },
  'stealth/pixel-canary': { tiers: ['low', 'medium', 'xhigh'] },
  'stealth/space-bunny-alpha': { tiers: ['low', 'medium', 'high'] },
  // CLI 1.66.0 exposes no adjustable effort for MiMo v2.6.
  'xiaomi/mimo-v2.6-flash': { tiers: [] },
  'xiaomi/mimo-v2.6-pro': { tiers: [] },
  'xiaomi/mimo-v2.6-pro-ultraspeed': { tiers: [] },
  'z-ai/glm-5.3-flash': { tiers: ['low', 'high', 'max'], fallback: 'low' },
  'z-ai/glm-5.3-flashx': { tiers: ['low', 'high', 'max'], fallback: 'low' },
  'zai-org/glm-5.3': { tiers: ['low', 'high', 'max'], fallback: 'low' },
};

/**
 * Unknown models keep the CLI default. Unsupported built-in efforts use the
 * catalog fallback; explicit efforts clamp to the nearest declared tier.
 */
function commandCodeReasoningEffort(
  model: string,
  modelOptions: Record<string, unknown> | undefined,
  explicit: boolean,
): string | undefined {
  const { modelID } = parseModelName(model);
  const effort = modelOptions?.reasoningEffort;
  const entry = COMMANDCODE_MODEL_EFFORTS[modelID];
  if (typeof effort !== 'string' || !entry?.tiers.length) return undefined;
  if (entry.tiers.includes(effort)) return effort;
  return explicit ? clampReasoningEffort(effort, entry.tiers) : entry.fallback;
}

/**
 * Role-aware effort for one session: aux sessions run the built-in aux
 * defaults; main options clamp when explicit; the verifier (an override) runs
 * one ladder step below the tier the finder lands on here, floored at the
 * ladder's lowest, so a `max` request on a ladder ending at `xhigh` puts the
 * finder on `xhigh` and the verifier below it rather than beside it. Only the
 * override's presence is read: its rank-derived tier (config.ts) cannot see
 * this ladder.
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
  if (override) {
    const finder = commandCodeReasoningEffort(model, ctx.mainModelOptions, ctx.explicit);
    const tiers = COMMANDCODE_MODEL_EFFORTS[parseModelName(model).modelID]?.tiers;
    return finder && tiers ? tiers[Math.max(0, tiers.indexOf(finder) - 1)] : undefined;
  }
  const auxCall = model === ctx.auxModel && ctx.auxModelOptions !== undefined;
  return commandCodeReasoningEffort(
    model,
    auxCall ? ctx.auxModelOptions : ctx.mainModelOptions,
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
    guidelineSweep?: GuidelineSweep;
    lensAddendum?: string;
    contextFirst?: boolean;
    contextPack?: boolean;
    evidenceQuotes?: boolean;
    embeddedFirstPrompt?: boolean;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    runtime?: CommandCodeRuntime;
    effort?: string;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const deadlineAt = Date.now() + (options.timeoutMs ?? COMMANDCODE_PROMPT_TIMEOUT_MS);
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
    options.embeddedFirstPrompt ?? false,
    {
      toolsAvailable: Boolean(options.runtime?.tools),
      contextFirst: options.contextFirst,
      contextPack: options.contextPack,
    },
  );
  log(
    `Prompt assembled (${label}, commandcode): ${prompt.length} chars, guidelines=${!!guidelines}`,
  );
  const { finalText: raw, sessionId } = await runCommandCodePrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.timeoutMs,
    options.onTokenUsage,
    options.runtime,
    options.effort,
  );
  let result: ReviewResult;
  try {
    result = parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw error;
    log(
      `${label} response unparseable; sending one JSON repair prompt via commandcode: ${message}`,
    );
    const { finalText: repaired } = await runCommandCodePrompt(
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
      remaining,
      options.onTokenUsage,
      options.runtime,
      options.effort,
    );
    result = parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
  if (options.guidelineSweep) {
    const sweep = options.guidelineSweep;
    const sweepLabel = `guideline-sweep-${label}`;
    result = await appendGuidelineSweep(
      result,
      sweep,
      sweepLabel,
      deadlineAt,
      async (timeoutMs) => {
        if (!sessionId) throw new Error('CommandCode main review returned no session ID.');
        const { finalText } = await runCommandCodePrompt(
          workspace,
          model,
          assembleGuidelineSweepPrompt(sweep.guidelines),
          sweepLabel,
          log,
          timeoutMs,
          options.onTokenUsage,
          options.runtime,
          options.effort,
          sessionId,
        );
        return parseReview(finalText, sweepLabel, log, { strict: true }).findings;
      },
      log,
    );
  }
  if (options.runtime?.evidence && sessionId) {
    try {
      const path = await commandCodeTranscriptPath(options.runtime.home, sessionId);
      if (!path || statSync(path).size > 16 * 1024 * 1024) throw new Error('unavailable');
      const stats = await options.runtime.evidence.observe(readFileSync(path, 'utf8'));
      log(`Packed handoff observed (${label}): ${JSON.stringify(stats)}`);
    } catch {
      log(`Packed handoff observed (${label}): unavailable`);
    }
  }
  return result;
}

async function runCommandCodeAuxReview(
  field: 'findings' | 'addressedPriorComments',
  ...args: Parameters<typeof runCommandCodePrompt>
): Promise<ReviewResult> {
  const [workspace, model, prompt, label, log, timeoutMs, onTokenUsage, runtime, effort] = args;
  const deadline = Date.now() + (timeoutMs ?? COMMANDCODE_PROMPT_TIMEOUT_MS);
  const { finalText } = await runCommandCodePrompt(...args);
  try {
    return parseReview(finalText, label, log, { strict: true, field });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw error;
    log(
      `${label} response unparseable; sending one JSON repair prompt via commandcode: ${message}`,
    );
    const repaired = await runCommandCodePrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: finalText,
        parseError: message,
        promptBudgetBytes: COMMANDCODE_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: COMMANDCODE_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      remaining,
      onTokenUsage,
      runtime,
      effort,
    );
    return parseReview(repaired.finalText, `${label}-repair`, log, { strict: true, field });
  }
}

export async function runCommandCodeAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: CommandCodeRuntime,
  effort?: string,
): Promise<AddressedPriorComment[]> {
  const result = await runCommandCodeAuxReview(
    'addressedPriorComments',
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    timeoutMs,
    onTokenUsage,
    runtime,
    effort,
  );
  return result.addressedPriorComments;
}

export async function runCommandCodeGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: CommandCodeRuntime,
  effort?: string,
): Promise<Finding[]> {
  const result = await runCommandCodeAuxReview(
    'findings',
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    timeoutMs,
    onTokenUsage,
    runtime,
    effort,
  );
  return result.findings;
}

export async function runCommandCodeChangesSinceLastReview(
  workspace: string,
  model: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: CommandCodeRuntime,
  effort?: string,
): Promise<string> {
  const { finalText: raw } = await runCommandCodePrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(deltaContext, true),
    'changes-since-last-review',
    log,
    timeoutMs,
    onTokenUsage,
    runtime,
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
  runtime?: CommandCodeRuntime,
  effort?: string,
): Promise<FindingVerdict[] | undefined> {
  const started = Date.now();
  // Reserve 30 seconds for verification after the 1.5-second optional preparation.
  if (runtime?.evidence && (timeoutMs === undefined || timeoutMs > 31_500)) {
    try {
      const { packet, stats } = await runtime.evidence.prepare(findings, prContext);
      const enriched = packet ? `${prContext}\n\n${packet}` : prContext;
      const fits = measureReviewPrompt(
        withCommandCodeToolsDirective(
          assembleFindingVerificationPrompt(enriched, findings),
          workspace,
        ),
        reviewPromptBudget(
          'commandcode',
          COMMANDCODE_MODEL_LIMITS[model.replace(/^commandcode\//, '').toLowerCase()],
        ),
      ).fits;
      if (fits) prContext = enriched;
      log(
        `Packed handoff verification: ${JSON.stringify({
          ...stats,
          injectedBytes: fits ? stats.bytes : 0,
          prepareMs: Date.now() - started,
          status: fits ? (packet ? 'applied' : 'empty') : 'prompt-budget',
        })}`,
      );
    } catch {
      log('Packed handoff verification: unavailable; continuing with cited source.');
    }
  }
  if (timeoutMs !== undefined) {
    timeoutMs = Math.max(0, timeoutMs - (Date.now() - started));
    if (timeoutMs === 0) throw new Error('Finding verification budget exhausted.');
  }
  const { finalText: raw } = await runCommandCodePrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings, !runtime?.tools),
    'finding-verification',
    log,
    timeoutMs,
    onTokenUsage,
    runtime,
    effort,
  );
  return parseFindingVerdicts(raw, findings.length, log);
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
  toolOutcomes?: Record<string, number>;
} {
  const toolOutcomes: Record<string, number> = {};
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
    const outcome = commandCodeToolOutcome(frame);
    if (outcome) toolOutcomes[outcome] = (toolOutcomes[outcome] ?? 0) + 1;
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
    ...(Object.keys(toolOutcomes).length ? { toolOutcomes } : {}),
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

async function commandCodeTranscriptPath(home: string, sessionId: string) {
  const directory = await opendir(join(home, '.commandcode', 'projects'), { recursive: true });
  for await (const entry of directory)
    if (entry.isFile() && entry.name === `${sessionId}.jsonl`)
      return join(entry.parentPath, entry.name);
  return undefined;
}

export async function commandCodeSessionEstimatedCost(
  home: string,
  sessionId: string,
): Promise<number | undefined> {
  try {
    const transcript = await commandCodeTranscriptPath(home, sessionId);
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
  runtime?: CommandCodeRuntime,
  effort?: string,
  resumeSessionId?: string,
): Promise<{ finalText: string; sessionId?: string }> {
  const args = buildCommandCodeCliArgs({ model, effort });
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  const repair = label.endsWith('-repair');
  const repairHome =
    runtime?.tools && repair ? mkdtempSync(join(runtime.home, 'repair-')) : undefined;
  const home = repairHome ?? runtime?.home;
  let benchmarkDir: string | undefined;
  try {
    benchmarkDir = mkdtempSync(join(home ?? tmpdir(), 'benchmark-'));
    args.push('--benchmark-output', join(benchmarkDir, 'metrics.json'));
  } catch {
    log(`CommandCode benchmark (${label}): unavailable`);
  }
  const input =
    runtime?.tools && !repair
      ? withCommandCodeToolsDirective(prompt, workspace)
      : withNoToolsReviewDirective(prompt);
  const effortLabel =
    effort ??
    (COMMANDCODE_MODEL_EFFORTS[parseModelName(model).modelID]?.tiers.length === 0
      ? 'not-configurable'
      : 'cli-default');
  log(`Calling ${label} prompt (agent=commandcode-cli, model=${model}, effort=${effortLabel})`);
  let usage: PromptTokenUsage | undefined;
  const progress = createCommandCodeProgress();
  let complete = false;
  const heartbeat = setInterval(() => {
    log(`CommandCode progress (${label}): ${JSON.stringify(progress.snapshot())}`);
  }, 60_000);
  heartbeat.unref();
  try {
    if (repairHome) {
      writeCommandCodeReadOnlySettings(repairHome);
      copyFileSync(commandCodeAuthPath(runtime!.home), commandCodeAuthPath(repairHome));
    }
    const result = await runCliProcess(COMMANDCODE_CLI_BIN, args, {
      cwd: home ? join(home, 'launch') : workspace,
      input,
      env: commandCodeEnvForHome(home) ?? process.env,
      timeoutMs,
      timeoutMessage: formatCommandCodePromptTimeoutMessage(label, model, timeoutMs),
      onStdout: progress.feed,
    });
    progress.finish();
    if (progress.snapshot().stopReason === 'permission_denied') {
      let findings: Finding[] = [];
      try {
        const parsed = parseCommandCodeJsonOutput(result.stdout);
        findings = parseReview(parsed.finalText, label, log, { strict: true }).findings;
      } catch {
        // A denied run often ends with prose; never repair it into findings.
      }
      throw new IncompleteReviewError(
        `commandcode ${label}: native tool permission denied; check workspace permissions.`,
        findings,
      );
    }
    if (result.exitCode !== 0) {
      throw new Error(
        formatCommandCodePromptFailure(label, result.exitCode, result.stderr || result.stdout),
      );
    }
    const parsed = parseCommandCodeJsonOutput(result.stdout);
    if (resumeSessionId && parsed.sessionId !== resumeSessionId)
      throw new Error('CommandCode resumed a different session.');
    if (runtime?.tools)
      log(`CommandCode tool outcomes (${label}): ${JSON.stringify(parsed.toolOutcomes ?? {})}`);
    const estimatedCostUsd =
      runtime && parsed.sessionId && !resumeSessionId
        ? await commandCodeSessionEstimatedCost(home!, parsed.sessionId)
        : undefined;
    usage = parsed.usage
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
    }
    log(
      `${label} prompt complete via commandcode: result=${parsed.finalText.length} chars stderr=${result.stderr.length} chars`,
    );
    complete = true;
    return { finalText: parsed.finalText, sessionId: parsed.sessionId };
  } finally {
    if (benchmarkDir) {
      try {
        const path = join(benchmarkDir, 'metrics.json');
        const benchmark =
          statSync(path).size <= 4 * 1024 * 1024
            ? parseCommandCodeBenchmark(JSON.parse(readFileSync(path, 'utf8')))
            : undefined;
        log(
          `CommandCode benchmark (${label}): ${benchmark ? JSON.stringify(benchmark) : 'unavailable'}`,
        );
      } catch {
        log(`CommandCode benchmark (${label}): unavailable`);
      } finally {
        try {
          rmSync(benchmarkDir, { recursive: true, force: true });
        } catch {
          log(`CommandCode benchmark (${label}): cleanup failed`);
        }
      }
    }
    if (repairHome) rmSync(repairHome, { recursive: true, force: true });
    clearInterval(heartbeat);
    progress.finish();
    usage ??= progress.usage();
    const snapshot = progress.snapshot(complete);
    log(
      `CommandCode final progress (${label}): ${JSON.stringify(snapshot)}; usage=${usage ? 'available' : 'unavailable'}`,
    );
    runtime?.onProgress?.(label, model, snapshot);
    onTokenUsage?.({ ...usage, promptBytes: Buffer.byteLength(input, 'utf8') }, model, label);
  }
}

function formatCommandCodePromptFailure(
  label: string,
  exitCode: number | null,
  output: string,
): string {
  output = output.replace(/^Reasoning effort set to .*\r?\n?/gm, '').trim();
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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  for (const key of sessionEnvDenyKeys(Object.keys(env))) delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.NODE_OPTIONS;
  delete env.BUN_OPTIONS;
  delete env.PWD;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

// The same alpha endpoints the pinned CLI's /usage view reads (fetchUsageData
// in its bundle), Bearer-authed with the access key. Alpha API: every shape
// drift parses to undefined — usage visibility must never fail a run.
// The credits payload carries the 5h/weekly meters and the remaining balance;
// the monthly meter is COMPOSED like the TUI does it: spend-this-period from
// the usage summary + remaining = plan total, reset date from the
// subscription's period end.
const COMMANDCODE_API_BASE = 'https://api.commandcode.ai';
const COMMANDCODE_USAGE_TIMEOUT_MS = 4_000;
// Enrichment calls get less patience than the core call: the line must never
// sit hostage to a slow secondary endpoint whose meter it can simply drop.
// 3s, not less: the subscriptions endpoint measures ~1.1s warm on some
// accounts, and a cold process (the Action's normal shape) adds DNS + TLS.
const COMMANDCODE_ENRICHMENT_TIMEOUT_MS = 3_000;

interface CommandCodeUsageWindow {
  used: number;
  cap: number;
  resetAt: number;
  exceeded: boolean;
}

interface CommandCodeMonthlyWindow {
  used: number;
  cap: number;
  /** Billing-period end — rendered as a date, unlike the rolling windows. */
  periodEndMs: number;
}

export interface CommandCodePlanUsage {
  /** Included plan credits REMAINING this billing period. */
  monthlyCredits: number;
  /** Pay-as-you-go balance overage draws from once the plan runs out. */
  purchasedCredits: number;
  fiveHour?: CommandCodeUsageWindow;
  weekly?: CommandCodeUsageWindow;
  /** Enrichment from the summary + subscription endpoints; absent when either is unavailable. */
  monthly?: CommandCodeMonthlyWindow;
}

export function parseCommandCodePlanUsage(payload: unknown): CommandCodePlanUsage | undefined {
  if (!isNonArrayRecord(payload) || !isNonArrayRecord(payload.credits)) return undefined;
  const { monthlyCredits, purchasedCredits } = payload.credits;
  if (!isFiniteNumber(monthlyCredits)) return undefined;
  // Only ABSENT fields degrade — explicit null included, because null is this
  // API's none value (the live payload carries windowLimits.exceeded: null).
  // A present-but-invalid field is drift and poisons the whole payload: a
  // partial line would render trusted-looking meters while hiding a real limit.
  if (purchasedCredits != null && !isFiniteNumber(purchasedCredits)) return undefined;
  const { windowLimits } = payload;
  if (windowLimits != null && !isNonArrayRecord(windowLimits)) return undefined;
  const limits = isNonArrayRecord(windowLimits) ? windowLimits : undefined;
  // null return = present but malformed; undefined = absent.
  const windowOf = (value: unknown): CommandCodeUsageWindow | null | undefined => {
    if (value == null) return undefined;
    if (!isNonArrayRecord(value)) return null;
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

/**
 * Billing-period spend (`totalMonthlyCredits`) from the usage summary, or
 * undefined on drift.
 */
export function parseCommandCodeMonthlySpend(payload: unknown): number | undefined {
  if (!isNonArrayRecord(payload)) return undefined;
  const spent = payload.totalMonthlyCredits;
  return isFiniteNumber(spent) && spent >= 0 ? spent : undefined;
}

/** Billing-period bounds from the subscription payload, or undefined on drift. */
export function parseCommandCodePeriodBounds(
  payload: unknown,
): { startIso: string; endMs: number } | undefined {
  if (!isNonArrayRecord(payload) || !isNonArrayRecord(payload.data)) return undefined;
  const { currentPeriodStart, currentPeriodEnd } = payload.data;
  if (typeof currentPeriodStart !== 'string' || typeof currentPeriodEnd !== 'string') {
    return undefined;
  }
  // Both bounds must parse and order forward: startIso becomes the summary
  // request's `since`, and a garbage interval can return the wrong period's
  // spend rather than fail.
  const startMs = Date.parse(currentPeriodStart);
  const endMs = Date.parse(currentPeriodEnd);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? { startIso: currentPeriodStart, endMs }
    : undefined;
}

/**
 * Plan total = spent so far + remaining. A zero total (free account) has
 * nothing to meter, and a NEGATIVE remaining would shrink the cap below the
 * plan's real total — both drop the segment. Spend and period end arrive
 * pre-validated by their parsers.
 */
export function composeCommandCodeMonthlyWindow(
  spentCredits: number,
  remainingCredits: number,
  periodEndMs: number,
): CommandCodeMonthlyWindow | undefined {
  const cap = spentCredits + remainingCredits;
  return remainingCredits >= 0 && cap > 0 ? { used: spentCredits, cap, periodEndMs } : undefined;
}

export function formatCommandCodePlanUsage(usage: CommandCodePlanUsage, now: number): string {
  return `CommandCode plan usage: ${formatCommandCodePlanUsageBody(usage, now)}`;
}

function formatCommandCodePlanUsageBody(usage: CommandCodePlanUsage, now: number): string {
  const meter = (label: string, window?: CommandCodeUsageWindow): string | undefined => {
    if (!window) return undefined;
    return `${label} ${window.used.toFixed(1)}/${window.cap} (${percentLabel(window.used, window.cap)}${
      window.exceeded ? ', EXCEEDED' : ''
    }, resets in ${formatShortDuration(Math.max(window.resetAt - now, 0))})`;
  };
  const monthly = usage.monthly
    ? `monthly ${usage.monthly.used.toFixed(1)}/${usage.monthly.cap.toFixed(1)} (${percentLabel(
        usage.monthly.used,
        usage.monthly.cap,
      )}, resets ${new Date(usage.monthly.periodEndMs).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })})`
    : undefined;
  const windows = [meter('5h', usage.fiveHour), meter('weekly', usage.weekly), monthly]
    .filter(Boolean)
    .join(', ');
  const purchased =
    usage.purchasedCredits > 0 ? ` + ${usage.purchasedCredits.toFixed(1)} purchased` : '';
  return `${windows ? `${windows}; ` : ''}${usage.monthlyCredits.toFixed(1)} plan credits remaining${purchased}.`;
}

async function commandCodeApiJson(
  accessKey: string,
  path: string,
  timeoutMs: number,
): Promise<unknown> {
  const response = await fetch(`${COMMANDCODE_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

export function splitCommandCodeAccessKeys(value: string): string[] {
  return value
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

interface CommandCodeKeyProbe {
  key: string;
  usage?: CommandCodePlanUsage;
}

/**
 * Share of the weekly rolling cap still open; no cap at all means nothing can
 * throttle, so full headroom. An exceeded window floors at zero rather than
 * ranking by how far over it is.
 */
function weeklyHeadroom(usage: CommandCodePlanUsage): number {
  return usage.weekly ? Math.max(0, 1 - usage.weekly.used / usage.weekly.cap) : 1;
}

// Rank weekly headroom using the credits payload so selection does not depend
// on the slower monthly display enrichment. Remaining credits break ties.
export function pickCommandCodeAccessKey(probes: readonly CommandCodeKeyProbe[]): {
  key: string;
  reason: string;
} {
  const reachable = probes.filter(
    (probe): probe is { key: string; usage: CommandCodePlanUsage } => probe.usage !== undefined,
  );
  if (reachable.length === 0) {
    throw new Error(
      'CommandCode usage unavailable for all keys; cannot confirm available plan limits.',
    );
  }
  const funded = reachable.filter((probe) => probe.usage.monthlyCredits > 0);
  if (funded.length === 0) {
    throw new Error('CommandCode monthly plan credits exhausted for all reachable keys.');
  }
  const windowOpen = funded.filter((probe) =>
    [probe.usage.fiveHour, probe.usage.weekly].every(
      (window) => !window || (!window.exceeded && window.used < window.cap),
    ),
  );
  if (windowOpen.length === 0) {
    throw new Error(
      'CommandCode 5-hour or weekly usage limits exhausted for all funded reachable keys.',
    );
  }
  const best = windowOpen.reduce((a, b) => {
    const headroomA = weeklyHeadroom(a.usage);
    const headroomB = weeklyHeadroom(b.usage);
    if (headroomB > headroomA) return b;
    if (headroomB === headroomA && b.usage.monthlyCredits > a.usage.monthlyCredits) return b;
    return a;
  });
  // The full-headroom sentinel for an uncapped account must not read as a real meter.
  const standing = best.usage.weekly
    ? `${Math.round(weeklyHeadroom(best.usage) * 100)}% of weekly limit left`
    : 'no weekly limit';
  return {
    key: best.key,
    reason:
      `picked ${probes.indexOf(best) + 1}/${probes.length} ` +
      `(…${best.key.slice(-4)}, ${standing})`,
  };
}

/** One per-key meter line logged BEFORE the pick, so the decision's inputs are visible. */
export function formatCommandCodeKeyProbeLine(
  probe: CommandCodeKeyProbe,
  index: number,
  total: number,
  now: number,
): string {
  const label = `CommandCode key ${index + 1}/${total} (…${probe.key.slice(-4)})`;
  return probe.usage
    ? `${label}: ${formatCommandCodePlanUsageBody(probe.usage, now)}`
    : `${label}: usage unavailable.`;
}

/** Probes once per run; the selected key stays fixed for the whole review. */
export async function selectCommandCodeAccessKey(
  rawValue: string,
  log: (msg: string) => void,
): Promise<{ key: string; usageLogged: boolean }> {
  const keys = rawValue.includes(',') ? splitCommandCodeAccessKeys(rawValue) : [rawValue];
  // Nothing parseable keeps the raw value: legacy garbage-in behavior.
  if (keys.length === 0) return { key: rawValue, usageLogged: false };
  const probes = await Promise.all(
    keys.map(async (key) => ({ key, usage: await fetchCommandCodeFullUsage(key) })),
  );
  const now = Date.now();
  probes.forEach((probe, index) =>
    log(formatCommandCodeKeyProbeLine(probe, index, probes.length, now)),
  );
  const picked = pickCommandCodeAccessKey(probes);
  log(`CommandCode key: ${picked.reason}`);
  return { key: picked.key, usageLogged: true };
}

/** One log line of live plan usage, or undefined on ANY failure — never throws. */
export async function fetchCommandCodePlanUsageLine(
  accessKey: string,
): Promise<string | undefined> {
  const usage = await fetchCommandCodeFullUsage(accessKey);
  return usage && formatCommandCodePlanUsage(usage, Date.now());
}

/**
 * Full composed usage (credits at the standard timeout — a cold process's
 * first contact must not flake the probe — monthly enrichment on its shorter
 * tier), or undefined on ANY failure. Never throws.
 */
async function fetchCommandCodeFullUsage(
  accessKey: string,
): Promise<CommandCodePlanUsage | undefined> {
  const getJson = (path: string, timeoutMs: number): Promise<unknown> =>
    commandCodeApiJson(accessKey, path, timeoutMs);
  try {
    const [creditsPayload, subscriptionPayload] = await Promise.all([
      getJson('/alpha/billing/credits', COMMANDCODE_USAGE_TIMEOUT_MS),
      // The monthly meter is an enrichment: its two secondary requests failing
      // (or drifting) drop only the monthly segment, never the whole line.
      getJson('/alpha/billing/subscriptions', COMMANDCODE_ENRICHMENT_TIMEOUT_MS).catch(
        () => undefined,
      ),
    ]);
    const usage = parseCommandCodePlanUsage(creditsPayload);
    if (!usage) return undefined;
    const bounds = parseCommandCodePeriodBounds(subscriptionPayload);
    if (bounds) {
      const spent = parseCommandCodeMonthlySpend(
        await getJson(
          `/alpha/usage/summary?since=${encodeURIComponent(bounds.startIso)}`,
          COMMANDCODE_ENRICHMENT_TIMEOUT_MS,
        ).catch(() => undefined),
      );
      if (spent !== undefined) {
        usage.monthly = composeCommandCodeMonthlyWindow(spent, usage.monthlyCredits, bounds.endMs);
      }
    }
    return usage;
  } catch {
    return undefined;
  }
}
