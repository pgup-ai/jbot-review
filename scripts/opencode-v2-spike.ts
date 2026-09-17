// Live checks against a real model. Usage:
//   JBOT_SPIKE_MODEL=openai/gpt-5 JBOT_SPIKE_KEY=$OPENAI_API_KEY npx tsx scripts/opencode-v2-spike.ts
// Re-run after every @opencode/cli bump; it exercises the real server + driver.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelName } from '@symma/protocol';

import { startOpencode } from '../src/shared/opencode-server.ts';
import { createReviewSession, promptInSession } from '../src/shared/opencode-session.ts';

const model = process.env.JBOT_SPIKE_MODEL ?? 'opencode/mimo-v2.5-free';
const apiKey = process.env.JBOT_SPIKE_KEY ?? 'unused';
const { providerID, modelID } = parseModelName(model);
const log = (msg: string) => console.log(`[spike] ${msg}`);

const workspace = mkdtempSync(join(tmpdir(), 'jbot-spike-'));
writeFileSync(
  join(workspace, 'a.ts'),
  'export const add = (a: number, b: number) => a - b; // bug\n',
);
execFileSync('git', ['init', '-q'], { cwd: workspace });
execFileSync('git', ['add', '-A'], { cwd: workspace });
execFileSync('git', ['-c', 'user.email=s@s', '-c', 'user.name=s', 'commit', '-qm', 'init'], {
  cwd: workspace,
});

const events: string[] = [];
const runtime = await startOpencode(
  workspace,
  providerID,
  modelID,
  apiKey,
  (msg) => {
    events.push(msg);
    log(msg);
  },
  {
    port: 47_500 + Math.floor(Math.random() * 400),
    modelOptions: { reasoningEffort: 'medium' },
    verificationModelOptions: { reasoningEffort: 'low' },
  },
);
process.env.JBOT_SPIKE_CANARY = 'canary-value';
try {
  // S6: config model overrides do not apply to catalog models (measured 2026-09-17), so
  // tier options travel per session through the plugin; this shows what it will read.
  const verifyID = await createReviewSession(runtime, { label: 'verify', model, tier: 'verify' });
  log(
    `S6 session options file: ${readFileSync(runtime.sessionOptionsFile!, 'utf8')} (expect ${verifyID} → the verify tier)`,
  );

  // S7: raw shape of one tool event from the global stream, for the progress logger.
  const ac = new AbortController();
  void (async () => {
    try {
      for await (const event of runtime.client.event.subscribe({ signal: ac.signal })) {
        if ((event as { type?: string }).type === 'session.tool.called') {
          log(`S7 tool event: ${JSON.stringify(event).slice(0, 900)}`);
          break;
        }
      }
    } catch {
      /* stream closed */
    }
  })();

  // S1: the model's own shell tool must not see the server env.
  const s1 = await createReviewSession(runtime, { label: 'spike-s1', model });
  const env = await promptInSession(runtime, s1, {
    model,
    label: 'spike-s1',
    timeoutMs: 180_000,
    log,
    text: 'Use your shell tool to run exactly: env | grep -c JBOT_SPIKE_CANARY || true ; then reply with only the number printed.',
  });
  log(`S1 shell env leak count (expect 0): ${env.text}`);

  // S4: a review-sized turn under plan terminates and returns JSON; wrap-up works on a tiny budget.
  const padding = `\n\n/* context padding */\n${'x'.repeat(150_000)}`; // ~150 KB like a real review prompt
  const s4 = await createReviewSession(runtime, { label: 'spike-s4', model });
  const review = await promptInSession(runtime, s4, {
    model,
    label: 'spike-s4',
    timeoutMs: 300_000,
    log,
    text: `Read a.ts in the working tree. Reply with JSON {"findings":[{"path":"a.ts","line":1,"title":"...","body":"..."}]} only. Ignore everything after this line.${padding}`,
  });
  log(`S4 review finish=${review.message.finish} text=${review.text.slice(0, 200)}`);
  const outcome = { wrappedUp: false };
  const cut = await promptInSession(runtime, s4, {
    model,
    label: 'spike-s4-cut',
    timeoutMs: 40_000,
    log,
    outcome,
    wrapUpReserveMs: 35_000,
    text: 'List every file under / you can read, one per line, using the shell tool repeatedly. Do not stop early.',
  });
  log(`S4 wrap-up fired=${outcome.wrappedUp} reply=${cut.text.slice(0, 120)}`);
  ac.abort();

  log(`S7 progress lines seen: ${events.filter((e) => e.includes(' tool: ')).length}`);
  log(
    'S3 (manual): confirm promptCacheKey reaches the provider when setCacheKey is set; a session.hook("http.request") plugin can print the body.',
  );
  log('S5 (manual): compare `opencode models --help` with scripts/update-model-catalog.ts.');
} finally {
  runtime.stop();
}
