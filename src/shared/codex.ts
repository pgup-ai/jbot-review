import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const CODEX_PROMPT_TIMEOUT_MS = 20 * 60_000;
const CODEX_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const CODEX_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

export const CODEX_PROVIDER_ID = 'codex';
export const CODEX_CLI_BIN = 'codex';

export function isCodexProvider(providerID: string): boolean {
  return providerID === CODEX_PROVIDER_ID;
}

export function codexAuthPath(codexHome: string): string {
  return join(codexHome, 'auth.json');
}

/**
 * Writes the `CODEX_AUTH_JSON` secret — the raw contents of `~/.codex/auth.json`
 * — to `$CODEX_HOME/auth.json`. The whole file is carried so Codex keeps
 * subscription mode and its refresh_token; JSON-validated so a bad secret fails fast.
 */
export function writeCodexAuth(auth: string, codexHome: string): string {
  const content = auth.trim();
  if (!content) {
    throw new Error('Missing Codex auth. Set codex-auth or CODEX_AUTH_JSON.');
  }
  try {
    JSON.parse(content);
  } catch {
    throw new Error('Invalid CODEX_AUTH_JSON: expected the JSON contents of ~/.codex/auth.json.');
  }

  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const path = codexAuthPath(codexHome);
  writeFileSync(path, `${content}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
  return path;
}

export interface CodexCliArgsInput {
  model: string;
}

/**
 * Static `codex exec` argv. Read-only is enforced here (invariant #8):
 * `--sandbox read-only` + `--ignore-user-config`, and the bypass flag is never
 * emitted. The prompt and output file are appended per call in runCodexPrompt.
 */
export function buildCodexCliArgs(input: CodexCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  return args;
}

/**
 * Child env with the temp `CODEX_HOME`. The api-key/access-token envs are stripped
 * because Codex ranks them ABOVE auth.json — an ambient `OPENAI_API_KEY` would
 * silently switch the run to per-token API billing instead of the subscription.
 */
export function codexEnvForHome(codexHome: string | undefined): NodeJS.ProcessEnv {
  const home = codexHome?.trim();
  if (!home) {
    throw new Error('Missing Codex home. A temp CODEX_HOME is required for auth.');
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}

export function formatCodexPromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `codex ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}

export async function runCodexReview(
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
  // Codex exec output carries no token usage; mirror CommandCode/Cursor and skip it.
  void options.onTokenUsage;
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(prContext, guidelines, options.lensAddendum ?? '');
  log(`Prompt assembled (${label}, codex): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runCodexPrompt(
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
    log(`${label} response unparseable; sending one JSON repair prompt via codex: ${message}`);
    const repaired = await runCodexPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: CODEX_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: CODEX_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.home,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runCodexAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  home?: string,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runCodexPrompt(
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

export async function runCodexGuidelineComplianceCheck(
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
  const raw = await runCodexPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    home,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runCodexChangesSinceLastReview(
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
  const raw = await runCodexPrompt(
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

export async function runCodexFindingVerification(
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
  const raw = await runCodexPrompt(
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

async function runCodexPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  home: string | undefined,
  timeoutMs = CODEX_PROMPT_TIMEOUT_MS,
): Promise<string> {
  // Prompt goes on stdin (the `-` arg); the clean final message lands in the
  // --output-last-message file (stdout carries the full transcript), so read it.
  const dir = mkdtempSync(join(tmpdir(), 'jbot-codex-'));
  const outputFile = join(dir, 'last-message.txt');
  const args = [...buildCodexCliArgs({ model }), '--output-last-message', outputFile, '-'];
  log(`Calling ${label} prompt (agent=codex-cli, model=${model})`);
  try {
    const result = await spawnWithTimeout(CODEX_CLI_BIN, args, {
      cwd: workspace,
      input: prompt,
      env: codexEnvForHome(home),
      timeoutMs,
      timeoutMessage: formatCodexPromptTimeoutMessage(label, model, timeoutMs),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `codex ${label} exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    const lastMessage = readCodexLastMessage(outputFile).trim();
    log(
      `${label} prompt complete via codex: stdout=${result.stdout.length} chars last-message=${lastMessage.length} chars`,
    );
    // Empty file = no final message; fail loud rather than parse the noisy stdout transcript.
    if (!lastMessage) {
      throw new Error(
        `codex ${label} produced an empty --output-last-message; stderr: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    return lastMessage;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readCodexLastMessage(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
