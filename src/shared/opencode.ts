import {
  createOpencode,
  type AssistantMessage,
  type Event as OpencodeEvent,
  type OpencodeClient,
  type OutputFormat,
  type Part,
  type ServerOptions,
  type SessionStatus,
} from '@opencode-ai/sdk/v2';

import { parseModelName } from './model.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
} from './prompt.ts';
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
const FINDING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'line', 'severity', 'kind', 'confidence', 'title', 'body'],
  properties: {
    path: { type: 'string' },
    line: { type: 'integer', minimum: 0 },
    severity: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'nit'] },
    kind: {
      type: 'string',
      enum: [
        'bug',
        'security',
        'performance',
        'maintainability',
        'architecture',
        'test',
        'docs',
        'investigate',
      ],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    title: { type: 'string' },
    body: { type: 'string' },
  },
} as const;
const ADDRESSED_PRIOR_COMMENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'addressedByCommit', 'note'],
  properties: {
    id: { type: 'string' },
    addressedByCommit: { type: 'string' },
    note: { type: 'string' },
  },
} as const;
const REVIEW_OUTPUT_FORMAT: OutputFormat = {
  type: 'json_schema',
  retryCount: 1,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'findings'],
    properties: {
      summary: { type: 'string' },
      findings: { type: 'array', items: FINDING_JSON_SCHEMA },
    },
  },
};
const FINDINGS_OUTPUT_FORMAT: OutputFormat = {
  type: 'json_schema',
  retryCount: 1,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
      findings: { type: 'array', items: FINDING_JSON_SCHEMA },
    },
  },
};
const ADDRESSED_OUTPUT_FORMAT: OutputFormat = {
  type: 'json_schema',
  retryCount: 1,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['addressedPriorComments'],
    properties: {
      addressedPriorComments: { type: 'array', items: ADDRESSED_PRIOR_COMMENT_JSON_SCHEMA },
    },
  },
};
const VERDICTS_OUTPUT_FORMAT: OutputFormat = {
  type: 'json_schema',
  retryCount: 1,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['verdicts'],
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['index', 'verdict', 'reason'],
          properties: {
            index: { type: 'integer', minimum: 0 },
            verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
};

/**
 * Builds the opencode config object that embeds the API key for the selected
 * provider. This is the official way to authenticate opencode (replaces the
 * old "set env var" pattern).
 *
 * Permissions enforce read-only at the CONFIG level, not just via the plan
 * agent: edits are denied outright (never "ask" — an interactive prompt
 * would hang a headless run), and file access outside the workspace is
 * denied. Bash stays allowed: the review needs git diff/log/grep.
 *
 * `modelOptions` pass through opencode to the provider SDK for the MAIN
 * model only — the lever for capping reasoning spend on heavy models (e.g.
 * {"reasoningEffort":"medium"} for OpenAI, thinking budgets for Anthropic).
 */
function buildConfig(
  providerID: string,
  modelID: string,
  apiKey: string,
  modelOptions?: Record<string, unknown>,
): ServerOptions['config'] {
  const hasModelOptions = modelOptions && Object.keys(modelOptions).length > 0;
  return {
    provider: {
      [providerID]: {
        options: { apiKey },
        ...(hasModelOptions ? { models: { [modelID]: { options: modelOptions } } } : {}),
      },
    },
    permission: {
      edit: 'deny',
      external_directory: 'deny',
    },
  };
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

type ReadablePart = {
  type: string;
  text?: string;
  structured?: unknown;
};

type AssistantResponse = {
  info: AssistantMessage;
  parts: ReadonlyArray<ReadablePart>;
};

type SessionEventWaiter = {
  wait: Promise<AssistantResponse>;
  abort: () => void;
};

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
  options: { modelOptions?: Record<string, unknown>; port?: number } = {},
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
    const config = buildConfig(providerID, modelID, apiKey, options.modelOptions);
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
    client.provider.list(directoryParams(client)),
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
      ...directoryParams(client),
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
    });
    added = true;
    await client.mcp.connect({ ...directoryParams(client), name: CONTEXT7_MCP_NAME });
    log('Context7 MCP enabled for external API/SDK documentation checks.');
    return true;
  } catch (error) {
    if (added) await disableContext7Mcp(client, log);
    log(
      `Context7 MCP unavailable; continuing without it: ${formatContext7Error(error, trimmedKey)}`,
    );
    return false;
  }
}

export async function disableContext7Mcp(
  client: OpencodeClient,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await client.mcp.disconnect({ ...directoryParams(client), name: CONTEXT7_MCP_NAME });
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
  options: { lensAddendum?: string; label?: string; timeoutMs?: number } = {},
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
    REVIEW_OUTPUT_FORMAT,
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
): Promise<AddressedPriorComment[]> {
  const prompt = assembleAddressedPriorCommentsPrompt(prContext);
  const { raw } = await promptPlanAgent(
    client,
    model,
    prompt,
    'addressed-prior-comments',
    log,
    timeoutMs,
    ADDRESSED_OUTPUT_FORMAT,
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
): Promise<Finding[]> {
  const prompt = assembleGuidelineCompliancePrompt(prContext, guidelines);
  const { raw } = await promptPlanAgent(
    client,
    model,
    prompt,
    'guideline-compliance',
    log,
    timeoutMs,
    FINDINGS_OUTPUT_FORMAT,
  );
  return parseReview(raw, 'guideline-compliance', log).findings;
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
    VERDICTS_OUTPUT_FORMAT,
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
  outputFormat?: OutputFormat,
): Promise<{ raw: string; sessionID: string }> {
  log(`Creating ${label} session`);
  // The title makes parallel sessions distinguishable in opencode's own
  // session list when debugging a run.
  const created = await client.session.create({
    ...directoryParams(client),
    title: `jbot-review ${label}`,
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
    outputFormat,
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
  outputFormat?: OutputFormat,
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
      outputFormat,
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
  outputFormat?: OutputFormat,
): Promise<string> {
  const { providerID, modelID } = parseModelName(model);
  const messageID = `msg_jbot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

  const requestFormat = shouldUseNativeOutputFormat(providerID) ? outputFormat : undefined;

  log(`Calling ${label} prompt (agent=plan, provider=${providerID} model=${modelID})`);
  const eventWaiter = await createSessionEventWaiter(
    client,
    sessionID,
    label,
    messageID,
    log,
    timeoutMs,
  );
  const promptRes = await client.session.promptAsync({
    ...directoryParams(client),
    sessionID,
    messageID,
    model: { providerID, modelID },
    agent: 'plan',
    // Defense-in-depth alongside the plan agent and the config-level
    // permission.edit deny: mutating tools are off for every prompt.
    // Bash stays on — the review needs git diff/log/grep.
    tools: { write: false, edit: false, patch: false },
    ...(requestFormat ? { format: requestFormat } : {}),
    parts: [{ type: 'text', text: prompt }],
  });
  const promptError = getResultError(promptRes);
  if (promptError) {
    eventWaiter?.abort();
    throw new Error(`opencode ${label} prompt was rejected: ${promptError}`);
  }

  let data: AssistantResponse;
  try {
    data = eventWaiter
      ? await eventWaiter.wait
      : await waitForSessionIdleThenFetchMessage(
          client,
          sessionID,
          label,
          messageID,
          log,
          timeoutMs,
        );
  } catch (error) {
    // A timed-out or failed wait leaves the session generating (and
    // spending tokens) until the server shuts down; stop it now.
    eventWaiter?.abort();
    await abortSessionBestEffort(client, sessionID, label, log);
    throw error;
  }

  const parts = data.parts;
  log(
    `${label} prompt complete: parts=${parts.length} (types: ${parts.map((p) => p.type).join(', ')})`,
  );

  const structuredRaw = extractStructuredRaw(data.info.structured, parts);
  const textParts = parts.filter((p) => p.text);
  // No text part (e.g. the model exhausted its budget on reasoning) must
  // surface as a parse failure so the repair loop fires — defaulting to
  // '{}' would silently score the session as "no findings".
  const raw =
    structuredRaw ??
    textParts
      .map((p) => p.text)
      .join('\n\n')
      .trim();
  if (!raw)
    log(`${label} response contained no text part (types: ${parts.map((p) => p.type).join(', ')})`);
  log(
    `Extracted ${label} text: ${raw.length} chars from ${textParts.length} text part(s), structured=${structuredRaw ? 'yes' : 'no'}`,
  );
  return raw;
}

function shouldUseNativeOutputFormat(providerID: string): boolean {
  // opencode-go currently maps JSON schema output through provider tool_choice
  // paths that some models reject and others satisfy with tool-only messages.
  // Keep prompt-level JSON plus strict parsing for that provider instead.
  return providerID !== 'opencode-go';
}

async function waitForSessionIdleThenFetchMessage(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  messageID: string,
  log: (msg: string) => void,
  timeoutMs: number,
): Promise<AssistantResponse> {
  const startedAt = Date.now();
  let progressTimer: NodeJS.Timeout | undefined;

  progressTimer = setInterval(() => {
    log(
      `${label} prompt still running (${Math.round(
        (Date.now() - startedAt) / 1000,
      )}s, waiting for session idle)`,
    );
  }, PROMPT_PROGRESS_LOG_MS);

  try {
    const waitResult = await withTimeout(
      client.v2.session.wait({ sessionID }),
      timeoutMs,
      `opencode ${label} prompt did not finish within ${Math.round(
        timeoutMs / 1000,
      )}s (last status: waiting for session idle)`,
    );
    const waitError = getResultError(waitResult);
    if (waitError) {
      if (!isSessionWaitUnavailable(waitError)) {
        throw new Error(`opencode ${label} prompt failed: ${waitError}`);
      }
      log(`${label} session.wait unavailable; falling back to status polling.`);
      if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = undefined;
      }
      return waitForAssistantResponseByStatusPolling(
        client,
        sessionID,
        label,
        messageID,
        log,
        timeoutMs,
        startedAt,
      );
    }

    const message = await getAssistantMessageAfterIdle(client, sessionID, messageID, label);
    if (!message) throw new Error(`opencode ${label} prompt completed without assistant message`);
    if (message.info.error) {
      throw new Error(`opencode ${label} prompt failed: ${formatUnknownError(message.info.error)}`);
    }
    return message;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

async function waitForAssistantResponseByStatusPolling(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  messageID: string,
  log: (msg: string) => void,
  timeoutMs: number,
  startedAt: number,
): Promise<AssistantResponse> {
  let lastStatus = 'waiting for session status';
  let lastProgressLogAt = startedAt;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getSessionStatus(client, sessionID, label);
    if (status) lastStatus = describeSessionStatus(status);

    const message = await getAssistantMessageAfterIdle(client, sessionID, messageID, label);
    if (message?.info.error) {
      throw new Error(`opencode ${label} prompt failed: ${formatUnknownError(message.info.error)}`);
    }
    if (status?.type === 'idle') {
      if (!message) throw new Error(`opencode ${label} prompt completed without assistant message`);
      return message;
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

async function createSessionEventWaiter(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  messageID: string,
  log: (msg: string) => void,
  timeoutMs: number,
): Promise<SessionEventWaiter | undefined> {
  const controller = new AbortController();
  try {
    const events = await client.event.subscribe(directoryParams(client), {
      signal: controller.signal,
    });
    const wait = waitForSessionIdleByEvents(
      client,
      sessionID,
      label,
      messageID,
      events.stream,
      controller,
      log,
      timeoutMs,
    );
    return {
      wait,
      abort: () => controller.abort(),
    };
  } catch (error) {
    controller.abort();
    log(
      `${label} event stream unavailable; falling back to session wait/status: ${formatUnknownError(
        error,
      )}`,
    );
    return undefined;
  }
}

async function waitForSessionIdleByEvents(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  messageID: string,
  stream: AsyncIterable<unknown>,
  controller: AbortController,
  log: (msg: string) => void,
  timeoutMs: number,
): Promise<AssistantResponse> {
  const startedAt = Date.now();
  const partsByID = new Map<string, ReadablePart>();
  let assistantInfo: AssistantMessage | undefined;
  let lastStatus = 'waiting for event stream';
  let progressTimer: NodeJS.Timeout | undefined;

  progressTimer = setInterval(() => {
    log(
      `${label} prompt still running (${Math.round(
        (Date.now() - startedAt) / 1000,
      )}s, ${lastStatus})`,
    );
  }, PROMPT_PROGRESS_LOG_MS);

  const waitForIdle = (async () => {
    try {
      for await (const rawEvent of stream) {
        const event = unwrapOpencodeEvent(rawEvent);
        if (!isRecord(event) || typeof event.type !== 'string') continue;

        if (event.type === 'message.updated' && eventSessionID(event) === sessionID) {
          const info = isRecord(event.properties) ? event.properties.info : undefined;
          if (isRecord(info) && info.role === 'assistant') {
            assistantInfo = info as AssistantMessage;
            lastStatus = 'assistant message updated';
          }
          continue;
        }

        if (event.type === 'message.part.updated' && eventSessionID(event) === sessionID) {
          const part = isRecord(event.properties) ? event.properties.part : undefined;
          if (isRecord(part)) {
            const id = typeof part.id === 'string' ? part.id : String(partsByID.size);
            partsByID.set(id, toProjectedReadablePart(part));
            lastStatus = `assistant part updated: ${typeof part.type === 'string' ? part.type : 'unknown'}`;
          }
          continue;
        }

        if (event.type === 'session.error' && eventSessionID(event) === sessionID) {
          const error = isRecord(event.properties) ? event.properties.error : undefined;
          throw new Error(`opencode ${label} prompt failed: ${formatUnknownError(error)}`);
        }

        if (event.type === 'session.status' && eventSessionID(event) === sessionID) {
          const status = isRecord(event.properties) ? event.properties.status : undefined;
          if (isSessionStatus(status)) {
            lastStatus = describeSessionStatus(status);
            if (status.type === 'idle') return;
          }
          continue;
        }

        if (event.type === 'session.idle' && eventSessionID(event) === sessionID) {
          lastStatus = 'idle';
          return;
        }
      }
      throw new Error(`opencode ${label} event stream ended before session became idle`);
    } finally {
      controller.abort();
    }
  })();

  try {
    await withTimeout(
      waitForIdle,
      timeoutMs,
      `opencode ${label} prompt did not finish within ${Math.round(
        timeoutMs / 1000,
      )}s (last status: ${lastStatus})`,
    );
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    const returnable = stream as unknown as { return?: () => Promise<unknown> | unknown };
    void returnable.return?.();
  }

  const message = await getAssistantMessageAfterIdle(client, sessionID, messageID, label);
  if (message?.info.error) {
    throw new Error(`opencode ${label} prompt failed: ${formatUnknownError(message.info.error)}`);
  }
  if (message && hasResponsePayload(message)) return message;
  if (partsByID.size > 0) {
    return {
      info:
        assistantInfo ??
        ({
          role: 'assistant',
          id: messageID,
          parentID: messageID,
          time: {},
        } as AssistantMessage),
      parts: [...partsByID.values()],
    };
  }
  if (message) return message;
  throw new Error(`opencode ${label} prompt completed without assistant message`);
}

async function getAssistantMessageAfterIdle(
  client: OpencodeClient,
  sessionID: string,
  messageID: string,
  label: string,
): Promise<AssistantResponse | undefined> {
  let latest: AssistantResponse | undefined;
  try {
    latest = await getLatestAssistantMessage(client, sessionID, label);
  } catch {
    // Older servers may not expose the projected v2 messages endpoint.
  }
  if (hasResponsePayload(latest)) return latest;

  try {
    const exact = await getAssistantMessageBestEffort(client, sessionID, messageID, label);
    if (hasResponsePayload(exact)) return exact;
    return exact ?? latest;
  } catch {
    return latest;
  }
}

async function abortSessionBestEffort(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await withTimeout(
      client.session.abort({ ...directoryParams(client), sessionID }),
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

async function getAssistantMessageBestEffort(
  client: OpencodeClient,
  sessionID: string,
  messageID: string,
  label: string,
): Promise<{ info: AssistantMessage; parts: ReadonlyArray<ReadablePart> } | undefined> {
  try {
    return await fetchAssistantMessage(client, sessionID, messageID, label);
  } catch {
    // Fall back to the legacy list endpoint for older servers that accept a
    // caller-provided prompt messageID but derive a separate assistant id.
  }

  const result = await withTimeout(
    client.session.messages({ ...directoryParams(client), sessionID, limit: 1 }),
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

async function getLatestAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  label: string,
): Promise<{ info: AssistantMessage; parts: ReadonlyArray<ReadablePart> } | undefined> {
  const result = await withTimeout(
    client.v2.session.messages({ sessionID, limit: 5, order: 'desc' }),
    PROMPT_POLL_REQUEST_TIMEOUT_MS,
    `opencode ${label} message polling timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms (session=${sessionID})`,
  );
  const error = getResultError(result);
  if (error) throw new Error(`opencode ${label} message polling failed: ${error}`);

  const messages = extractProjectedMessages(result.data);
  for (const message of messages) {
    if (!isRecord(message) || message.type !== 'assistant') continue;
    return {
      info: {
        role: 'assistant',
        id: typeof message.id === 'string' ? message.id : '',
        parentID: '',
        time: isRecord(message.time) ? message.time : {},
        ...(message.error ? { error: message.error } : {}),
      } as AssistantMessage,
      parts: Array.isArray(message.content) ? message.content.map(toProjectedReadablePart) : [],
    };
  }
  return undefined;
}

function extractProjectedMessages(payload: unknown): unknown[] {
  return isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
}

async function fetchAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  messageID: string,
  label: string,
): Promise<{ info: AssistantMessage; parts: ReadonlyArray<ReadablePart> }> {
  const result = await withTimeout(
    client.session.message({ ...directoryParams(client), sessionID, messageID }),
    PROMPT_POLL_REQUEST_TIMEOUT_MS,
    `opencode ${label} message fetch timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms (session=${sessionID} message=${messageID})`,
  );
  const error = getResultError(result);
  if (error) throw new Error(`opencode ${label} message fetch failed: ${error}`);

  const message = result.data;
  if (!message) throw new Error(`opencode ${label} message fetch returned no data`);
  if (message.info.role !== 'assistant') {
    throw new Error(`opencode ${label} message ${messageID} is not an assistant response`);
  }
  return {
    info: message.info,
    parts: (message.parts ?? []).map(toTextReadablePart),
  };
}

async function getSessionStatus(
  client: OpencodeClient,
  sessionID: string,
  label: string,
): Promise<SessionStatus | undefined> {
  const result = await withTimeout(
    client.session.status(directoryParams(client)),
    PROMPT_POLL_REQUEST_TIMEOUT_MS,
    `opencode ${label} status polling timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms (session=${sessionID})`,
  );
  const error = getResultError(result);
  if (error) throw new Error(`opencode ${label} status polling failed: ${error}`);
  const statuses = result.data;
  return statuses?.[sessionID];
}

function toTextReadablePart(part: Part): ReadablePart {
  if (part.type === 'text') return { type: part.type, text: part.text };
  if (part.type !== 'tool') return { type: part.type };

  const payload = extractCompletedToolStatePayload(part.state);
  return { type: part.type, ...payload };
}

function toProjectedReadablePart(part: unknown): ReadablePart {
  if (!isRecord(part)) return { type: 'unknown' };
  if (part.type === 'text' && typeof part.text === 'string') {
    return { type: part.type, text: part.text };
  }
  if (part.type === 'tool') {
    return { type: part.type, ...extractCompletedToolStatePayload(part.state) };
  }
  return { type: typeof part.type === 'string' ? part.type : 'unknown' };
}

function hasResponsePayload(
  message: { info: AssistantMessage; parts: ReadonlyArray<ReadablePart> } | undefined,
): boolean {
  if (!message) return false;
  if (isRecord(message.info.structured)) return true;
  return message.parts.some((part) => Boolean(part.text) || isRecord(part.structured));
}

function extractStructuredRaw(
  messageStructured: unknown,
  parts: ReadonlyArray<ReadablePart>,
): string | undefined {
  if (isRecord(messageStructured)) return JSON.stringify(messageStructured);
  const structured = parts.find((part) => isRecord(part.structured))?.structured;
  return isRecord(structured) ? JSON.stringify(structured) : undefined;
}

function extractCompletedToolStatePayload(state: unknown): { text?: string; structured?: unknown } {
  if (!isRecord(state)) return {};
  if (state.status !== 'completed') return {};

  if (isRecord(state.structured)) return { structured: state.structured };
  if (isRecord(state.result)) return { structured: state.result };
  return {};
}

function directoryParams(client: OpencodeClient): { directory: string } | undefined {
  const directory = clientDirectories.get(client);
  return directory ? { directory } : undefined;
}

function describeSessionStatus(status: SessionStatus): string {
  if (status.type === 'retry') return `retry attempt ${status.attempt}: ${status.message}`;
  return status.type;
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return isRecord(value) && typeof value.type === 'string';
}

function unwrapOpencodeEvent(value: unknown): OpencodeEvent | unknown {
  return isRecord(value) && isRecord(value.payload) ? value.payload : value;
}

function eventSessionID(event: Record<string, unknown>): string | undefined {
  const properties = isRecord(event.properties) ? event.properties : undefined;
  if (!properties) return undefined;
  if (typeof properties.sessionID === 'string') return properties.sessionID;
  const part = isRecord(properties.part) ? properties.part : undefined;
  return typeof part?.sessionID === 'string' ? part.sessionID : undefined;
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

function isSessionWaitUnavailable(message: string): boolean {
  return /Session wait is not available yet|session\.wait|ServiceUnavailable/i.test(message);
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
  if (options.strict && (typeof obj.summary !== 'string' || !Array.isArray(obj.findings))) {
    const missing = [
      typeof obj.summary !== 'string' ? 'summary' : '',
      !Array.isArray(obj.findings) ? 'findings' : '',
    ]
      .filter(Boolean)
      .join(', ');
    log(`${label} response was missing required review field(s): ${missing}`);
    log(`${label} response preview:\n${truncateForLog(raw, 2000)}`);
    throw new Error(`opencode ${label} returned JSON missing required field(s): ${missing}`);
  }
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
      note: typeof addressed.note === 'string' ? addressed.note.trim() : undefined,
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
