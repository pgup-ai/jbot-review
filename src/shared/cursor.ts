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

const CURSOR_PROMPT_TIMEOUT_MS = 20 * 60_000;
const CURSOR_MODEL_LIST_TIMEOUT_MS = 60_000;
const CURSOR_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const CURSOR_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

export const CURSOR_PROVIDER_ID = 'cursor';
// Cursor's installer provides the `cursor-agent` binary (it also exposes a bare
// `agent` alias; use the namespaced name so a stray `agent` on PATH is never
// invoked).
export const CURSOR_CLI_BIN = 'cursor-agent';

export function isCursorProvider(providerID: string): boolean {
  return providerID === CURSOR_PROVIDER_ID;
}

export interface CursorCliArgsInput {
  model: string;
}

/**
 * Builds the headless cursor-agent argv. Read-only is enforced in layers
 * (invariant #8): `--mode plan` is Cursor's read-only/planning mode ("analyze,
 * propose plans, no edits"), and `--force`/`--yolo` are NEVER emitted, so the
 * write/shell tools that `-p` would otherwise expose cannot be force-allowed.
 * The prompt is delivered on stdin (see runCursorPrompt), not argv, so it is
 * absent here.
 */
export function buildCursorCliArgs(input: CursorCliArgsInput): string[] {
  const { modelID } = parseModelName(input.model);
  const args = [
    // -p (--print) is the non-interactive mode; text output is the model's
    // final answer, from which parseReview extracts the JSON object.
    '-p',
    '--output-format',
    'text',
    // --trust skips the workspace-trust prompt in headless mode.
    '--trust',
    '--mode',
    'plan',
  ];
  if (modelID !== 'default') args.push('--model', modelID);
  return args;
}

/**
 * Child environment carrying the Cursor credential. The key is passed via env,
 * never argv, so it cannot leak through the process list; setting it explicitly
 * also overrides any ambient CURSOR_API_KEY so CI/local state can't shadow the
 * selected credential. NO_OPEN_BROWSER keeps any auth path strictly headless.
 */
export function cursorEnvForKey(apiKey: string): NodeJS.ProcessEnv {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('Missing Cursor API key. Set cursor-api-key or CURSOR_API_KEY.');
  }
  return { ...process.env, CURSOR_API_KEY: key, NO_OPEN_BROWSER: '1' };
}

export function formatCursorPromptTimeoutMessage(
  label: string,
  model: string,
  timeoutMs: number,
): string {
  return `cursor ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`;
}

/**
 * Lists the models the supplied key can use via `cursor-agent models`, for the
 * startup observability log (mirrors listCommandCodeModels and opencode's
 * listProviderModels). Best-effort: the runner logs and continues on failure.
 */
export async function listCursorModels(workspace: string, apiKey: string): Promise<string[]> {
  const result = await spawnWithTimeout(CURSOR_CLI_BIN, ['models'], {
    cwd: workspace,
    env: cursorEnvForKey(apiKey),
    timeoutMs: CURSOR_MODEL_LIST_TIMEOUT_MS,
    timeoutMessage: `cursor model listing timed out after ${Math.round(
      CURSOR_MODEL_LIST_TIMEOUT_MS / 1000,
    )}s`,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `cursor model listing exited ${result.exitCode}: ${truncateForLog(
        result.stderr || result.stdout,
        1000,
      )}`,
    );
  }
  return parseCursorModelList(result.stdout);
}

/**
 * Parses `cursor-agent models` output. Each model line is `<id> - <displayName>`;
 * the `Available models` header, blank lines, and the trailing `Tip:` line have
 * no ` - ` separator and are skipped. Exported for unit testing (pure).
 */
export function parseCursorModelList(output: string): string[] {
  const models: string[] = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*) - \S/);
    if (match) models.push(match[1]);
  }
  return models;
}

export async function runCursorReview(
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
    apiKey?: string;
  } = {},
): Promise<ReviewResult> {
  // Cursor's text output carries no token usage; mirror CommandCode and skip it.
  void options.onTokenUsage;
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(prContext, guidelines, options.lensAddendum ?? '');
  log(`Prompt assembled (${label}, cursor): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runCursorPrompt(
    workspace,
    model,
    prompt,
    label,
    log,
    options.apiKey,
    options.timeoutMs,
  );
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via cursor: ${message}`);
    const repaired = await runCursorPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: CURSOR_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: CURSOR_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options.apiKey,
      options.timeoutMs,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runCursorAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<AddressedPriorComment[]> {
  void onTokenUsage;
  const raw = await runCursorPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    apiKey,
    timeoutMs,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runCursorGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<Finding[]> {
  void onTokenUsage;
  const raw = await runCursorPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    apiKey,
    timeoutMs,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runCursorChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<string> {
  void onTokenUsage;
  const raw = await runCursorPrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    apiKey,
    timeoutMs,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runCursorFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  apiKey?: string,
): Promise<FindingVerdict[] | undefined> {
  void onTokenUsage;
  const raw = await runCursorPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings),
    'finding-verification',
    log,
    apiKey,
    timeoutMs,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runCursorPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  apiKey: string | undefined,
  timeoutMs = CURSOR_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const args = buildCursorCliArgs({ model });
  log(`Calling ${label} prompt (agent=cursor-cli, model=${model})`);
  // The review prompt routinely exceeds Linux's 128KB single-argv limit, so it
  // goes on stdin, not as a positional argument.
  const result = await spawnWithTimeout(CURSOR_CLI_BIN, args, {
    cwd: workspace,
    input: prompt,
    env: cursorEnvForKey(apiKey ?? ''),
    timeoutMs,
    timeoutMessage: formatCursorPromptTimeoutMessage(label, model, timeoutMs),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `cursor ${label} exited ${result.exitCode}: ${truncateForLog(
        result.stderr || result.stdout,
        1000,
      )}`,
    );
  }
  log(
    `${label} prompt complete via cursor: stdout=${result.stdout.length} chars stderr=${result.stderr.length} chars`,
  );
  return result.stdout;
}
