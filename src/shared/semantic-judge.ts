import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelName } from '@symma/protocol';

import { createJudge } from './benchmark-judge.ts';
import { PROVIDERS } from './config.ts';
import { CLOSED_BOOK_AGENT } from './opencode-config.ts';
import { startOpencode } from './opencode-server.ts';
import { Semaphore, createReviewSession, promptInSession } from './opencode-session.ts';
import { resolveOpencodeApiKeys } from './opencode-usage.ts';

const JUDGE_TIMEOUT_MS = 120_000;
const quiet = () => {};

/** Zen free models only answer from inside opencode, hence sessions rather than a plain HTTP call. */
export async function startOpencodeJudge(model: string, concurrency: number) {
  const { providerID, modelID } = parseModelName(model);
  const keyEnv = PROVIDERS[providerID]?.keyEnv;
  const raw = (keyEnv && process.env[keyEnv]) || '';
  // Key lists (e.g. two opencode accounts) resolve exactly as a review run's do.
  const { apiKey } = await resolveOpencodeApiKeys(
    { providerID, apiKey: raw, auxProviderID: providerID, auxApiKey: raw },
    quiet,
  );
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-judge-'));
  const runtime = await startOpencode(workspace, providerID, modelID, apiKey, quiet).catch(
    (error: unknown) => {
      rmSync(workspace, { recursive: true, force: true });
      throw error;
    },
  );
  // Held from session creation through the prompt, so --concurrency bounds both.
  const slots = new Semaphore(concurrency);
  const judge = createJudge(async (text) => {
    const release = await slots.acquire();
    try {
      const spec = { label: 'semantic-judge', model, log: quiet };
      const sessionID = await createReviewSession(runtime, { ...spec, agent: CLOSED_BOOK_AGENT });
      return await promptInSession(runtime, sessionID, {
        ...spec,
        text,
        timeoutMs: JUDGE_TIMEOUT_MS,
      });
    } finally {
      release();
    }
  });
  return {
    ...judge,
    stop: () => {
      runtime.stop();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
