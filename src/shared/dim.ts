import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseModelName, spawnWithTimeout, truncateForLog } from '@symma/protocol';
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
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const DIM_PROMPT_TIMEOUT_MS = 20 * 60_000;
const DIM_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const DIM_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

export const DIM_PROVIDER_ID = 'dim';
export const DIM_CLI_BIN = 'dim';

/**
 * Tool allowlist for review sessions. `--tools` is the ONLY per-tool lever that
 * works — `--disallowed-tools` and `permissions.json` are accepted and then
 * silently ignored (measured 2026-08-17, dimcode 0.3.15), so never configure dim
 * through those. This set drops `write`/`edit` and `skill`; the last matters
 * because dim discovers repo-local skills from `.agents/skills` and `./skills`,
 * which are PR-author-controlled.
 */
const DIM_ALLOWED_TOOLS = 'read,glob,grep,exec';

export function isDimProvider(providerID: string): boolean {
  return providerID === DIM_PROVIDER_ID;
}

/**
 * dim reads its OAuth token store from `$DIMCODE_HOME/auth.json` — the override
 * root, NOT the `v2/` subdir that everything else (sqlite, config, logs) nests
 * under. Mirroring the source layout yields a silent "Not authenticated".
 */
function dimAuthPath(home: string): string {
  return join(home, 'auth.json');
}

/** Validates the secret at setup and returns it minified for the per-spawn copies. */
export function assertValidDimAuth(credential: string): string {
  const content = credential.trim();
  if (!content) {
    throw new Error('Missing dim credential. Set dim-auth/DIM_AUTH_JSON.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(
      'Invalid DIM_AUTH_JSON: expected the JSON contents of ~/.dimcode/v2/auth.json.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid DIM_AUTH_JSON: expected a JSON object.');
  }
  return JSON.stringify(parsed);
}

/**
 * One throwaway home per spawn, under the run's parent dir. dim keeps its whole
 * store in a single `dimcode.sqlite`, so concurrent sessions sharing a home die
 * on "database is locked" — the same race kilo (an opencode fork) hits. The
 * parent is what the runner registers for signal cleanup; this only has to
 * remove its own directory on the happy path.
 */
function createDimSessionHome(parent: string, auth: string): string {
  const home = mkdtempSync(join(parent, 'session-'));
  writeFileSync(dimAuthPath(home), `${auth}\n`, { mode: 0o600 });
  return home;
}

/** Splits jbot's `dim/<dimProvider>/<model>` tail into dim's own two flags. */
function parseDimModel(model: string): { provider?: string; model?: string } {
  const { modelID } = parseModelName(model);
  if (modelID === 'default') return {};
  const slash = modelID.indexOf('/');
  if (slash < 0) return { model: modelID };
  return { provider: modelID.slice(0, slash), model: modelID.slice(slash + 1) };
}

export function buildDimCliArgs(model: string): string[] {
  const args = [
    'exec',
    // Mandatory pair. `--policy read-only` alone still permits every `git *`
    // including commit/reset --hard; `--mode plan` is what declines them.
    '--mode',
    'plan',
    '--policy',
    'read-only',
    '--tools',
    DIM_ALLOWED_TOOLS,
    '--json',
    '--stdin',
  ];
  const { provider, model: modelID } = parseDimModel(model);
  if (provider) args.push('--provider', provider);
  if (modelID) args.push('--model', modelID);
  return args;
}

const DIM_ENV_KEYS = [
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
  'CI',
] as const;

export function dimEnvForHome(home: string | undefined): NodeJS.ProcessEnv {
  const value = home?.trim();
  if (!value) {
    throw new Error('Missing dim home. A temp DIMCODE_HOME is required for auth.');
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of DIM_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = value;
  env.DIMCODE_HOME = value;
  // The CLI self-updates by default, which would drift from the pinned image.
  env.DIMCODE_DISABLE_AUTOUPDATE = '1';
  return env;
}

/** Parent dir for per-spawn homes, plus the validated secret they each copy. */
export interface DimRuntime {
  parent: string;
  auth: string;
}

interface DimRunOutcome {
  text: string;
  usage?: PromptTokenUsage;
  failure?: string;
}

/**
 * Reads dim's `--json` JSONL. Assistant text arrives as `text:delta` chunks —
 * `message:*` carry ids only — and the terminal `run:ended` holds both the
 * status and the run's token usage.
 */
export function parseDimEventStream(stdout: string): DimRunOutcome {
  let text = '';
  let usage: PromptTokenUsage | undefined;
  let failure: string | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.eventType === 'text:delta' && typeof payload.delta === 'string') {
      text += payload.delta;
      continue;
    }
    if (event.eventType !== 'run:ended') continue;
    if (payload.status !== 'completed') {
      const error = (payload.error ?? {}) as Record<string, unknown>;
      failure =
        typeof error.message === 'string'
          ? error.message
          : `run ${String(payload.status)} (${String(payload.reason)})`;
    }
    const raw = (payload.usage ?? {}) as Record<string, unknown>;
    const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
    usage = {
      input: num(raw.promptTokens),
      output: num(raw.completionTokens),
      reasoning: 0,
      cacheRead: num(raw.cacheReadTokens),
      cacheWrite: 0,
    };
  }
  return { text: text.trim(), usage, failure };
}

export async function runDimReview(
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
    runtime?: DimRuntime;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
  );
  log(`Prompt assembled (${label}, dim): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const raw = await runDimPrompt(workspace, model, prompt, label, log, options);
  try {
    return parseReview(raw, label, log, { strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response unparseable; sending one JSON repair prompt via dim: ${message}`);
    const repaired = await runDimPrompt(
      workspace,
      model,
      buildJsonRepairFollowupPrompt({
        originalPrompt: prompt,
        invalidResponse: raw,
        parseError: message,
        promptBudgetBytes: DIM_REPAIR_PROMPT_BUDGET_BYTES,
        responseBudgetBytes: DIM_REPAIR_RESPONSE_BUDGET_BYTES,
      }),
      `${label}-repair`,
      log,
      options,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runDimAddressedPriorCommentsCheck(
  workspace: string,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<AddressedPriorComment[]> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleAddressedPriorCommentsPrompt(prContext),
    'addressed-prior-comments',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runDimGuidelineComplianceCheck(
  workspace: string,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<Finding[]> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleGuidelineCompliancePrompt(prContext, guidelines),
    'guideline-compliance',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runDimChangesSinceLastReview(
  workspace: string,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<string> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
    'changes-since-last-review',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

export async function runDimFindingVerification(
  workspace: string,
  model: string,
  prContext: string,
  findings: VerifiableFinding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  runtime?: DimRuntime,
): Promise<FindingVerdict[] | undefined> {
  const raw = await runDimPrompt(
    workspace,
    model,
    assembleFindingVerificationPrompt(prContext, findings, true),
    'finding-verification',
    log,
    { timeoutMs, onTokenUsage, runtime },
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function runDimPrompt(
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  options: { timeoutMs?: number; onTokenUsage?: TokenUsageRecorder; runtime?: DimRuntime },
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DIM_PROMPT_TIMEOUT_MS;
  const runtime = options.runtime;
  if (!runtime)
    throw new Error('Missing dim runtime. A validated auth and parent dir are required.');
  const home = createDimSessionHome(runtime.parent, runtime.auth);
  log(`Calling ${label} prompt (agent=dim-cli, model=${model})`);
  let result;
  try {
    result = await spawnWithTimeout(DIM_CLI_BIN, buildDimCliArgs(model), {
      cwd: workspace,
      env: dimEnvForHome(home),
      input: prompt,
      timeoutMs,
      timeoutMessage: `dim ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const { text, usage, failure } = parseDimEventStream(result.stdout);
  if (usage) options.onTokenUsage?.(usage, model, label);
  if (result.exitCode !== 0 || failure) {
    throw new Error(
      `dim ${label} failed (exit ${result.exitCode}): ${truncateForLog(
        failure ?? result.stderr ?? '',
        1000,
      )}`,
    );
  }
  log(`${label} prompt complete via dim: ${text.length} chars`);
  if (!text) {
    throw new Error(
      `dim ${label} produced no final message; stderr: ${truncateForLog(result.stderr, 1000)}`,
    );
  }
  return text;
}
