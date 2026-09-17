import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { OpencodeRuntime } from '../src/shared/opencode-server.ts';
import {
  abortOpencodeSessionsByLabel,
  createReviewSession,
  finalizeOpencodeSessionsByLabel,
  promptInSession,
  startProgressLogger,
} from '../src/shared/opencode-session.ts';
import { fakeOpencodeServer } from './support/opencode-fake.ts';

const log = () => undefined;
const runtime = (
  fake: ReturnType<typeof fakeOpencodeServer>,
  extra: Partial<OpencodeRuntime> = {},
): OpencodeRuntime => ({
  client: fake.client,
  workspace: '/ws',
  stop: () => undefined,
  ...extra,
});

describe('createReviewSession', () => {
  it('creates a plan session at the workspace with the ruleset and replaces its shell env', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{}' }));
    const id = await createReviewSession(runtime(fake), { label: 'review', model: 'openai/gpt-5' });
    const session = fake.sessions.get(id)!;
    assert.equal(session.agent, 'plan');
    assert.deepEqual(session.model, { providerID: 'openai', id: 'gpt-5' });
    assert.ok(Array.isArray(session.permissions) && session.permissions.length > 0);
    assert.ok(session.environment && 'PATH' in session.environment);
    assert.equal('OPENCODE_CONFIG_CONTENT' in session.environment!, false);
  });

  it('forks the main session for verification and re-targets agent and model', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{}' }));
    const main = await createReviewSession(runtime(fake), {
      label: 'review',
      model: 'openai/gpt-5',
    });
    const id = await createReviewSession(runtime(fake), {
      label: 'finding-verification',
      model: 'openai/gpt-5',
      forkFrom: main,
    });
    const forked = fake.sessions.get(id)!;
    assert.equal(forked.forkedFrom, main);
    assert.equal(forked.agent, 'plan');
    assert.deepEqual(forked.model, { providerID: 'openai', id: 'gpt-5' });
  });

  it("publishes each session's tier options to the file the plugin reads", async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{}' }));
    const sessionOptionsFile = join(mkdtempSync(join(tmpdir(), 'jbot-opts-')), 'opts.json');
    const rt = runtime(fake, {
      sessionOptionsFile,
      modelOptions: {
        'openai/gpt-5': { main: { reasoningEffort: 'medium' }, verify: { reasoningEffort: 'low' } },
      },
    });
    const main = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const verify = await createReviewSession(rt, {
      label: 'finding-verification',
      model: 'openai/gpt-5',
      tier: 'verify',
    });
    assert.deepEqual(JSON.parse(readFileSync(sessionOptionsFile, 'utf8')), {
      [main]: { reasoningEffort: 'medium' },
      [verify]: { reasoningEffort: 'low' },
    });
  });
});

describe('promptInSession', () => {
  it('returns the newest completed assistant text and records usage once, sending no message id', async () => {
    const fake = fakeOpencodeServer((_s, text) => ({ text: `echo:${text}`, delayMs: 20 }));
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const usage: unknown[] = [];
    const first = await promptInSession(rt, id, {
      model: 'openai/gpt-5',
      text: 'one',
      label: 'review',
      timeoutMs: 5_000,
      log,
      onTokenUsage: (u) => usage.push(u),
    });
    const second = await promptInSession(rt, id, {
      model: 'openai/gpt-5',
      text: 'two',
      label: 'review',
      timeoutMs: 5_000,
      log,
    });
    assert.equal(first.text, 'echo:one');
    assert.equal(second.text, 'echo:two');
    assert.equal(usage.length, 1);
    assert.equal((usage[0] as { input: number }).input, 10);
    assert.ok(fake.prompts.every((p) => p.body.id === undefined));
    assert.ok(fake.calls.some((c) => /POST .*\/wait$/.test(c)));
  });

  it('waits in slices shorter than the fetch header timeout and keeps waiting across them', async () => {
    const fake = fakeOpencodeServer(() => ({ text: 'late', delayMs: 250 }));
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const result = await promptInSession(rt, id, {
      model: 'openai/gpt-5',
      text: 'x',
      label: 'review',
      timeoutMs: 5_000,
      log,
      waitSliceMs: 100,
    });
    assert.equal(result.text, 'late');
    assert.ok(
      fake.sessions.get(id)!.abortedWaits >= 2,
      'earlier slices were abandoned, not treated as failures',
    );
    assert.equal(fake.sessions.get(id)!.interrupted, 0);
  });

  it('surfaces an assistant error and treats a reasoning-only reply as empty text', async () => {
    const fake = fakeOpencodeServer((_s, text) =>
      text === 'boom' ? { text: 'x', error: 'provider exploded' } : {},
    );
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    await assert.rejects(
      promptInSession(rt, id, {
        model: 'openai/gpt-5',
        text: 'boom',
        label: 'review',
        timeoutMs: 5_000,
        log,
      }),
      /provider exploded/,
    );
    const empty = await promptInSession(rt, id, {
      model: 'openai/gpt-5',
      text: 'quiet',
      label: 'review',
      timeoutMs: 5_000,
      log,
    });
    assert.equal(empty.text, '');
  });

  it('wraps up a cut-off turn: interrupt, switch to jbot-wrapup, prompt again, restore the agent', async () => {
    const fake = fakeOpencodeServer((session, text) =>
      session.agent === 'jbot-wrapup' ? { text: '{"findings":[]}' } : { hang: true, text },
    );
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const outcome = { wrappedUp: false };
    const result = await promptInSession(rt, id, {
      model: 'openai/gpt-5',
      text: 'long',
      label: 'review',
      timeoutMs: 60_000,
      log,
      outcome,
      wrapUpReserveMs: 59_000,
    });
    assert.equal(result.text, '{"findings":[]}');
    assert.equal(outcome.wrappedUp, true);
    const session = fake.sessions.get(id)!;
    assert.equal(session.interrupted, 1);
    assert.equal(session.agent, 'plan');
    assert.equal(fake.prompts.length, 2);
  });

  it('interrupts on timeout when no wrap-up is possible', async () => {
    const fake = fakeOpencodeServer(() => ({ hang: true }));
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    await assert.rejects(
      promptInSession(rt, id, {
        model: 'openai/gpt-5',
        text: 'x',
        label: 'verify',
        timeoutMs: 100,
        log,
      }),
      /did not finish within/,
    );
    assert.equal(fake.sessions.get(id)!.interrupted, 1);
  });
});

describe('wrap-up capability', () => {
  it('follows the agent: every tool-bearing turn can be finalized, a tool-less one never reserves', async () => {
    const fake = fakeOpencodeServer((session) =>
      session.agent === 'jbot-wrapup' ? { text: 'done' } : { hang: true },
    );
    const rt = runtime(fake);
    const aux = await createReviewSession(rt, { label: 'aux', model: 'openai/gpt-5' });
    const plain = await createReviewSession(rt, {
      label: 'plain',
      model: 'openai/gpt-5',
      agent: 'jbot-plain',
    });
    const auxTurn = promptInSession(rt, aux, {
      model: 'openai/gpt-5',
      text: 'x',
      label: 'aux',
      timeoutMs: 60_000,
      log,
    });
    const outcome = { wrappedUp: false };
    const plainTurn = promptInSession(rt, plain, {
      model: 'openai/gpt-5',
      text: 'x',
      label: 'plain',
      timeoutMs: 300,
      log,
      outcome,
      wrapUpReserveMs: 250,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'aux', log, 30_000), 1);
    assert.equal((await auxTurn).text, 'done');
    assert.equal(fake.sessions.get(aux)!.agent, 'plan');
    assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'plain', log, 30_000), 0);
    await assert.rejects(plainTurn, /did not finish within/);
    assert.equal(outcome.wrappedUp, false);
    assert.equal(abortOpencodeSessionsByLabel(rt.client, 'unknown', log), 0);
  });
});

describe('startProgressLogger', () => {
  it('logs tool calls and failures for known sessions by label and ignores the rest', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '' }));
    const rt = runtime(fake);
    const lines: string[] = [];
    const stop = startProgressLogger(rt.client, (m) => lines.push(m));
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    await new Promise((r) => setTimeout(r, 50));
    fake.emit({
      type: 'session.tool.called',
      data: { sessionID: id, input: { command: 'git  diff\n--stat' } },
    });
    fake.emit({
      type: 'session.tool.called',
      data: { sessionID: 'ses_unknown', input: { filePath: 'x' } },
    });
    fake.emit({
      type: 'session.execution.failed',
      data: { sessionID: id, error: { message: 'quota' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    assert.deepEqual(lines, [
      'review tool: command=git diff --stat',
      'review execution failed: quota',
    ]);
  });
});
