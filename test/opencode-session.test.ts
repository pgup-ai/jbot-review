import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createReviewSession,
  configureOpencodeTelemetry,
  finalizeOpencodeSessionsByLabel,
  promptInSession,
  startProgressLogger,
} from '../src/shared/opencode-session.ts';
import { DENY_ALL } from '../src/shared/opencode-config.ts';
import { fakeOpencodeServer, fakeRuntime as runtime } from './support/opencode-fake.ts';

import { createTelemetryRecorder } from '../src/shared/telemetry.ts';
import { createToolTelemetryAccumulator } from '../src/shared/tool-telemetry.ts';

const log = () => undefined;

describe('createReviewSession', () => {
  it('registers independent phase labels without model options, including forked verifiers', async (t) => {
    const before = { ...process.env };
    process.env.JBOT_READ_EVIDENCE = 'linked';
    process.env.JBOT_READ_EVIDENCE_PHASE = 'verification';
    t.after(() => {
      for (const key of ['JBOT_READ_EVIDENCE', 'JBOT_READ_EVIDENCE_PHASE']) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    });
    const fake = fakeOpencodeServer(() => ({ text: '{}' }));
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const fork = await createReviewSession(rt, {
      label: 'finding-verification',
      model: 'openai/gpt-5',
      forkFrom: id,
    });
    const options = JSON.parse(readFileSync(rt.sessionOptionsFile, 'utf8'));
    assert.deepEqual(options[id], { jbotSessionLabel: 'review' });
    assert.deepEqual(options[fork], { jbotSessionLabel: 'finding-verification' });
    assert.equal('JBOT_READ_EVIDENCE_PHASE' in fake.sessions.get(fork)!.environment!, false);
  });

  it('creates a plan session at the workspace with the ruleset and replaces its shell env', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{}' }));
    const id = await createReviewSession(runtime(fake), { label: 'review', model: 'openai/gpt-5' });
    const session = fake.sessions.get(id)!;
    assert.equal(session.agent, 'plan');
    assert.deepEqual(session.model, { providerID: 'openai', id: 'gpt-5' });
    assert.ok(Array.isArray(session.permissions) && session.permissions.length > 0);
    assert.ok(session.environment && 'PATH' in session.environment);
    assert.equal('OPENCODE_CONFIG_CONTENT' in session.environment!, false);
    const plain = await createReviewSession(runtime(fake), {
      label: 'plain',
      model: 'openai/gpt-5',
      agent: 'jbot-plain',
    });
    // session rules append after the agent's, so a tool-less session carries deny-all itself
    assert.deepEqual(fake.sessions.get(plain)!.permissions, DENY_ALL);
  });
});

describe('promptInSession', () => {
  it('returns the newest completed assistant text and records usage once, sending no message id', async () => {
    const fake = fakeOpencodeServer((_s, text) => ({
      text: `echo:${text}`,
      delayMs: 20,
      steps: 3,
    }));
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
    assert.equal(first, 'echo:one');
    assert.equal(second, 'echo:two');
    assert.equal(usage.length, 1);
    assert.equal((usage[0] as { input: number }).input, 30, 'usage spans every step of the turn');
    assert.ok(fake.prompts.every((p) => p.body.id === undefined));
    assert.ok(fake.calls.some((c) => /POST .*\/wait$/.test(c)));
  });

  it('hands off successful tool inputs from review without copying outputs or verification history', async () => {
    const fake = fakeOpencodeServer(() => ({
      text: '{}',
      tools: [
        {
          name: 'read',
          input: { filePath: 'guard.ts', offset: 20 },
          output: 'source; reviewer conclusion',
        },
      ],
    }));
    const rt = runtime(fake);
    const observed = [];
    rt.onSourceRead = (tool, input) => observed.push({ tool, input });
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    await promptInSession(rt, id, {
      model: 'openai/gpt-5',
      text: 'review',
      label: 'review',
      timeoutMs: 5000,
      log,
    });
    await promptInSession(rt, id, {
      model: 'openai/gpt-5',
      text: 'verify',
      label: 'finding-verification',
      timeoutMs: 5000,
      log,
    });
    assert.deepEqual(observed, [{ tool: 'read', input: { filePath: 'guard.ts', offset: 20 } }]);
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
    assert.equal(result, 'late');
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
    assert.equal(empty, '');
  });

  it('wraps up a cut-off turn: interrupt, switch to jbot-wrapup, prompt again, restore the agent', async () => {
    const fake = fakeOpencodeServer((session, text) =>
      session.agent === 'jbot-wrapup'
        ? { text: '{"findings":[]}' }
        : { hang: true, text, tools: [{ name: 'read', input: { filePath: 'guard.ts' } }] },
    );
    const rt = runtime(fake);
    const recorder = createTelemetryRecorder(true);
    configureOpencodeTelemetry(fake.client, createToolTelemetryAccumulator(recorder, 'salt'));
    const reads = [],
      usage = [];
    rt.onSourceRead = (tool, input) => reads.push({ tool, input });
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
      onTokenUsage: (value, _model, label) => usage.push({ label, ...value }),
    });
    assert.equal(result, '{"findings":[]}');
    assert.equal(outcome.wrappedUp, true);
    const session = fake.sessions.get(id)!;
    assert.equal(session.interrupted, 1);
    assert.equal(session.agent, 'plan');
    assert.equal(fake.prompts.length, 2);
    assert.deepEqual(reads, [{ tool: 'read', input: { filePath: 'guard.ts' } }]);
    const rows = recorder
      .toJsonl()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      rows.find((row) => row.session === 'review' && row.kind === 'exploration').toolCalls,
      1,
    );
    assert.equal(
      rows.find((row) => row.session === 'review-wrap-up' && row.kind === 'exploration').toolCalls,
      0,
    );
    assert.deepEqual(
      usage.map((row) => [row.label, row.input]),
      [
        ['review-wrap-up', 10],
        ['review', 10],
      ],
    );
  });

  it('does not count the main turn again when wrap-up fails', async () => {
    const fake = fakeOpencodeServer((session) =>
      session.agent === 'jbot-wrapup'
        ? { error: 'provider failure' }
        : { hang: true, tools: [{ name: 'read', input: { path: 'guard.ts' } }] },
    );
    const rt = runtime(fake);
    const recorder = createTelemetryRecorder(true);
    configureOpencodeTelemetry(fake.client, createToolTelemetryAccumulator(recorder, 'salt'));
    const usage: object[] = [];
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    await assert.rejects(
      promptInSession(rt, id, {
        model: 'openai/gpt-5',
        text: 'review',
        label: 'review',
        log,
        timeoutMs: 60_000,
        wrapUpReserveMs: 59_990,
        outcome: { wrappedUp: false },
        onTokenUsage: (row) => usage.push(row),
      }),
      /provider failure/,
    );
    const rows = recorder
      .toJsonl()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.find((r) => r.kind === 'exploration' && r.session === 'review').toolCalls, 1);
    assert.deepEqual(
      usage.map((u) => (u as { input: number }).input),
      [10, 10],
    );
  });

  it('reports a listing that stops short and leaves usage unknown without token counts', async () => {
    const fake = fakeOpencodeServer((_s, text) =>
      text === 'deep' ? { text: 'x', steps: 250 } : { text: 'x', noTokens: true },
    );
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    const lines: string[] = [];
    const usage: object[] = [];
    const spec = {
      model: 'openai/gpt-5',
      label: 'review',
      timeoutMs: 5_000,
      log: (m: string) => lines.push(m),
      onTokenUsage: (u: object) => usage.push(u),
    };
    await promptInSession(rt, id, { ...spec, text: 'first' });
    await promptInSession(rt, id, { ...spec, text: 'deep' });
    assert.deepEqual(Object.keys(usage[0]!), ['promptBytes']);
    assert.ok(lines.some((line) => line.includes('turn listing incomplete')));
  });

  it('interrupts the session when the prompt request itself fails', async () => {
    const fake = fakeOpencodeServer(() => ({ rejectPrompt: true }));
    const rt = runtime(fake);
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    await assert.rejects(
      promptInSession(rt, id, {
        model: 'openai/gpt-5',
        text: 'x',
        label: 'review',
        timeoutMs: 5_000,
        log,
      }),
    );
    assert.equal(fake.sessions.get(id)!.interrupted, 1);
  });

  it('interrupts on timeout when no wrap-up is possible', async () => {
    const fake = fakeOpencodeServer(() => ({
      hang: true,
      tools: [{ name: 'read', input: { path: 'guard.ts' } }],
    }));
    const rt = runtime(fake);
    const recorder = createTelemetryRecorder(true);
    configureOpencodeTelemetry(fake.client, createToolTelemetryAccumulator(recorder, 'salt'));
    const usage: object[] = [];
    const id = await createReviewSession(rt, { label: 'review', model: 'openai/gpt-5' });
    await assert.rejects(
      promptInSession(rt, id, {
        model: 'openai/gpt-5',
        text: 'x',
        label: 'verify',
        timeoutMs: 100,
        log,
        onTokenUsage: (row) => usage.push(row),
      }),
      /did not finish within/,
    );
    assert.equal(fake.sessions.get(id)!.interrupted, 1);
    const row = recorder
      .toJsonl()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((row) => row.kind === 'exploration');
    assert.equal(row.toolCalls, 1);
    assert.equal(row.stopReason, 'failed');
    assert.equal((usage[0] as { input: number }).input, 10);
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
    while (fake.prompts.length < 2) await new Promise((r) => setTimeout(r, 5));
    assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'aux', log, 30_000), 1);
    assert.equal(await auxTurn, 'done');
    assert.equal(fake.sessions.get(aux)!.agent, 'plan');
    assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'plain', log, 30_000), 0);
    await assert.rejects(plainTurn, /did not finish within/);
    assert.equal(outcome.wrappedUp, false);
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
