import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  type PromptTokenUsage,
  type TokenUsageRecorder,
} from './opencode.ts';
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
import { isFiniteNumber, isRecord, truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const POOLSIDE_CHAT_COMPLETIONS_URL = 'https://inference.poolside.ai/v1/chat/completions';
const POOLSIDE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const POOLSIDE_MAX_COMPLETION_TOKENS = 32_768;
const POOLSIDE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const POOLSIDE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

export const POOLSIDE_PROVIDER_ID = 'poolside';

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

export function poolsideReasoningEffort(modelOptions?: Record<string, unknown>): string {
  const effort = modelOptions?.reasoningEffort;
  return typeof effort === 'string' && effort.trim() ? effort.trim() : 'default';
}

export function mapPoolsideUsage(value: unknown): PromptTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const input = isFiniteNumber(value.prompt_tokens) ? value.prompt_tokens : 0;
  const completion = isFiniteNumber(value.completion_tokens) ? value.completion_tokens : 0;
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : {};
  const reasoning = isFiniteNumber(completionDetails.reasoning_tokens)
    ? completionDetails.reasoning_tokens
    : 0;
  return {
    input,
    output: Math.max(0, completion - reasoning),
    reasoning,
    cacheRead: isFiniteNumber(promptDetails.cached_tokens) ? promptDetails.cached_tokens : 0,
    cacheWrite: 0,
  };
}

export async function runPoolsideReview(
  apiKey: string,
  reasoningEffort: string,
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
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
  );
  log(`Prompt assembled (${label}, poolside): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runPoolsidePrompt({
    apiKey,
    reasoningEffort,
    model,
    prompt,
    label,
    log,
    timeoutMs: options.timeoutMs,
    onTokenUsage: options.onTokenUsage,
  });
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one Poolside JSON repair prompt: ${message}`);
    const repaired = await runPoolsidePrompt({
      apiKey,
      reasoningEffort,
      model,
      prompt: buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: POOLSIDE_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: POOLSIDE_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      label: `${label}-repair`,
      log,
      timeoutMs: options.timeoutMs,
      onTokenUsage: options.onTokenUsage,
    });
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runPoolsideAddressedPriorCommentsCheck(
  apiKey: string,
  reasoningEffort: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<AddressedPriorComment[]> {
  const label = 'addressed-prior-comments';
  const raw = await runPoolsidePrompt({
    apiKey,
    reasoningEffort,
    model,
    prompt: assembleAddressedPriorCommentsPrompt(prContext),
    label,
    log,
    timeoutMs,
    onTokenUsage,
  });
  return parseReview(raw, label, log).addressedPriorComments;
}

export async function runPoolsideGuidelineComplianceCheck(
  apiKey: string,
  reasoningEffort: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<Finding[]> {
  const label = 'guideline-compliance';
  const raw = await runPoolsidePrompt({
    apiKey,
    reasoningEffort,
    model,
    prompt: assembleGuidelineCompliancePrompt(prContext, guidelines),
    label,
    log,
    timeoutMs,
    onTokenUsage,
  });
  return parseReview(raw, label, log).findings;
}

export async function runPoolsideChangesSinceLastReview(
  apiKey: string,
  reasoningEffort: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const label = 'changes-since-last-review';
  const raw = await runPoolsidePrompt({
    apiKey,
    reasoningEffort,
    model,
    prompt: assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    label,
    log,
    timeoutMs,
    onTokenUsage,
  });
  return parseChangesSinceLastReviewSummary(raw, label, log);
}

export async function runPoolsideFindingVerification(
  apiKey: string,
  reasoningEffort: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<FindingVerdict[] | undefined> {
  const label = 'finding-verification';
  const raw = await runPoolsidePrompt({
    apiKey,
    reasoningEffort,
    model,
    prompt: assembleFindingVerificationPrompt(prContext, findings, true),
    label,
    log,
    timeoutMs,
    onTokenUsage,
  });
  return parseFindingVerdicts(raw, findings.length, log);
}

interface PoolsidePromptOptions {
  apiKey: string;
  reasoningEffort: string;
  model: string;
  prompt: string;
  label: string;
  log: (msg: string) => void;
  timeoutMs?: number;
  onTokenUsage?: TokenUsageRecorder;
}

function parsePoolsideStream(
  body: string,
  label: string,
): { raw: string; usage?: PromptTokenUsage } {
  let raw = '';
  let usage: PromptTokenUsage | undefined;
  for (const line of body.split(/\r?\n/)) {
    const event = line.trimStart();
    if (!event.startsWith('data:')) continue;
    const data = event.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error(
        `Poolside ${label} returned invalid streamed JSON: ${truncateForLog(data, 1000)}`,
      );
    }
    if (!isRecord(payload)) continue;
    usage = mapPoolsideUsage(payload.usage) ?? usage;
    if (!Array.isArray(payload.choices)) continue;
    const choice = payload.choices[0];
    const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
    if (typeof delta?.content === 'string') raw += delta.content;
  }
  return { raw: raw.trim(), ...(usage ? { usage } : {}) };
}

async function runPoolsidePrompt(options: PoolsidePromptOptions): Promise<string> {
  const { apiKey, reasoningEffort, model, prompt, label, log, onTokenUsage } = options;
  const timeoutMs = options.timeoutMs ?? POOLSIDE_PROMPT_TIMEOUT_MS;
  const fullPrompt = `${NO_TOOLS_REVIEW_DIRECTIVE}\n\n${prompt}`;
  log(
    `Calling ${label} prompt (backend=poolside-api, model=${model}, reasoning=${reasoningEffort})`,
  );
  let response: Response;
  let body: string;
  try {
    response = await fetch(POOLSIDE_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: fullPrompt }],
        ...(reasoningEffort === 'default' ? {} : { reasoning: { effort: reasoningEffort } }),
        max_completion_tokens: POOLSIDE_MAX_COMPLETION_TOKENS,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Poolside ${label} request failed: ${message}`);
  }

  if (!response.ok) {
    throw new Error(
      `Poolside ${label} request failed (${response.status}): ${truncateForLog(body, 1000)}`,
    );
  }

  const { raw, usage } = parsePoolsideStream(body, label);
  if (!raw) {
    throw new Error(
      `Poolside ${label} response contained no assistant text: ${truncateForLog(body, 1000)}`,
    );
  }

  if (usage) {
    log(
      `${label} tokens: input=${usage.input} output=${usage.output} reasoning=${usage.reasoning} cache-read=${usage.cacheRead}`,
    );
    onTokenUsage?.(usage, model, label);
  }
  log(`${label} prompt complete via Poolside API: ${raw.length} chars`);
  return raw;
}
