import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelName } from './model.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
  type VerifiableFinding,
} from './prompt.ts';
import {
  parseFindingVerdicts,
  parseReview,
  type PromptTokenUsage,
  type TokenUsageRecorder,
} from './opencode.ts';
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const DEVIN_PROMPT_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 2_000;
const DEVIN_SETUP_OUTPUT_RETRY_LIMIT = 1;
const DEVIN_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const DEVIN_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const DEVIN_INPUT_TOKEN_FIELDS = [
  'total_input_tokens',
  'input_tokens',
  'totalInputTokens',
  'inputTokens',
] as const;
const DEVIN_OUTPUT_TOKEN_FIELDS = ['output_tokens', 'outputTokens'] as const;
const DEVIN_REASONING_TOKEN_FIELDS = ['reasoning_tokens', 'reasoningTokens'] as const;
const DEVIN_CACHE_READ_TOKEN_FIELDS = ['cache_read_tokens', 'cacheReadTokens'] as const;
const DEVIN_CACHE_WRITE_TOKEN_FIELDS = ['cache_creation_tokens', 'cacheCreationTokens'] as const;
const DEVIN_COST_USD_FIELDS = ['cost_usd', 'costUsd'] as const;
const DEVIN_CREDIT_COST_FIELDS = ['committed_credit_cost', 'committedCreditCost'] as const;
const DEVIN_ACU_COST_FIELDS = ['committed_acu_cost', 'committedAcuCost'] as const;
const DEVIN_MODEL_FIELDS = ['generation_model', 'generationModel'] as const;
const DEVIN_USAGE_FIELD_NAMES = [
  ...DEVIN_INPUT_TOKEN_FIELDS,
  ...DEVIN_OUTPUT_TOKEN_FIELDS,
  ...DEVIN_REASONING_TOKEN_FIELDS,
  ...DEVIN_CACHE_READ_TOKEN_FIELDS,
  ...DEVIN_CACHE_WRITE_TOKEN_FIELDS,
  ...DEVIN_COST_USD_FIELDS,
  ...DEVIN_CREDIT_COST_FIELDS,
  ...DEVIN_ACU_COST_FIELDS,
  ...DEVIN_MODEL_FIELDS,
] as const;

export const DEVIN_PROVIDER_ID = 'devin';

export function isDevinProvider(providerID: string): boolean {
  return providerID === DEVIN_PROVIDER_ID;
}

export function devinCredentialsPath(home = process.env.HOME || homedir()): string {
  return join(home, '.local', 'share', 'devin', 'credentials.toml');
}

export function writeDevinCredentials(
  windsurfApiKey: string,
  home = process.env.HOME || homedir(),
): string {
  const key = windsurfApiKey.trim();
  if (!key)
    throw new Error('Missing Devin API key. Set devin-windsurf-api-key or DEVIN_WINDSURF_API_KEY.');

  const path = devinCredentialsPath(home);
  mkdirSync(join(home, '.local', 'share', 'devin'), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    [
      `windsurf_api_key = ${tomlString(key)}`,
      'api_server_url = "https://server.codeium.com"',
      'devin_webapp_host = "https://app.devin.ai"',
      'devin_api_url = "https://api.devin.ai"',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}

export interface DevinCliArgsInput {
  model: string;
  promptFile: string;
  exportFile: string;
  configFile: string;
}

export interface DevinCliConfig {
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export interface DevinAtifUsage {
  usage: PromptTokenUsage;
  model?: string;
  records: number;
}

export function buildDevinCliArgs(input: DevinCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    '--permission-mode',
    'auto',
    '--config',
    input.configFile,
    '--prompt-file',
    input.promptFile,
    '--export',
    input.exportFile,
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  args.push('-p');
  return args;
}

export function isDevinFirstRunSetupOutput(output: string): boolean {
  return (
    output.includes('Welcome to Devin CLI') &&
    output.includes("You're all set") &&
    output.includes('Run') &&
    output.includes('devin')
  );
}

export async function runDevinReview(
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
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(prContext, guidelines, options.lensAddendum ?? '');
  log(`Prompt assembled (${label}, devin): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runDevinPrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.timeoutMs,
    options.onTokenUsage,
  );
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via devin: ${message}`);
    const repaired = await runDevinPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: DEVIN_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: DEVIN_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.timeoutMs,
      options.onTokenUsage,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runDevinAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<AddressedPriorComment[]> {
  const raw = await runDevinPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runDevinGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<Finding[]> {
  const raw = await runDevinPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runDevinFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<FindingVerdict[] | undefined> {
  const raw = await runDevinPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runDevinPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = DEVIN_PROMPT_TIMEOUT_MS,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-devin-'));
  const promptFile = join(dir, 'prompt.txt');
  const exportFile = join(dir, 'conversation.atif');
  const configFile = writeDevinReadOnlyConfig(dir);
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  const args = buildDevinCliArgs({ model, promptFile, exportFile, configFile });
  log(`Calling ${label} prompt (agent=devin-cli, model=${model})`);
  try {
    for (let attempt = 0; ; attempt += 1) {
      const result = await spawnWithTimeout('devin', args, workspace, timeoutMs);
      if (result.exitCode !== 0) {
        throw new Error(
          `devin ${label} exited ${result.exitCode}: ${truncateForLog(
            result.stderr || result.stdout,
            1000,
          )}`,
        );
      }
      if (isDevinFirstRunSetupOutput(result.stdout)) {
        if (attempt < DEVIN_SETUP_OUTPUT_RETRY_LIMIT) {
          log(`${label} devin first-run setup output detected; retrying prompt once.`);
          rmSync(exportFile, { force: true });
          continue;
        }
        throw new Error(
          `devin ${label} returned first-run setup output instead of a prompt response.`,
        );
      }
      log(
        `${label} prompt complete via devin: stdout=${result.stdout.length} chars stderr=${result.stderr.length} chars`,
      );
      recordDevinAtifUsage(exportFile, model, label, log, onTokenUsage);
      return result.stdout;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recordDevinAtifUsage(
  exportFile: string,
  fallbackModel: string,
  label: string,
  log: (msg: string) => void,
  onTokenUsage?: TokenUsageRecorder,
): void {
  if (!onTokenUsage) return;
  if (!existsSync(exportFile)) {
    log(`${label} devin usage unavailable: ATIF export was not written.`);
    return;
  }
  try {
    const parsed = parseDevinAtifUsage(readFileSync(exportFile, 'utf8'), fallbackModel);
    if (!parsed) {
      log(`${label} devin usage unavailable: ATIF export had no recognized usage records.`);
      return;
    }
    log(`${label} devin ${formatDevinUsage(parsed.usage)} records=${parsed.records}`);
    onTokenUsage(parsed.usage, parsed.model ?? fallbackModel);
  } catch (error) {
    log(
      `${label} devin usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseDevinAtifUsage(
  content: string,
  fallbackModel?: string,
): DevinAtifUsage | undefined {
  const root = JSON.parse(content) as unknown;
  const usage: PromptTokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const models = new Set<string>();
  let records = 0;

  for (const record of walkObjects(root)) {
    if (!hasDevinUsageField(record)) continue;
    const input = firstNumber(record, DEVIN_INPUT_TOKEN_FIELDS);
    const output = firstNumber(record, DEVIN_OUTPUT_TOKEN_FIELDS);
    const reasoning = firstNumber(record, DEVIN_REASONING_TOKEN_FIELDS);
    const cacheRead = firstNumber(record, DEVIN_CACHE_READ_TOKEN_FIELDS);
    const cacheWrite = firstNumber(record, DEVIN_CACHE_WRITE_TOKEN_FIELDS);
    const costUsd = firstNumber(record, DEVIN_COST_USD_FIELDS);
    const creditCost = firstNumber(record, DEVIN_CREDIT_COST_FIELDS);
    const acuCost = firstNumber(record, DEVIN_ACU_COST_FIELDS);
    if (
      input === undefined &&
      output === undefined &&
      reasoning === undefined &&
      cacheRead === undefined &&
      cacheWrite === undefined &&
      costUsd === undefined &&
      creditCost === undefined &&
      acuCost === undefined
    ) {
      continue;
    }

    records += 1;
    usage.input += input ?? 0;
    usage.output += output ?? 0;
    usage.reasoning += reasoning ?? 0;
    usage.cacheRead += cacheRead ?? 0;
    usage.cacheWrite += cacheWrite ?? 0;
    if (costUsd !== undefined) usage.costUsd = (usage.costUsd ?? 0) + costUsd;
    if (creditCost !== undefined) usage.creditCost = (usage.creditCost ?? 0) + creditCost;
    if (acuCost !== undefined) usage.acuCost = (usage.acuCost ?? 0) + acuCost;

    const model = firstString(record, DEVIN_MODEL_FIELDS);
    if (model) models.add(formatDevinUsageModel(model));
  }

  if (records === 0) return undefined;
  return {
    usage,
    model: models.size === 1 ? [...models][0] : fallbackModel,
    records,
  };
}

function* walkObjects(value: unknown): Iterable<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const item of value) yield* walkObjects(item);
    return;
  }
  if (!isRecord(value)) return;
  yield value;
  for (const item of Object.values(value)) yield* walkObjects(item);
}

function hasDevinUsageField(record: Record<string, unknown>): boolean {
  return DEVIN_USAGE_FIELD_NAMES.some((field) => field in record);
}

function firstNumber(
  record: Record<string, unknown>,
  fields: readonly string[],
): number | undefined {
  for (const field of fields) {
    const value = finiteNumber(record[field]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstString(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatDevinUsageModel(model: string): string {
  return model.includes('/') ? model : `devin/${model}`;
}

function formatDevinUsage(usage: PromptTokenUsage): string {
  const parts = [
    `input=${usage.input}`,
    `output=${usage.output}`,
    `reasoning=${usage.reasoning}`,
    `cache(read=${usage.cacheRead} write=${usage.cacheWrite})`,
  ];
  if (typeof usage.costUsd === 'number') parts.push(`cost=$${usage.costUsd.toFixed(4)}`);
  if (typeof usage.creditCost === 'number')
    parts.push(`creditCost=${formatCost(usage.creditCost)}`);
  if (typeof usage.acuCost === 'number') parts.push(`acuCost=${formatCost(usage.acuCost)}`);
  return `usage: ${parts.join(' ')}`;
}

function formatCost(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function spawnWithTimeout(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const pid = child.pid;
      if (pid !== undefined) {
        const target = process.platform === 'win32' ? pid : -pid;
        try {
          process.kill(target, 'SIGTERM');
        } catch {
          /* best effort */
        }
        setTimeout(() => {
          try {
            process.kill(target, 'SIGKILL');
          } catch {
            /* best effort */
          }
        }, KILL_GRACE_MS).unref();
      }
      reject(new Error(`devin prompt timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref();

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildDevinReadOnlyConfig(): DevinCliConfig {
  return {
    permissions: {
      allow: [
        'read',
        'grep',
        'glob',
        'Read(**)',
        'Exec(git status)',
        'Exec(git diff)',
        'Exec(git log)',
        'Exec(git show)',
        'Exec(git grep)',
        'Exec(git ls-files)',
        'Exec(git rev-parse)',
        'Exec(git merge-base)',
      ],
      deny: ['edit', 'write', 'Write(**)', 'Write(/**)'],
    },
  };
}

function writeDevinReadOnlyConfig(dir: string): string {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(buildDevinReadOnlyConfig(), null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}
