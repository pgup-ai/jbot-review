import assert from 'node:assert/strict';
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
const runtime = (fake: ReturnType<typeof fakeOpencodeServer>): OpencodeRuntime => ({
  client: fake.client,
  workspace: '/ws',
  stop: () => undefined,
});

describe('createReviewSession', () => {
  it('creates a plan session at the workspace with the ruleset and replaces its shell env', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{}' }));
    const id = await createReviewSession(runtime(fake), {
      label: 'review',
      model: 'openai/gpt-5',
      variant: 'jbot-verify',
    });
    const session = fake.sessions.get(id)!;
    assert.equal(session.agent, 'plan');
    assert.deepEqual(session.model, { providerID: 'openai', id: 'gpt-5', variant: 'jbot-verify' });
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
      variant: 'jbot-verify',
      forkFrom: main,
    });
    const forked = fake.sessions.get(id)!;
    assert.equal(forked.forkedFrom, main);
    assert.equal(forked.agent, 'plan');
    assert.deepEqual(forked.model, { providerID: 'openai', id: 'gpt-5', variant: 'jbot-verify' });
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

describe('label registries', () => {
  it('aborts and finalizes only in-flight sessions under the label', async () => {
    const fake = fakeOpencodeServer((session) =>
      session.agent === 'jbot-wrapup' ? { text: 'done' } : { hang: true },
    );
    const rt = runtime(fake);
    const a = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const b = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const outcome = { wrappedUp: false };
    const inFlight = promptInSession(rt, a, {
      model: 'openai/gpt-5',
      text: 'x',
      label: 'review',
      timeoutMs: 60_000,
      log,
      outcome,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'review', log, 30_000), 1);
    assert.equal((await inFlight).text, 'done');
    assert.equal(abortOpencodeSessionsByLabel(rt.client, 'review', log), 0);
    assert.equal(abortOpencodeSessionsByLabel(rt.client, 'unknown', log), 0);
    assert.equal(fake.sessions.get(b)!.interrupted, 0);
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
    fake.emit({ type: 'session.tool.called', properties: { sessionID: id, tool: 'shell' } });
    fake.emit({
      type: 'session.tool.called',
      properties: { sessionID: 'ses_unknown', tool: 'read' },
    });
    fake.emit({
      type: 'session.execution.failed',
      properties: { sessionID: id, error: { message: 'quota' } },
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    assert.deepEqual(lines, ['review tool: shell', 'review execution failed: quota']);
  });
});
