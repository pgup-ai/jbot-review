import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
import { parseFindingVerdicts, parseReview, type TokenUsageRecorder } from './opencode.ts';
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const COMMANDCODE_PROMPT_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 2_000;
const COMMANDCODE_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const COMMANDCODE_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const COMMANDCODE_MODEL_LIST_TIMEOUT_MS = 60_000;
// CommandCode's default 10-turn limit can abort larger review prompts.
const COMMANDCODE_MAX_TURNS = 20;

export const COMMANDCODE_PROVIDER_ID = 'commandcode';
// The command-code npm package exposes cmd, cmdc, commandcode, and command-code.
// Use the long alias so Windows local runs do not accidentally invoke cmd.exe.
export const COMMANDCODE_CLI_BIN = 'command-code';

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
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
    home?: string;
  } = {},
): Promise<ReviewResult> {
  void options.onTokenUsage;
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(prContext, guidelines, options.lensAddendum ?? '');
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
  void onTokenUsage;
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    timeoutMs,
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
  void onTokenUsage;
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    timeoutMs,
    home,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
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
  void onTokenUsage;
  const raw = await runCommandCodePrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    timeoutMs,
    home,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

export async function listCommandCodeModels(workspace: string, home?: string): Promise<string[]> {
  const result = await spawnWithInputAndTimeout(
    COMMANDCODE_CLI_BIN,
    ['--list-models'],
    workspace,
    '',
    COMMANDCODE_MODEL_LIST_TIMEOUT_MS,
    commandCodeEnvForHome(home),
    `commandcode model listing timed out after ${Math.round(
      COMMANDCODE_MODEL_LIST_TIMEOUT_MS / 1000,
    )}s`,
  );
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

async function runCommandCodePrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = COMMANDCODE_PROMPT_TIMEOUT_MS,
  home?: string,
): Promise<string> {
  const args = buildCommandCodeCliArgs({ model });
  log(`Calling ${label} prompt (agent=commandcode-cli, model=${model})`);
  const result = await spawnWithInputAndTimeout(
    COMMANDCODE_CLI_BIN,
    args,
    workspace,
    prompt,
    timeoutMs,
    commandCodeEnvForHome(home),
    formatCommandCodePromptTimeoutMessage(label, model, timeoutMs),
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `commandcode ${label} exited ${result.exitCode}: ${truncateForLog(
        result.stderr || result.stdout,
        1000,
      )}`,
    );
  }
  log(
    `${label} prompt complete via commandcode: stdout=${result.stdout.length} chars stderr=${result.stderr.length} chars`,
  );
  return result.stdout;
}

function spawnWithInputAndTimeout(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
  timeoutMessage = `commandcode prompt timed out after ${Math.round(timeoutMs / 1000)}s`,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
      reject(new Error(timeoutMessage));
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
    child.stdin?.on('error', (error: Error) => {
      // The CLI may exit before consuming stdin; include it in diagnostics
      // without racing the child close/error path.
      stderr += `\n[stdin error: ${error.message}]`;
    });
    child.stdin?.end(input);
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
