import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  accessToken,
  query,
  type NonNullableUsage,
  type Options,
  type Query,
  type SDKResultMessage,
} from '@qoder-ai/qoder-agent-sdk';

import { parseModelName } from './model.ts';
import {
  formatTokenUsage,
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  type PromptTokenUsage,
  type TokenUsageRecorder,
} from './opencode.ts';
import {
  QODER_REVIEW_SYSTEM_PROMPT,
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  type VerifiableFinding,
} from './prompt.ts';
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const QODER_PROMPT_TIMEOUT_MS = 20 * 60_000;
const QODER_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const QODER_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

export const QODER_PROVIDER_ID = 'qoder';

const QODER_READ_TOOLS = ['Read', 'Grep', 'Glob'];
const QODER_DENIED_TOOLS = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Skill',
  'mcp__*',
];

const QODER_ENV_KEYS = [
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
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'CI',
] as const;

export function isQoderProvider(providerID: string): boolean {
  return providerID === QODER_PROVIDER_ID;
}

export function qoderModelID(model: string): string {
  const { modelID } = parseModelName(model);
  return modelID === 'default' ? 'auto' : modelID;
}

export function assertQoderToken(token: string): string {
  const value = token.trim();
  if (!value) {
    throw new Error(
      'Missing Qoder personal access token. Set qoder-token or QODER_PERSONAL_ACCESS_TOKEN.',
    );
  }
  return value;
}

export function qoderEnvForHome(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of QODER_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = home;
  env.QODER_MEMORY = '0';
  env.QODER_MEMORY_USER = '0';
  return env;
}

export function buildQoderOptions(
  workspace: string,
  model: string,
  token: string,
  home: string,
  abortController: AbortController,
): Options {
  return {
    abortController,
    auth: accessToken(assertQoderToken(token)),
    cwd: workspace,
    model: qoderModelID(model),
    env: qoderEnvForHome(home),
    settingSources: [],
    strictMcpConfig: true,
    tools: [...QODER_READ_TOOLS],
    disallowedTools: [...QODER_DENIED_TOOLS],
    permissionMode: 'dontAsk',
    systemPrompt: {
      type: 'preset',
      preset: 'qodercli',
      append: QODER_REVIEW_SYSTEM_PROMPT,
    },
    settings: {
      disableAllHooks: true,
      security: { disableYoloMode: true },
      permissions: {
        deny: [...QODER_DENIED_TOOLS],
        defaultMode: 'dontAsk',
        disableBypassPermissionsMode: 'disable',
      },
      agentsMdExcludes: ['**/AGENTS.md', '**/AGENTS.local.md', '**/.qoder/rules/**'],
      autoMemoryEnabled: false,
      general: { enableAutoUpdate: false },
    },
  };
}

export function mapQoderUsage(usage: NonNullableUsage, costUsd: number): PromptTokenUsage {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    reasoning: 0,
    cacheRead: usage.cache_read_input_tokens,
    cacheWrite: usage.cache_creation_input_tokens,
    ...(Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

export function formatQoderPromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `qoder ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}

export async function runQoderReview(
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
    token?: string;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
  );
  log(`Prompt assembled (${label}, qoder): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runQoderPrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.token,
    options.timeoutMs,
    options.onTokenUsage,
  );
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via qoder: ${message}`);
    const repaired = await runQoderPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: QODER_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: QODER_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.token,
      options.timeoutMs,
      options.onTokenUsage,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runQoderAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  token?: string,
): Promise<AddressedPriorComment[]> {
  const raw = await runQoderPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    token,
    timeoutMs,
    onTokenUsage,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runQoderGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  token?: string,
): Promise<Finding[]> {
  const raw = await runQoderPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    token,
    timeoutMs,
    onTokenUsage,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runQoderChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  token?: string,
): Promise<string> {
  const raw = await runQoderPrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    token,
    timeoutMs,
    onTokenUsage,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runQoderFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  token?: string,
): Promise<FindingVerdict[] | undefined> {
  const raw = await runQoderPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    token,
    timeoutMs,
    onTokenUsage,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runQoderPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  token: string | undefined,
  timeoutMs = QODER_PROMPT_TIMEOUT_MS,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'jbot-qoder-'));
  const abortController = new AbortController();
  let timedOut = false;
  let result: SDKResultMessage | undefined;
  let session: Query | undefined;
  let timer: NodeJS.Timeout | undefined;
  log(`Calling ${label} prompt (agent=qoder-cli, model=${model})`);
  try {
    session = query({
      prompt,
      options: buildQoderOptions(workspace, model, token ?? '', home, abortController),
    });
    timer = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      void session?.close().catch(() => undefined);
    }, timeoutMs);
    timer.unref();
    try {
      for await (const message of session) {
        if (message.type === 'result') result = message;
      }
    } catch (error) {
      if (!result) throw error;
    }
    if (timedOut && result?.subtype !== 'success') {
      throw new Error(formatQoderPromptTimeoutMessage(label, model, timeoutMs));
    }
    if (!result) throw new Error(`qoder ${label} produced no result event`);
    if (result.subtype !== 'success') {
      throw new Error(
        `qoder ${label} failed (${result.subtype}): ${truncateForLog(result.errors.join('; '), 1000)}`,
      );
    }
    const usage = mapQoderUsage(result.usage, result.total_cost_usd);
    log(
      `${label} ${formatTokenUsage({
        cost: usage.costUsd,
        tokens: {
          input: usage.input,
          output: usage.output,
          reasoning: usage.reasoning,
          cache: { read: usage.cacheRead, write: usage.cacheWrite },
        },
      })}`,
    );
    onTokenUsage?.(usage, model, label);
    const text = result.result.trim();
    log(
      `${label} prompt complete via qoder: result=${text.length} chars turns=${result.num_turns}`,
    );
    if (!text) throw new Error(`qoder ${label} produced an empty result`);
    return text;
  } catch (error) {
    if (timedOut) throw new Error(formatQoderPromptTimeoutMessage(label, model, timeoutMs));
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await session?.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}
