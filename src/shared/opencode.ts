import { setTimeout as sleep } from 'node:timers/promises';
import { createOpencode, type OpencodeClient, type ServerOptions } from '@opencode-ai/sdk';

import { REVIEW_PROMPT } from './prompt.ts';
import type { Finding, ReviewResult, Severity } from './types.ts';

const READY_TIMEOUT_MS = 15_000;

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
 * Starts an opencode server with the given provider API key embedded in its
 * config, and returns an SDK client pointed at it. The server is started with
 * the read-only "plan" agent by default — it cannot edit files, which keeps
 * the review safe and avoids non-interactive permission prompts that would
 * hang a CI run.
 */
export async function startOpencode(
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
): Promise<{ client: OpencodeClient; stop: () => void }> {
  const config = buildConfig(providerID, apiKey);
  const { client, server } = await createOpencode({
    hostname: '127.0.0.1',
    port: 4096,
    timeout: READY_TIMEOUT_MS,
    config,
  });

  log(`opencode server listening at ${server.url} (provider=${providerID} model=${modelID})`);

  return { client, stop: () => server.close() };
}

/**
 * Polls the server until it accepts requests, or fails after ~12 seconds.
 * Kept for compatibility; the new server factory already waits for readiness
 * internally, so this is a no-op when the server is up.
 */
export async function waitReady(_client: OpencodeClient): Promise<void> {
  // The new `createOpencode` factory waits for the server to be ready before
  // returning, so this function is effectively a no-op. Kept for API stability
  // with existing callers.
  await sleep(1);
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
  const [providerID, ...rest] = model.split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) {
    throw new Error(`Invalid model "${model}"; expected "provider/model".`);
  }

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
  log(
    `Prompt complete: parts=${data.parts.length} (types: ${data.parts.map((p) => p.type).join(', ')})`,
  );

  const parts = data.parts as ReadonlyArray<{ type: string; text?: string }>;
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
    return { summary: 'The reviewer returned an unparseable response.', findings: [] };
  }

  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];

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
  return { summary, findings };
}
