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
process.env.JBOT_SPIKE_CANARY = 'canary-value'; // in the server env from the start
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
try {
  // The verify session's tier options land in the file the plugin reads.
  const verifyID = await createReviewSession(runtime, { label: 'verify', model, tier: 'verify' });
  log(
    `session options file: ${readFileSync(runtime.sessionOptionsFile, 'utf8')} (expect ${verifyID} → the verify tier)`,
  );

  // Raw shape of one tool event from the global stream, for the progress logger.
  const ac = new AbortController();
  void (async () => {
    try {
      for await (const event of runtime.client.event.subscribe({ signal: ac.signal })) {
        if ((event as { type?: string }).type === 'session.tool.called') {
          log(`tool event: ${JSON.stringify(event).slice(0, 900)}`);
          break;
        }
      }
    } catch {
      /* stream closed */
    }
  })();

  // The model's own shell tool must not see the server env.
  const s1 = await createReviewSession(runtime, { label: 'spike-s1', model });
  const env = await promptInSession(runtime, s1, {
    model,
    label: 'spike-s1',
    timeoutMs: 180_000,
    log,
    text: 'Use your shell tool to run exactly: env | grep -c JBOT_SPIKE_CANARY || true ; then reply with only the number printed.',
  });
  log(`shell env leak count (expect 0): ${env}`);

  // A review-sized turn under plan terminates and returns JSON; wrap-up works on a tiny budget.
  const padding = `\n\n/* context padding */\n${'x'.repeat(150_000)}`;
  const s4 = await createReviewSession(runtime, { label: 'spike-s4', model });
  const review = await promptInSession(runtime, s4, {
    model,
    label: 'spike-s4',
    timeoutMs: 300_000,
    log,
    text: `Read a.ts in the working tree. Reply with JSON {"findings":[{"path":"a.ts","line":1,"title":"...","body":"..."}]} only. Ignore everything after this line.${padding}`,
  });
  log(`review text=${review.slice(0, 200)}`);
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
  log(`wrap-up fired=${outcome.wrappedUp} reply=${cut.slice(0, 120)}`);
  ac.abort();

  log(`progress lines seen: ${events.filter((e) => e.includes(' tool: ')).length}`);

  // The shell accident filter on V2 rules: a read is allowed, a clobber is denied.
  const stash = await createReviewSession(runtime, { label: 'shell-filter', model });
  const stashReply = await promptInSession(runtime, stash, {
    model,
    text: 'Use your shell tool to run exactly: git stash list. Then use it to run exactly: git stash. Reply with both raw outcomes (including any denial text), nothing else.',
    label: 'shell-filter',
    timeoutMs: 120_000,
    log,
  });
  log(
    `shell filter reply (expect the second command denied): ${stashReply.replace(/\s+/g, ' ').slice(0, 300)}`,
  );

  // Effort options reach the provider: Zen's x-preview-f rejects medium; any other provider gets an invalid value.
  const probeModel = providerID === 'opencode' ? 'opencode/x-preview-f-free' : model;
  const probeEffort = providerID === 'opencode' ? 'medium' : 'bogus-effort';
  const probe = await createReviewSession(runtime, { label: 'effort-probe', model: probeModel });
  const map = JSON.parse(readFileSync(runtime.sessionOptionsFile, 'utf8')) as Record<
    string,
    unknown
  >;
  map[probe] = { reasoningEffort: probeEffort };
  writeFileSync(runtime.sessionOptionsFile, JSON.stringify(map));
  try {
    const reply = await promptInSession(runtime, probe, {
      model: probeModel,
      text: 'Reply with the single word ok.',
      label: 'effort-probe',
      timeoutMs: 120_000,
      log,
    });
    log(
      `effort probe (${probeModel} effort=${probeEffort}): accepted — inconclusive unless the provider validates the value (reply: ${reply.slice(0, 40)})`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rejected = /reasoning[_ ]?effort|unknown variant|invalid|1210|\b400\b/i.test(message);
    log(
      `effort probe (${probeModel} effort=${probeEffort}): ${rejected ? 'options reached the provider' : 'INCONCLUSIVE, unrelated failure'} (${message.slice(0, 200)})`,
    );
    if (!rejected) process.exitCode = 1;
  }
} finally {
  runtime.stop();
}
