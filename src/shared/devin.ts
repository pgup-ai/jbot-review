import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelName } from './model.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
  type VerifiableFinding,
} from './prompt.ts';
import { parseFindingVerdicts, parseReview, type TokenUsageRecorder } from './opencode.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const DEVIN_PROMPT_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 2_000;

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
}

export function buildDevinCliArgs(input: DevinCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    '--permission-mode',
    'auto',
    '--prompt-file',
    input.promptFile,
    '--export',
    input.exportFile,
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  args.push('-p');
  return args;
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
  void options.onTokenUsage;
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(prContext, guidelines, options.lensAddendum ?? '');
  log(`Prompt assembled (${label}, devin): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runDevinPrompt(workspace, model, prompt, label, log, options.timeoutMs);
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via devin: ${message}`);
    const repaired = await runDevinPrompt(
      workspace,
      model,
      [prompt, '## Previous invalid response', raw, buildJsonRepairPrompt(message)].join('\n\n'),
      `${label}-repair`,
      log,
      options.timeoutMs,
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
  void onTokenUsage;
  const raw = await runDevinPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    timeoutMs,
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
  void onTokenUsage;
  const raw = await runDevinPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    timeoutMs,
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
  void onTokenUsage;
  const raw = await runDevinPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    timeoutMs,
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
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-devin-'));
  const promptFile = join(dir, 'prompt.txt');
  const exportFile = join(dir, 'conversation.atif');
  writeFileSync(promptFile, prompt, { mode: 0o600 });
  const args = buildDevinCliArgs({ model, promptFile, exportFile });
  log(`Calling ${label} prompt (agent=devin-cli, model=${model})`);
  try {
    const result = await spawnWithTimeout('devin', args, workspace, timeoutMs);
    if (result.exitCode !== 0) {
      throw new Error(
        `devin ${label} exited ${result.exitCode}: ${truncateForLog(
          result.stderr || result.stdout,
          1000,
        )}`,
      );
    }
    log(
      `${label} prompt complete via devin: stdout=${result.stdout.length} chars stderr=${result.stderr.length} chars`,
    );
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... [truncated]`;
}
