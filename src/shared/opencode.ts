import {
  createOpencode,
  type AssistantMessage,
  type OpencodeClient,
  type Part,
  type ServerOptions,
  type SessionStatus,
} from '@opencode-ai/sdk';

import { parseModelName } from './model.ts';
import { REVIEW_PROMPT } from './prompt.ts';
import type {
  AddressedPriorComment,
  Finding,
  FindingConfidence,
  FindingKind,
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

const ADDRESSED_PRIOR_COMMENTS_PROMPT = `You are checking whether prior jbot-review inline comments have been addressed by the current PR branch.

Use the checked-out repo, git diff, git log, and the PR context below to verify each prior jbot-review thread.

Rules:
- Only mark a prior thread addressed when the current branch clearly fixes the specific issue raised.
- Do not mark a thread addressed just because the latest review has no new findings.
- Do not mark a thread addressed because a human reply declined the suggestion, such as "Not applied", "accepted as-is", or "not worth fixing".
- Use the exact prior jbot-review thread id from the prompt.
- Prefer the commit SHA that fixed the issue for "addressed_by_commit"; use the current head only if the exact fixing commit cannot be determined.
- Keep "note" to one short sentence explaining why it is addressed.

Respond with a SINGLE JSON object and NOTHING else:

{
  "addressedPriorComments": [
    {
      "id": "exact prior jbot-review thread id",
      "addressed_by_commit": "commit sha",
      "note": "Short reason this prior comment is now addressed."
    }
  ]
}`;

/**
 * Builds the opencode config object that embeds the API key for the selected
 * provider. This is the official way to authenticate opencode (replaces the
 * old "set env var" pattern).
 */
function buildConfig(providerID: string, apiKey: string): ServerOptions['config'] {
  return {
    provider: {
      [providerID]: {
        options: { apiKey },
      },
    },
  };
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
 * before spawning and restore it on stop. The read-only "plan" agent is used
 * by default — it cannot edit files, which keeps the review safe and avoids
 * non-interactive permission prompts that would hang a CI run.
 */
export async function startOpencode(
  workspace: string,
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
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
    const config = buildConfig(providerID, apiKey);
    const { client, server } = await createOpencode({
      hostname: '127.0.0.1',
      port: 4096,
      timeout: READY_TIMEOUT_MS,
      config,
    });

    log(`opencode server listening at ${server.url} (provider=${providerID} model=${modelID})`);

    const stop = () => {
      // Wrap server.close() in try/finally so cwd is always restored, even
      // if close() throws (e.g., double-close).
      try {
        server.close();
      } finally {
        restoreCwd();
        release();
      }
    };

    return { client, stop };
  } catch (err) {
    // Restore cwd on failure and release the lock so the next caller can proceed.
    restoreCwd();
    release();
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
 * default.
 */
export async function runReview(
  client: OpencodeClient,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
): Promise<ReviewResult> {
  const promptParts = [REVIEW_PROMPT];
  if (guidelines) {
    promptParts.push('## Repository review guidelines\n', guidelines);
  }
  promptParts.push(prContext);
  const prompt = promptParts.join('\n\n');
  log(`Prompt assembled: ${prompt.length} chars, guidelines=${!!guidelines}`);

  const raw = await promptPlanAgent(client, model, prompt, 'review', log);
  return parseReview(raw, 'review', log, { strict: true });
}

export async function runAddressedPriorCommentsCheck(
  client: OpencodeClient,
  model: string,
  prContext: string,
  log: (msg: string) => void,
): Promise<AddressedPriorComment[]> {
  const prompt = [ADDRESSED_PRIOR_COMMENTS_PROMPT, prContext].join('\n\n');
  const raw = await promptPlanAgent(client, model, prompt, 'addressed-prior-comments', log);
  return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
}

async function promptPlanAgent(
  client: OpencodeClient,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
): Promise<string> {
  const { providerID, modelID } = parseModelName(model);

  log(`Creating ${label} session (provider=${providerID} model=${modelID})`);
  const created = await client.session.create();
  const session = created.data;
  if (!session) throw new Error(`Failed to create ${label} session`);
  log(`${label} session created: ${session.id}`);

  log(`Calling ${label} prompt (agent=plan)`);
  const promptRes = await client.session.promptAsync({
    path: { id: session.id },
    body: {
      model: { providerID, modelID },
      agent: 'plan',
      parts: [{ type: 'text', text: prompt }],
    },
  });
  const promptError = getResultError(promptRes);
  if (promptError) throw new Error(`opencode ${label} prompt was rejected: ${promptError}`);

  const data = await waitForAssistantMessage(client, session.id, label, log);

  const parts = data.parts;
  log(
    `${label} prompt complete: parts=${parts.length} (types: ${parts.map((p) => p.type).join(', ')})`,
  );

  const textPart = [...parts].reverse().find((p) => p.type === 'text');
  const raw = textPart?.text ?? '{}';
  log(`Extracted ${label} text: ${raw.length} chars`);
  return raw;
}

async function waitForAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
): Promise<{ info: AssistantMessage; parts: ReadonlyArray<{ type: string; text?: string }> }> {
  const startedAt = Date.now();
  let lastStatus = 'unknown';
  let lastProgressLogAt = startedAt;

  while (Date.now() - startedAt < PROMPT_TIMEOUT_MS) {
    const message = await getLatestAssistantMessage(client, sessionID, label);
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
      PROMPT_TIMEOUT_MS / 1000,
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
    client.session.messages({ path: { id: sessionID } }),
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
    client.session.status(),
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
