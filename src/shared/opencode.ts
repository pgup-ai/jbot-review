import {
  createOpencode,
  type AssistantMessage,
  type OpencodeClient,
  type Part,
  type ServerOptions,
  type SessionStatus,
} from '@opencode-ai/sdk';

import { isContext7QuotaError } from './context7.ts';
import { parseModelName } from './model.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
} from './prompt.ts';
import { isFiniteNumber } from './text.ts';
import type {
  AddressedPriorComment,
  Finding,
  FindingConfidence,
  FindingKind,
  FindingVerdict,
  ReviewResult,
  Severity,
} from './types.ts';

const READY_TIMEOUT_MS = 15_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 15 * 60_000;
const PROMPT_POLL_INTERVAL_MS = 2_000;
const PROMPT_POLL_REQUEST_TIMEOUT_MS = 10_000;
const PROMPT_PROGRESS_LOG_MS = 60_000;
const CONTEXT7_MCP_NAME = 'context7';
const CONTEXT7_MCP_URL = 'https://mcp.context7.com/mcp';
const CONTEXT7_MCP_TIMEOUT_MS = 15_000;
const VALID_FINDING_KINDS = new Set<FindingKind>([
  'bug',
  'security',
  'performance',
  'maintainability',
  'architecture',
  'test',
  'docs',
  'investigate',
]);
const VALID_CONFIDENCES = new Set<FindingConfidence>(['high', 'medium', 'low']);

export interface ProviderKeyConfig {
  providerID: string;
  apiKey: string;
  promptCache?: boolean;
}

/**
 * Builds the opencode config object that embeds the API key for the selected
 * provider, plus any secondary providers needed by aux-model sessions. This is
 * the official way to authenticate opencode (replaces the old "set env var"
 * pattern).
 *
 * Permissions enforce read-only at the CONFIG level, not just via the plan
 * agent: edits are denied outright (never "ask" — an interactive prompt
 * would hang a headless run), and file access outside the workspace is
 * denied. Bash stays allowed: the review needs git diff/log/grep.
 *
 * `modelOptions` pass through opencode to the provider SDK for the MAIN
 * model only — the lever for capping reasoning spend on heavy models (e.g.
 * {"reasoningEffort":"medium"} for OpenAI, thinking budgets for Anthropic).
 *
 * `promptCache` sets the provider's `setCacheKey` option (opencode's
 * promptCacheKey toggle, default off in the SDK). Parallel review shards and
 * re-reviews of the same PR share a byte-identical prompt prefix (base
 * instructions + guidelines + PR context), so caching cuts input-token cost
 * on models that honor it. Runner-level model capability checks should pass
 * `false` for models known to reject promptCacheKey; cache hits are observable
 * in the per-session token log (`formatTokenUsage`). When disabled, the key is
 * OMITTED entirely rather than sent as `false` — the off switch exists for
 * providers that reject unknown option keys, so it must not send the key at
 * all. Exported for unit testing (pure).
 */
export function buildConfig(
  providerID: string,
  modelID: string,
  apiKey: string,
  modelOptions?: Record<string, unknown>,
  promptCache = true,
  additionalProviderKeys: ProviderKeyConfig[] = [],
): ServerOptions['config'] {
  const hasModelOptions = modelOptions && Object.keys(modelOptions).length > 0;
  const providerConfig: NonNullable<ServerOptions['config']>['provider'] = {
    [providerID]: {
      options: { apiKey, ...(promptCache ? { setCacheKey: true } : {}) },
      ...(hasModelOptions ? { models: { [modelID]: { options: modelOptions } } } : {}),
    },
  };
  for (const providerKey of additionalProviderKeys) {
    if (!providerKey.providerID || providerKey.providerID === providerID) continue;
    const providerPromptCache = providerKey.promptCache ?? promptCache;
    providerConfig[providerKey.providerID] = {
      options: {
        apiKey: providerKey.apiKey,
        ...(providerPromptCache ? { setCacheKey: true } : {}),
      },
    };
  }
  return {
    provider: providerConfig,
    permission: {
      edit: 'deny',
      external_directory: 'deny',
    },
  };
}

export interface TokenUsageInfo {
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface PromptTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  creditCost?: number;
  acuCost?: number;
}

export type TokenUsageRecorder = (usage: PromptTokenUsage, model: string) => void;

export function extractPromptTokenUsage(info: TokenUsageInfo): PromptTokenUsage | undefined {
  const tokens = info.tokens;
  if (!tokens) return undefined;
  const cache = tokens.cache ?? {};
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: cache.read ?? 0,
    cacheWrite: cache.write ?? 0,
    ...(isFiniteNumber(info.cost) ? { costUsd: info.cost } : {}),
  };
}

/**
 * One-line token/cost summary for a completed session. Defensive about
 * missing fields: gateways like opencode-go may not populate every counter,
 * and cache read/write are the signal for whether prompt caching is actually
 * working (cache.read > 0 on a later shard or re-review means a hit).
 * Exported for unit testing (pure).
 */
export function formatTokenUsage(info: TokenUsageInfo): string {
  const tokens = info.tokens ?? {};
  const cache = tokens.cache ?? {};
  const parts = [
    `input=${tokens.input ?? 0}`,
    `output=${tokens.output ?? 0}`,
    `reasoning=${tokens.reasoning ?? 0}`,
    `cache(read=${cache.read ?? 0} write=${cache.write ?? 0})`,
  ];
  if (isFiniteNumber(info.cost)) parts.push(`cost=$${info.cost.toFixed(4)}`);
  return `tokens: ${parts.join(' ')}`;
}

/**
 * Bounds in-flight model sessions. Free / throttled provider tiers serialize
 * concurrent requests on one API key upstream anyway — observed as a
 * flash-tier session taking 7+ minutes while queued behind parallel shards.
 * Capping concurrency on OUR side keeps each session's deadline measuring
 * model time, not queue time. 0 = unlimited.
 */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve) => this.queue.push(resolve));
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  isBusy(): boolean {
    return this.active > 0 || this.queue.length > 0;
  }
}

let sessionSlots: Semaphore | undefined;
let sessionSlotLimit = 0;
const clientDirectories = new WeakMap<OpencodeClient, string>();

export function configureSessionConcurrency(limit: number): void {
  const normalized = Math.max(0, Math.floor(limit));
  if (normalized === sessionSlotLimit) return;
  if (sessionSlots?.isBusy()) return;
  sessionSlotLimit = normalized;
  sessionSlots = normalized > 0 ? new Semaphore(normalized) : undefined;
}

/**
 * Serializes the `process.chdir(workspace) → createOpencode → restoreCwd`
 * critical section so concurrent startOpencode calls don't race on the
 * process-global cwd. Each call awaits the previous one before mutating.
 */
let cwdChain: Promise<void> = Promise.resolve();

/**
 * Starts an opencode server with the given provider API key embedded in its
 * config, and returns an SDK client pointed at it. The server's child process
 * inherits the current working directory, so we set cwd to the workspace
 * before spawning and restore it immediately after startup. The read-only
 * "plan" agent is used by default — it cannot edit files, which keeps the
 * review safe and avoids non-interactive permission prompts that would hang a
 * CI run.
 */
export async function startOpencode(
  workspace: string,
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
  options: {
    modelOptions?: Record<string, unknown>;
    port?: number;
    promptCache?: boolean;
    additionalProviderKeys?: ProviderKeyConfig[];
  } = {},
): Promise<{ client: OpencodeClient; stop: () => void }> {
  // Serialize against other startOpencode calls so the chdir → spawn → restore
  // sequence runs atomically. This is the only safe way to scope cwd to the
  // child process while using the SDK's `createOpencode` factory, which
  // doesn't accept a cwd option directly.
  const previous = cwdChain;
  let release: () => void = () => undefined;
  cwdChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const previousCwd = process.cwd();
  let restoreCwd = () => {
    /* no-op before assignment */
    try {
      process.chdir(previousCwd);
    } catch {
      /* best effort */
    }
  };
  let lockReleased = false;
  const restoreAndRelease = () => {
    restoreCwd();
    if (!lockReleased) {
      lockReleased = true;
      release();
    }
  };

  try {
    // Move chdir inside try so the mutex is released on any error.
    process.chdir(workspace);
    log(`opencode cwd: ${process.cwd()}`);

    restoreCwd = () => {
      try {
        process.chdir(previousCwd);
      } catch {
        /* best effort */
      }
    };
    const config = buildConfig(
      providerID,
      modelID,
      apiKey,
      options.modelOptions,
      options.promptCache ?? true,
      options.additionalProviderKeys,
    );
    const { client, server } = await createOpencode({
      hostname: '127.0.0.1',
      // Fixed port means two runs on one host collide (e.g. the webhook app
      // plus a CI job on a self-hosted runner); override per process.
      port: options.port ?? parsePortEnv('JBOT_OPENCODE_PORT', 4096),
      timeout: READY_TIMEOUT_MS,
      config,
    });
    restoreAndRelease();

    log(`opencode server listening at ${server.url} (provider=${providerID} model=${modelID})`);
    clientDirectories.set(client, workspace);

    const stop = () => {
      try {
        server.close();
      } catch (error) {
        log(`opencode server close failed: ${formatUnknownError(error)}`);
      }
    };

    return { client, stop };
  } catch (err) {
    // Restore cwd on failure and release the lock so the next caller can proceed.
    restoreAndRelease();
    throw err;
  }
}

export async function listProviderModels(
  client: OpencodeClient,
  providerID: string,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<string[]> {
  const result = await withTimeout(
    client.provider.list(),
    timeoutMs,
    `provider model listing timed out after ${timeoutMs}ms`,
  );
  const data = result.data;
  if (!isProviderListData(data)) return [];

  const provider = data.all.find((item) => item.id === providerID);
  if (!provider) return [];

  return Object.keys(provider.models)
    .map((modelID) => `${providerID}/${modelID}`)
    .sort();
}

export async function enableContext7Mcp(
  client: OpencodeClient,
  apiKey: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return false;
  let added = false;

  try {
    await client.mcp.add({
      body: {
        name: CONTEXT7_MCP_NAME,
        config: {
          type: 'remote',
          url: CONTEXT7_MCP_URL,
          enabled: true,
          headers: {
            CONTEXT7_API_KEY: trimmedKey,
            Accept: 'application/json, text/event-stream',
          },
          timeout: CONTEXT7_MCP_TIMEOUT_MS,
        },
      },
    });
    added = true;
    await client.mcp.connect({ path: { name: CONTEXT7_MCP_NAME } });
    log('Context7 MCP enabled for external API/SDK documentation checks.');
    return true;
  } catch (error) {
    if (added) await disableContext7Mcp(client, log);
    const detail = formatContext7Error(error, trimmedKey);
    const note = isContext7QuotaError(detail)
      ? 'Context7 out of credit or rate-limited; review continues with the framework-behavior abstention fallback (refill credit or rotate CONTEXT7_API_KEY to re-enable docs checks)'
      : 'Context7 MCP unavailable; continuing without it';
    log(`${note}: ${detail}`);
    return false;
  }
}

export async function disableContext7Mcp(
  client: OpencodeClient,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await client.mcp.disconnect({ path: { name: CONTEXT7_MCP_NAME } });
  } catch (error) {
    log(`Context7 MCP disconnect skipped: ${formatContext7Error(error)}`);
  }
}

function isProviderListData(value: unknown): value is {
  all: Array<{ id: string; models: Record<string, unknown> }>;
} {
  if (!isRecord(value) || !Array.isArray(value.all)) return false;
  return value.all.every(
    (item) => isRecord(item) && typeof item.id === 'string' && isRecord(item.models),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function formatContext7Error(error: unknown, secret = ''): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = secret
    ? message.replace(new RegExp(escapeRegExp(secret), 'gi'), '[redacted]')
    : message;
  return redacted.replace(/ctx7sk-[A-Za-z0-9_-]+/gi, '[redacted]');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parsePortEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : defaultValue;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // If the timeout wins, keep any later rejection from the original operation
  // from surfacing as an unhandled rejection.
  void promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs one review session and returns structured findings.
 *
 * Uses the current SDK API: `client.session.prompt()` (replaces the legacy
 * `chat()` from 0.4.x). The agent runs as the read-only "plan" agent by
 * default. An optional lens addendum (REVIEW_LENSES) turns the session into
 * a focused recall pass; the label keeps log lines distinguishable when
 * several passes run in parallel.
 *
 * Main-review output is strict: if the response fails JSON parsing, ONE
 * repair prompt is sent in the same session (the model sees its own
 * malformed output) before the run fails.
 */
export async function runReview(
  client: OpencodeClient,
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
  log(`Prompt assembled (${label}): ${prompt.length} chars, guidelines=${!!guidelines}`);

  const { raw, sessionID } = await promptPlanAgent(
    client,
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
    log(`${label} response unparseable; sending one JSON repair prompt: ${message}`);
    const repaired = await promptPlanAgentInSession(
      client,
      model,
      sessionID,
      buildJsonRepairPrompt(message),
      `${label}-repair`,
      log,
      options.timeoutMs,
      options.onTokenUsage,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

export async function runAddressedPriorCommentsCheck(
  client: OpencodeClient,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<AddressedPriorComment[]> {
  const prompt = assembleAddressedPriorCommentsPrompt(prContext);
  const { raw } = await promptPlanAgent(
    client,
    model,
    prompt,
    'addressed-prior-comments',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

export async function runGuidelineComplianceCheck(
  client: OpencodeClient,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<Finding[]> {
  const prompt = assembleGuidelineCompliancePrompt(prContext, guidelines);
  const { raw } = await promptPlanAgent(
    client,
    model,
    prompt,
    'guideline-compliance',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
}

export async function runChangesSinceLastReview(
  client: OpencodeClient,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const prompt = assembleChangesSinceLastReviewPrompt(prContext, deltaContext);
  const { raw } = await promptPlanAgent(
    client,
    model,
    prompt,
    'changes-since-last-review',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

/**
 * Adversarially verifies blocking findings in a dedicated session. Returns
 * undefined when the verifier output cannot be used — the caller MUST treat
 * that as "verification unavailable" and keep the findings (fail-open): a
 * broken precision filter must never become a recall hole.
 */
export async function runFindingVerification(
  client: OpencodeClient,
  model: string,
  prContext: string,
  findings: Finding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<FindingVerdict[] | undefined> {
  const prompt = assembleFindingVerificationPrompt(
    prContext,
    findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
    })),
  );
  const { raw } = await promptPlanAgent(
    client,
    model,
    prompt,
    'finding-verification',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

async function promptPlanAgent(
  client: OpencodeClient,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<{ raw: string; sessionID: string }> {
  log(`Creating ${label} session`);
  // The title makes parallel sessions distinguishable in opencode's own
  // session list when debugging a run.
  const created = await client.session.create({
    body: { title: `jbot-review ${label}` },
    query: queryDirectory(client),
  });
  const session = created.data;
  if (!session) throw new Error(`Failed to create ${label} session`);
  log(`${label} session created: ${session.id}`);

  const raw = await promptPlanAgentInSession(
    client,
    model,
    session.id,
    prompt,
    label,
    log,
    timeoutMs,
    onTokenUsage,
  );
  return { raw, sessionID: session.id };
}

async function promptPlanAgentInSession(
  client: OpencodeClient,
  model: string,
  sessionID: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = PROMPT_TIMEOUT_MS,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const release = sessionSlots ? await sessionSlots.acquire() : undefined;
  try {
    return await promptInSessionHoldingSlot(
      client,
      model,
      sessionID,
      prompt,
      label,
      log,
      timeoutMs,
      onTokenUsage,
    );
  } finally {
    release?.();
  }
}

async function promptInSessionHoldingSlot(
  client: OpencodeClient,
  model: string,
  sessionID: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const { providerID, modelID } = parseModelName(model);

  // A follow-up prompt in an existing session must not return the previous
  // completed assistant message: remember its id and wait for a NEWER one.
  const previous = await getLatestAssistantMessage(client, sessionID, label);
  const previousMessageID = previous?.info.id;

  log(`Calling ${label} prompt (agent=plan, provider=${providerID} model=${modelID})`);
  const promptRes = await client.session.promptAsync({
    path: { id: sessionID },
    query: queryDirectory(client),
    body: {
      model: { providerID, modelID },
      agent: 'plan',
      // Defense-in-depth alongside the plan agent and the config-level
      // permission.edit deny: mutating tools are off for every prompt.
      // Bash stays on — the review needs git diff/log/grep.
      tools: { write: false, edit: false, patch: false },
      parts: [{ type: 'text', text: prompt }],
    },
  });
  const promptError = getResultError(promptRes);
  if (promptError) throw new Error(`opencode ${label} prompt was rejected: ${promptError}`);

  let data;
  try {
    data = await waitForAssistantMessage(
      client,
      sessionID,
      label,
      log,
      previousMessageID,
      timeoutMs,
    );
  } catch (error) {
    // A timed-out or failed wait leaves the session generating (and
    // spending tokens) until the server shuts down; stop it now.
    await abortSessionBestEffort(client, sessionID, label, log);
    throw error;
  }

  const parts = data.parts;
  log(
    `${label} prompt complete: parts=${parts.length} (types: ${parts.map((p) => p.type).join(', ')})`,
  );
  log(`${label} ${formatTokenUsage(data.info)}`);
  const usage = extractPromptTokenUsage(data.info);
  if (usage) onTokenUsage?.(usage, model);

  const textParts = parts.filter((p) => p.type === 'text' && p.text);
  // No text part (e.g. the model exhausted its budget on reasoning) must
  // surface as a parse failure so the repair loop fires — defaulting to
  // '{}' would silently score the session as "no findings".
  const raw = textParts
    .map((p) => p.text)
    .join('\n\n')
    .trim();
  if (!raw)
    log(`${label} response contained no text part (types: ${parts.map((p) => p.type).join(', ')})`);
  log(`Extracted ${label} text: ${raw.length} chars from ${textParts.length} text part(s)`);
  return raw;
}

async function abortSessionBestEffort(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await withTimeout(
      client.session.abort({ path: { id: sessionID }, query: queryDirectory(client) }),
      PROMPT_POLL_REQUEST_TIMEOUT_MS,
      `abort timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms`,
    );
    log(`Aborted ${label} session ${sessionID}.`);
  } catch (error) {
    log(
      `(failed to abort ${label} session ${sessionID}: ${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

async function waitForAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
  ignoreMessageID?: string,
  timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<{ info: AssistantMessage; parts: ReadonlyArray<{ type: string; text?: string }> }> {
  const startedAt = Date.now();
  let lastStatus = 'unknown';
  let lastProgressLogAt = startedAt;

  while (Date.now() - startedAt < timeoutMs) {
    const latest = await getLatestAssistantMessage(client, sessionID, label);
    const message = latest && latest.info.id === ignoreMessageID ? undefined : latest;
    if (message?.info.error) {
      throw new Error(`opencode ${label} prompt failed: ${formatUnknownError(message.info.error)}`);
    }

    const status = await getSessionStatus(client, sessionID, label);
    if (status) lastStatus = describeSessionStatus(status);
    if (message && (status?.type === 'idle' || message.info.time.completed)) {
      return {
        info: message.info,
        parts: message.parts,
      };
    }

    const now = Date.now();
    if (now - lastProgressLogAt >= PROMPT_PROGRESS_LOG_MS) {
      log(
        `${label} prompt still running (${Math.round((now - startedAt) / 1000)}s, ${lastStatus})`,
      );
      lastProgressLogAt = now;
    }

    await sleep(PROMPT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `opencode ${label} prompt did not finish within ${Math.round(
      timeoutMs / 1000,
    )}s (last status: ${lastStatus})`,
  );
}

async function getLatestAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  label: string,
): Promise<
  { info: AssistantMessage; parts: ReadonlyArray<{ type: string; text?: string }> } | undefined
> {
  const result = await withTimeout(
    client.session.messages({ path: { id: sessionID }, query: queryDirectory(client) }),
    PROMPT_POLL_REQUEST_TIMEOUT_MS,
    `opencode ${label} message polling timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms (session=${sessionID})`,
  );
  const error = getResultError(result);
  if (error) throw new Error(`opencode ${label} message polling failed: ${error}`);

  const messages = result.data ?? [];
  for (const message of [...messages].reverse()) {
    if (message.info.role !== 'assistant') continue;
    return {
      info: message.info,
      parts: (message.parts ?? []).map(toTextReadablePart),
    };
  }
  return undefined;
}

async function getSessionStatus(
  client: OpencodeClient,
  sessionID: string,
  label: string,
): Promise<SessionStatus | undefined> {
  const result = await withTimeout(
    client.session.status({ query: queryDirectory(client) }),
    PROMPT_POLL_REQUEST_TIMEOUT_MS,
    `opencode ${label} status polling timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms (session=${sessionID})`,
  );
  const error = getResultError(result);
  if (error) throw new Error(`opencode ${label} status polling failed: ${error}`);
  const statuses = result.data;
  return statuses?.[sessionID];
}

function toTextReadablePart(part: Part): { type: string; text?: string } {
  return part.type === 'text' ? { type: part.type, text: part.text } : { type: part.type };
}

function queryDirectory(client: OpencodeClient): { directory: string } | undefined {
  const directory = clientDirectories.get(client);
  return directory ? { directory } : undefined;
}

function describeSessionStatus(status: SessionStatus): string {
  if (status.type === 'retry') return `retry attempt ${status.attempt}: ${status.message}`;
  return status.type;
}

function getResultError(result: unknown): string | undefined {
  if (!isRecord(result) || !('error' in result) || result.error == null) return undefined;
  return formatUnknownError(result.error);
}

function formatUnknownError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2', 'P3', 'nit']);

/**
 * Defensively parses the agent's JSON. Main review output is strict so we
 * don't post a misleading "good to go" review when the reviewer response is
 * malformed; auxiliary checks stay best-effort. Exported for direct test coverage.
 */
export function parseReview(
  raw: string,
  label: string,
  log: (msg: string) => void,
  options: { strict?: boolean } = {},
): ReviewResult {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response was not valid JSON: ${message}`);
    log(`${label} response preview:\n${truncateForLog(raw, 2000)}`);
    if (options.strict) throw new Error(`opencode ${label} returned unparseable JSON: ${message}`);
    return {
      summary: 'The reviewer returned an unparseable response.',
      findings: [],
      addressedPriorComments: [],
    };
  }

  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const rawAddressed = Array.isArray(obj.addressedPriorComments) ? obj.addressedPriorComments : [];

  const findings: Finding[] = [];
  for (const item of rawFindings) {
    const f = item as Record<string, unknown>;
    if (
      typeof f.path === 'string' &&
      typeof f.line === 'number' &&
      // Line 0 is a deliberate file-level anchor; negative or fractional
      // lines are model noise.
      Number.isInteger(f.line) &&
      f.line >= 0 &&
      typeof f.title === 'string' &&
      typeof f.body === 'string' &&
      typeof f.severity === 'string' &&
      VALID_SEVERITIES.has(f.severity as Severity)
    ) {
      findings.push({
        path: f.path,
        line: f.line,
        severity: f.severity as Severity,
        kind:
          typeof f.kind === 'string' && VALID_FINDING_KINDS.has(f.kind as FindingKind)
            ? (f.kind as FindingKind)
            : undefined,
        confidence:
          typeof f.confidence === 'string' &&
          VALID_CONFIDENCES.has(f.confidence as FindingConfidence)
            ? (f.confidence as FindingConfidence)
            : undefined,
        title: f.title,
        body: f.body,
      });
    }
  }
  const addressedPriorComments: AddressedPriorComment[] = [];
  for (const item of rawAddressed) {
    const addressed = item as Record<string, unknown>;
    const id = typeof addressed.id === 'string' ? addressed.id.trim() : '';
    if (!id) continue;
    // Accept both casings: the schema uses camelCase, but models normalize
    // inconsistently and historic prompts used snake_case.
    const rawCommit =
      typeof addressed.addressedByCommit === 'string'
        ? addressed.addressedByCommit
        : typeof addressed.addressed_by_commit === 'string'
          ? addressed.addressed_by_commit
          : undefined;
    addressedPriorComments.push({
      id,
      addressedByCommit: rawCommit?.trim(),
    });
  }

  return { summary, findings, addressedPriorComments };
}

const VALID_VERDICTS = new Set<FindingVerdict['verdict']>(['confirmed', 'refuted', 'uncertain']);

/**
 * Parses the verifier's {"verdicts": [...]} response. Returns undefined when
 * the response is unusable so callers fail open. Individual malformed
 * entries are skipped; a finding without a verdict is treated as confirmed
 * by the caller. Exported for direct test coverage.
 */
export function parseFindingVerdicts(
  raw: string,
  findingCount: number,
  log: (msg: string) => void,
): FindingVerdict[] | undefined {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`finding-verification response was not valid JSON: ${message}`);
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.verdicts)) {
    log('finding-verification response had no "verdicts" array.');
    return undefined;
  }

  const verdicts: FindingVerdict[] = [];
  const seen = new Set<number>();
  for (const item of obj.verdicts) {
    const v = item as Record<string, unknown>;
    if (
      typeof v.index === 'number' &&
      Number.isInteger(v.index) &&
      v.index >= 0 &&
      v.index < findingCount &&
      !seen.has(v.index) &&
      typeof v.verdict === 'string' &&
      VALID_VERDICTS.has(v.verdict as FindingVerdict['verdict'])
    ) {
      seen.add(v.index);
      verdicts.push({
        index: v.index,
        verdict: v.verdict as FindingVerdict['verdict'],
        reason: typeof v.reason === 'string' ? v.reason : undefined,
      });
    }
  }
  return verdicts;
}

/**
 * Parses the "changes since last review" pass output. Unlike parseReview, an
 * unparseable or summary-less response yields '' (not a placeholder string) so
 * the caller OMITS the block — the pass fails open.
 */
export function parseChangesSinceLastReviewSummary(
  raw: string,
  label: string,
  log: (msg: string) => void,
): string {
  try {
    const obj = parseJsonObject(raw) as Record<string, unknown>;
    return typeof obj.summary === 'string' ? obj.summary.trim() : '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `${label} response was not valid JSON; omitting the changes-since-last-review block: ${message}`,
    );
    return '';
  }
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty response');

  const candidates = [
    trimmed,
    ...extractFencedCodeBlocks(trimmed),
    ...extractBalancedJsonObjects(trimmed),
  ];
  const seen = new Set<string>();
  let lastError: unknown;

  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      return JSON.parse(normalized);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('no parseable JSON object found');
}

function extractFencedCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = findBalancedObjectEnd(text, start);
    if (end !== -1) objects.push(text.slice(start, end + 1));
  }
  return objects;
}

function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function truncateForLog(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}\n...[truncated]`;
}
