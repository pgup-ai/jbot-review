import { createOpencode, type OpencodeClient, type ServerOptions } from '@opencode-ai/sdk';

import { parseModelName } from './model.ts';
import { REVIEW_PROMPT } from './prompt.ts';
import type { AddressedPriorComment, Finding, ReviewResult, Severity } from './types.ts';

const READY_TIMEOUT_MS = 15_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;

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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
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
  const { providerID, modelID } = parseModelName(model);

  log(`Creating opencode session (provider=${providerID} model=${modelID})`);
  const created = await client.session.create();
  const session = created.data;
  if (!session) throw new Error('Failed to create opencode session');
  log(`Session created: ${session.id}`);

  const promptParts = [REVIEW_PROMPT];
  if (guidelines) {
    promptParts.push('## Repository review guidelines\n', guidelines);
  }
  promptParts.push(prContext);
  const prompt = promptParts.join('\n\n');
  log(`Prompt assembled: ${prompt.length} chars, guidelines=${!!guidelines}`);

  log(`Calling prompt (agent=plan)`);
  const promptRes = await client.session.prompt({
    path: { id: session.id },
    body: {
      model: { providerID, modelID },
      agent: 'plan',
      parts: [{ type: 'text', text: prompt }],
    },
  });
  const data = promptRes.data;
  if (!data) {
    const detail =
      'error' in promptRes
        ? JSON.stringify((promptRes as Record<string, unknown>).error)
        : 'empty response';
    log(`Prompt response error: ${detail}`);
    throw new Error(`opencode prompt returned no message (${detail})`);
  }

  // Defensive: parts can be missing/empty on edge cases (errors, empty
  // responses). Default to [] to avoid a TypeError.
  const parts = (data.parts ?? []) as ReadonlyArray<{ type: string; text?: string }>;
  log(`Prompt complete: parts=${parts.length} (types: ${parts.map((p) => p.type).join(', ')})`);

  const textPart = [...parts].reverse().find((p) => p.type === 'text');
  const raw = textPart?.text ?? '{}';
  log(`Extracted text: ${raw.length} chars`);
  return parseReview(raw);
}

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set(['P0', 'P1', 'P2', 'P3', 'nit']);

/** Defensively parse the agent's JSON; malformed output degrades to empty. */
function parseReview(raw: string): ReviewResult {
  let parsed: unknown;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    parsed = JSON.parse(slice);
  } catch {
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
    addressedPriorComments.push({
      id,
      addressedByCommit:
        typeof addressed.addressed_by_commit === 'string'
          ? addressed.addressed_by_commit.trim()
          : undefined,
      note: typeof addressed.note === 'string' ? addressed.note.trim() : undefined,
    });
  }

  return { summary, findings, addressedPriorComments };
}
