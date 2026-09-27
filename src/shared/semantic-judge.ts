import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseModelName } from '@symma/protocol';

import { createJudge } from './benchmark-judge.ts';
import { PROVIDERS } from './config.ts';
import { CLOSED_BOOK_AGENT } from './opencode-config.ts';
import { startOpencode } from './opencode-server.ts';
import {
  configureSessionConcurrency,
  createReviewSession,
  promptInSession,
} from './opencode-session.ts';

const JUDGE_TIMEOUT_MS = 120_000;
const quiet = () => {};

/** Zen free models only answer from inside opencode, hence sessions rather than a plain HTTP call. */
export async function startOpencodeJudge(model: string, concurrency: number) {
  const { providerID, modelID } = parseModelName(model);
  const keyEnv = PROVIDERS[providerID]?.keyEnv;
  // Judge sessions read nothing, so they run in an empty scratch dir.
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-judge-'));
  const runtime = await startOpencode(
    workspace,
    providerID,
    modelID,
    (keyEnv && process.env[keyEnv]) || '',
    quiet,
  );
  configureSessionConcurrency(concurrency);
  const judge = createJudge(async (text) => {
    const spec = { label: 'semantic-judge', model, log: quiet };
    const sessionID = await createReviewSession(runtime, { ...spec, agent: CLOSED_BOOK_AGENT });
    return promptInSession(runtime, sessionID, { ...spec, text, timeoutMs: JUDGE_TIMEOUT_MS });
  });
  return {
    ...judge,
    stop: () => {
      runtime.stop();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
