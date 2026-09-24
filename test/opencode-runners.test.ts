import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  abortOpencodeSessionsByLabel,
  disableContext7Mcp,
  enableContext7Mcp,
  finalizeOpencodeSessionsByLabel,
  runAddressedPriorCommentsCheck,
  runFindingVerification,
  runGuidelineComplianceCheck,
  runReview,
} from '../src/shared/opencode.ts';
import { permissionRules } from '../src/shared/opencode-config.ts';
import {
  CONTINUATION_NUDGE_PROMPT,
  NO_TOOLS_REVIEW_DIRECTIVE,
  WRAP_UP_PROMPT,
} from '../src/shared/prompt.ts';
import type { Finding } from '../src/shared/types.ts';
import {
  fakeOpencodeServer,
  fakeRuntime as runtime,
  type FakeReply,
} from './support/opencode-fake.ts';

const log = () => undefined;
const finding = {
  path: 'a.ts',
  line: 1,
  severity: 'high',
  title: 't',
  body: 'b',
  confidence: 0.9,
} as unknown as Finding;
const verdicts = '{"verdicts":[{"index":0,"verdict":"confirmed","reason":"traced it"}]}';

describe('runReview on V2', () => {
  it('parses a valid first response without a repair prompt, on the plan agent', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{"findings":[],"summary":"ok"}' }));
    const result = await runReview(runtime(fake), 'openai/gpt-5', 'ctx', '', log);
    assert.deepEqual(result.findings, []);
    assert.equal(fake.prompts.length, 1);
    assert.equal([...fake.sessions.values()][0]!.agent, 'plan');
    await runReview(runtime(fake, { reviewerAgent: true }), 'openai/gpt-5', 'ctx', '', log);
    assert.equal([...fake.sessions.values()][1]!.agent, 'jbot-reviewer');
  });

  it('repairs a malformed attempt with one same-session re-prompt', async () => {
    let n = 0;
    const fake = fakeOpencodeServer(() =>
      ++n === 1 ? { text: '{"summary": "broken' } : { text: '{"findings":[]}' },
    );
    const result = await runReview(runtime(fake), 'openai/gpt-5', 'ctx', '', log);
    assert.deepEqual(result.findings, []);
    assert.equal(fake.prompts.length, 2);
    assert.equal(new Set(fake.prompts.map((p) => p.sessionID)).size, 1);
    assert.match(fake.prompts[1]!.body.text, /could not be parsed as JSON/);
  });

  it('continues an abandoned turn (prose or reasoning-only) with one same-session nudge', async () => {
    for (const first of [{ text: 'this is not json at all, sorry' }, {}]) {
      let n = 0;
      const fake = fakeOpencodeServer(() =>
        ++n === 1 ? first : { text: '{"findings":[],"summary":"ok"}' },
      );
      const result = await runReview(runtime(fake), 'openai/gpt-5', 'ctx', '', log);
      assert.equal(fake.prompts.length, 2);
      assert.equal(fake.prompts[1]!.body.text, CONTINUATION_NUDGE_PROMPT);
      assert.equal(result.summary, 'ok');
    }
  });

  it('fails the run when the repair is also malformed or the wrap-up reply cannot be parsed', async () => {
    const twice = fakeOpencodeServer(() => ({ text: '{"summary": "broken' }));
    await assert.rejects(
      runReview(runtime(twice), 'openai/gpt-5', 'ctx', '', log),
      /unparseable JSON/,
    );
    assert.equal(twice.prompts.length, 2);
    const cut = fakeOpencodeServer((session) =>
      session.agent === 'jbot-wrapup' ? { text: 'not json' } : { hang: true },
    );
    const rt = runtime(cut);
    const review = runReview(rt, 'openai/gpt-5', 'ctx', '', log, { timeoutMs: 60_000 });
    while (cut.prompts.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'review', log, 30_000), 1);
    await assert.rejects(review, /unparseable JSON/);
  });

  it('keeps the BASE label abortable while a repair prompt is in flight', async () => {
    let n = 0;
    const fake = fakeOpencodeServer(() =>
      ++n === 1 ? { text: '{"summary": "broken' } : { hang: true },
    );
    const rt = runtime(fake);
    const pending = runReview(rt, 'openai/gpt-5', 'ctx', '', log, { timeoutMs: 5_000 }).catch(
      (error: unknown) => error,
    );
    while (fake.prompts.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(abortOpencodeSessionsByLabel(rt.client, 'review', log), 1);
    await pending;
    assert.equal([...fake.sessions.values()][0]!.interrupted, 1);
  });

  it('reuses the main session for the guideline sweep and keeps main findings when it fails', async () => {
    const main =
      '{"findings":[{"path":"a.ts","line":1,"severity":"P1","title":"t","body":"b"}],"summary":"ok"}';
    for (const sweep of [
      { text: '{"findings":[{"path":"b.ts","line":2,"severity":"P2","title":"rule","body":"v"}]}' },
      { text: '{}' },
      { text: 'x', error: 'sweep unavailable' },
    ]) {
      let n = 0;
      const fake = fakeOpencodeServer(() => (++n === 1 ? { text: main } : sweep));
      const coverage: Array<{ state: string }> = [];
      const result = await runReview(runtime(fake), 'openai/gpt-5', 'CTX', 'GUIDES', log, {
        guidelineSweep: {
          guidelines: 'FULL GUIDES',
          onCoverage: (row) => coverage.push(row as { state: string }),
        },
      });
      const ok = sweep.text?.startsWith('{"findings"');
      assert.equal(fake.sessions.size, 1);
      assert.equal(fake.prompts.length, 2);
      assert.match(fake.prompts[1]!.body.text, /FULL GUIDES/);
      assert.equal(result.findings.length, ok ? 2 : 1);
      assert.equal(coverage[0]?.state, ok ? 'completed' : 'failed');
    }
  });

  it('routes a single-shot model to the tool-less agent with the no-tools directive', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{"findings":[]}' }));
    const rt = runtime(fake, { verifyFork: true });
    await runReview(rt, 'openai-compatible/gemini-2.5-pro', 'ctx', '', log);
    assert.equal([...fake.sessions.values()][0]!.agent, 'jbot-plain');
    // a tool-less main session is never a fork candidate
    await runFindingVerification(rt, 'openai/gpt-5', 'ctx', [finding], log);
    assert.equal(
      [...fake.sessions.values()].some((s) => s.forkedFrom),
      false,
    );
    assert.ok(fake.prompts[0]!.body.text.includes(NO_TOOLS_REVIEW_DIRECTIVE.split('\n')[0]!));
  });

  it('runs tool-less passes closed-book and the capped re-check on jbot-verify unless tool_choice is auto-only', async () => {
    const lens = fakeOpencodeServer(() => ({ text: '{"findings":[]}' }));
    await runReview(runtime(lens), 'openai/gpt-5', 'ctx', '', log, { toolLess: true });
    assert.equal([...lens.sessions.values()][0]!.agent, 'jbot-closed-book');
    assert.ok(lens.prompts[0]!.body.text.startsWith(NO_TOOLS_REVIEW_DIRECTIVE));
    const verify = fakeOpencodeServer(() => ({ text: verdicts }));
    for (const mode of ['single-shot', 'capped'] as const)
      await runFindingVerification(
        runtime(verify),
        'openai/gpt-5',
        'ctx',
        [finding],
        log,
        undefined,
        undefined,
        undefined,
        mode,
      );
    await runFindingVerification(
      runtime(verify),
      'opencode-go/muse-spark-1.3-contributor',
      'ctx',
      [finding],
      log,
      undefined,
      undefined,
      undefined,
      'capped',
    );
    assert.deepEqual(
      [...verify.sessions.values()].map((session) => session.agent),
      ['jbot-closed-book', 'jbot-verify', 'plan'],
    );
    assert.match(verify.prompts[0]!.body.text, /have no tools on this call/);
  });

  it('records one usage row per attempted prompt, repair and failure included', async () => {
    for (const replies of [
      [{ text: '{"summary": "broken' }, { text: '{"findings":[]}' }],
      [{ text: 'x', error: 'rejected' }],
    ] as FakeReply[][]) {
      let n = 0;
      const fake = fakeOpencodeServer(() => replies[Math.min(n++, replies.length - 1)]!);
      const usages: Array<{ promptBytes?: number }> = [];
      const run = runReview(runtime(fake), 'openai/gpt-5', 'ctx', '', log, {
        onTokenUsage: (usage) => usages.push(usage),
      });
      if (replies.some((r) => r.error)) await assert.rejects(run, /rejected/);
      else await run;
      assert.deepEqual(
        usages.map((u) => u.promptBytes),
        fake.prompts.map((p) => Buffer.byteLength(p.body.text, 'utf8')),
      );
    }
  });

  it('marks a review wrapped up by the grace finalize partial and skips the guideline sweep', async () => {
    for (const toolLess of [false, true]) {
      const wrapUpAgents: string[] = [];
      const fake = fakeOpencodeServer((session, text) => {
        if (text !== WRAP_UP_PROMPT) return { hang: true };
        wrapUpAgents.push(session.agent);
        return { text: '{"findings":[]}' };
      });
      const rt = runtime(fake);
      const review = runReview(rt, 'openai/gpt-5', 'ctx', '', log, {
        timeoutMs: 60_000,
        toolLess,
        guidelineSweep: { guidelines: 'g', findings: [] } as never,
      });
      while (fake.prompts.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'review', log, 30_000), 1);
      const result = await review;
      assert.equal(result.partial, true);
      assert.equal(fake.prompts.length, 2);
      // A closed-book pass wraps up in place, so its tools stay denied.
      assert.deepEqual(wrapUpAgents, [toolLess ? 'jbot-closed-book' : 'jbot-wrapup']);
    }
  });
});

describe('auxiliary runners on V2', () => {
  it('nudges an abandoned turn once, rejects wrong-field or malformed repairs, propagates transport failures', async () => {
    const compliance = (fake: ReturnType<typeof fakeOpencodeServer>) =>
      runGuidelineComplianceCheck(runtime(fake), 'openai/gpt-5', 'ctx', 'guides', log);
    const addressed = (fake: ReturnType<typeof fakeOpencodeServer>) =>
      runAddressedPriorCommentsCheck(runtime(fake), 'openai/gpt-5', 'ctx', log);
    const sequence = (...replies: Array<Record<string, unknown>>) => {
      let n = 0;
      return fakeOpencodeServer(() => replies[Math.min(n++, replies.length - 1)]!);
    };
    let fake = sequence(
      { text: 'prose, not json' },
      { text: '{"findings":[{"path":"a.ts","line":1,"severity":"P2","title":"t","body":"b"}]}' },
    );
    assert.equal((await compliance(fake)).length, 1);
    assert.equal(fake.prompts[1]!.body.text, CONTINUATION_NUDGE_PROMPT);
    fake = sequence(
      { text: 'prose' },
      {
        text: '{"summary":"","findings":[],"addressedPriorComments":[{"id":"PRRT_abc","addressedByCommit":"abc1234"}]}',
      },
    );
    assert.deepEqual(await addressed(fake), [{ id: 'PRRT_abc', addressedByCommit: 'abc1234' }]);
    await assert.rejects(
      compliance(sequence({ text: '{}' }, { text: '{"addressedPriorComments":[]}' })),
      /findings array/,
    );
    await assert.rejects(
      addressed(sequence({ text: '{}' }, { text: '{"findings":[]}' })),
      /addressedPriorComments array/,
    );
    await assert.rejects(
      compliance(sequence({ text: 'prose' }, { text: 'x', error: 'socket hang up' })),
      /socket hang up/,
    );
  });
});

describe('runFindingVerification on V2', () => {
  it('recovers unusable output once in a native read-only fork without replacing completed judgments', async () => {
    for (const first of [
      '',
      '{}',
      '{"verdicts":[{"index":0,"verdict":"refuted","reason":"already checked"}]}',
    ]) {
      const fake = fakeOpencodeServer((session) => ({
        text: session.forkedFrom
          ? '{"verdicts":[{"index":0,"verdict":"uncertain","reason":"unfinished"},{"index":1,"verdict":"uncertain","reason":"unfinished"}]}'
          : first,
      }));
      const rt = runtime(fake);
      const result = await runFindingVerification(
        rt,
        'opencode/mimo-v2.6-flash-free',
        'ctx',
        [finding, finding],
        log,
        300_000,
      );
      assert.deepEqual(
        result?.map((v) => v.verdict),
        [first === '' || first === '{}' ? 'uncertain' : 'refuted', 'uncertain'],
      );
      const [main, repair] = [...fake.sessions.values()];
      assert.equal(repair.forkedFrom, main.id);
      assert.equal(repair.agent, main.agent);
      assert.deepEqual(repair.permissions, permissionRules());
      assert.deepEqual(repair.model, main.model);
      assert.equal(fake.prompts.length, 2);
      assert.match(fake.prompts[1].body.text, /Use uncertain/);
    }
  });

  it('interrupts an incomplete verifier before recovering its collected evidence', async (t) => {
    for (const failure of [
      'did not finish within 240s',
      'settled without a completed assistant message',
    ]) {
      const fake = fakeOpencodeServer((session) =>
        session.forkedFrom
          ? { text: '{"verdicts":[{"index":0,"verdict":"uncertain","reason":"unfinished"}]}' }
          : {
              hang: true,
              tools: [{ name: 'read', input: { filePath: 'a.ts' }, output: 'collected source' }],
            },
      );
      const wait = fake.client.session.wait.bind(fake.client.session);
      let calls = 0;
      t.mock.method(fake.client.session, 'wait', (...args) => {
        if (++calls === 1) throw new Error(`opencode finding-verification prompt ${failure}`);
        return wait(...args);
      });
      const rt = runtime(fake);
      const result = await runFindingVerification(
        rt,
        'opencode/mimo-v2.6-flash-free',
        'ctx',
        [finding],
        log,
        300_000,
      );
      const [main, repair] = [...fake.sessions.values()];
      assert.equal(main.interrupted, 1);
      assert.match(JSON.stringify(repair.messages), /collected source/);
      assert.equal(result?.[0].verdict, 'uncertain');
    }
  });

  it('honors short budgets during setup and before recovery', async (t) => {
    for (const phase of ['setup', 'slow-setup', 'near-deadline', 'recovery']) {
      let now = 100_000;
      t.mock.method(Date, 'now', () => now);
      const logs: string[] = [];
      const fake = fakeOpencodeServer(() => {
        if (phase === 'near-deadline') now += 4_500;
        return { text: phase === 'slow-setup' ? verdicts : '{}' };
      });
      const create = fake.client.session.create.bind(fake.client.session);
      t.mock.method(fake.client.session, 'create', async (...args) => {
        const session = await create(...args);
        if (phase === 'setup') now += 5_000;
        if (phase === 'slow-setup') now += 250_000;
        return session;
      });
      const run = runFindingVerification(
        runtime(fake),
        'opencode/mimo-v2.6-flash-free',
        'ctx',
        [finding],
        (message) => logs.push(message),
        phase === 'slow-setup' ? 300_000 : 5_000,
      );
      if (phase === 'setup') {
        await assert.rejects(run, /Session setup budget exhausted/);
        assert.equal(fake.calls.length, 1);
      } else {
        const result = await run;
        if (phase === 'slow-setup') assert.equal(result?.[0].verdict, 'confirmed');
        else assert.equal(result, undefined);
        assert.equal(fake.prompts.length, phase === 'recovery' ? 2 : 1);
        if (phase === 'recovery') assert.match(logs.join('\n'), /remainingMs=5000/);
      }
    }
  });

  it('preserves partial verdicts on recovery failure and skips recovery without a deadline', async () => {
    for (const mode of ['no-deadline', 'recovery', 'empty', 'no-verdicts']) {
      const fake = fakeOpencodeServer((session) =>
        session.forkedFrom
          ? mode === 'empty' || mode === 'no-verdicts'
            ? { text: '{}' }
            : { error: 'recovery unavailable' }
          : {
              text:
                mode === 'no-verdicts'
                  ? '{}'
                  : '{"verdicts":[{"index":0,"verdict":"refuted","reason":"checked"}]}',
            },
      );
      const rt = runtime(fake);
      const logs: string[] = [];
      const result = await runFindingVerification(
        rt,
        'opencode/mimo-v2.6-flash-free',
        'ctx',
        [finding, finding],
        (message) => logs.push(message),
        mode === 'no-deadline' ? undefined : 300_000,
      );
      if (mode === 'no-verdicts') assert.equal(result, undefined);
      else {
        assert.equal(result?.length, 1);
        assert.equal(result?.[0].verdict, 'refuted');
      }
      assert.equal(fake.prompts.length, mode === 'no-deadline' ? 1 : 2);
      if (mode === 'recovery')
        assert.match(
          logs.join('\n'),
          /recovery failed: model=opencode\/mimo-v2.6-flash-free .*recovery unavailable/,
        );
    }
    const denied = fakeOpencodeServer(() => ({ error: 'usage limit' }));
    await assert.rejects(
      runFindingVerification(
        runtime(denied),
        'opencode/mimo-v2.6-flash-free',
        'ctx',
        [finding],
        log,
        300_000,
      ),
      /usage limit/,
    );
    assert.equal(denied.prompts.length, 1);
  });

  it("cites each finding's evidence quote in the verifier prompt", async () => {
    const fake = fakeOpencodeServer(() => ({ text: verdicts }));
    await runFindingVerification(
      runtime(fake),
      'openai/gpt-5',
      'ctx',
      [{ ...finding, evidence: 'return x - tax;' } as Finding],
      log,
    );
    assert.match(fake.prompts[0]!.body.text, /Cited line: return x - tax;/);
  });

  it('registers the verify tier only when verifier options were configured', async () => {
    const fake = fakeOpencodeServer(() => ({ text: verdicts }));
    const sessionOptionsFile = join(mkdtempSync(join(tmpdir(), 'jbot-opts-')), 'opts.json');
    const rt = runtime(fake, {
      sessionOptionsFile,
      modelOptions: {
        'openai/gpt-5': { main: { reasoningEffort: 'medium' }, verify: { reasoningEffort: 'low' } },
      },
    });
    await runFindingVerification(rt, 'openai/gpt-5', 'ctx', [finding], log, undefined, undefined, {
      reasoningEffort: 'low',
    });
    await runFindingVerification(rt, 'openai/gpt-5', 'ctx', [finding], log);
    const tiers = Object.values(JSON.parse(readFileSync(sessionOptionsFile, 'utf8'))).map(
      (o) => (o as { reasoningEffort: string }).reasoningEffort,
    );
    assert.deepEqual(tiers, ['low', 'medium']);
  });

  it('forks the main review session, not a lens pass, when JBOT_VERIFY_FORK is on', async () => {
    const fake = fakeOpencodeServer((session) =>
      session.forkedFrom ? { text: verdicts } : { text: '{"findings":[]}' },
    );
    const rt = runtime(fake, { verifyFork: true });
    await runReview(rt, 'openai/gpt-5', 'ctx', '', log);
    await runReview(rt, 'openai/gpt-5', 'ctx', '', log, {
      label: 'review-interactions',
      lensAddendum: 'lens',
    });
    await runFindingVerification(rt, 'openai/gpt-5', 'ctx', [finding], log);
    const main = [...fake.sessions.keys()][0];
    const forked = [...fake.sessions.values()].find((s) => s.forkedFrom);
    assert.equal(forked?.forkedFrom, main);
    assert.equal(forked?.agent, 'plan');
    assert.deepEqual(forked?.permissions, permissionRules(), 'a fork carries its own ruleset');
    assert.deepEqual(forked?.model, { providerID: 'openai', id: 'gpt-5' });
    // a failed attempt is not a fork candidate: its retry's session is
    let n = 0;
    const retried = fakeOpencodeServer((session) =>
      session.forkedFrom
        ? { text: verdicts }
        : ++n <= 2
          ? { text: '{"summary": "broken' }
          : { text: '{"findings":[]}' },
    );
    const rt2 = runtime(retried, { verifyFork: true });
    await assert.rejects(runReview(rt2, 'openai/gpt-5', 'ctx', '', log));
    await runReview(rt2, 'openai/gpt-5', 'ctx', '', log, { label: 'review-retry' });
    await runFindingVerification(rt2, 'openai/gpt-5', 'ctx', [finding], log);
    const second = [...retried.sessions.keys()][1];
    assert.equal([...retried.sessions.values()].find((s) => s.forkedFrom)?.forkedFrom, second);
  });
});

describe('context7 MCP on V2', () => {
  it('adds and connects the remote server, then disconnects it', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '' }));
    const rt = runtime(fake);
    assert.equal(await enableContext7Mcp(rt, 'ctx7-key', log), true);
    await disableContext7Mcp(rt, log);
    assert.ok(fake.calls.some((c) => /PUT .*\/mcp\/context7$/.test(c)));
    assert.ok(fake.calls.some((c) => /POST .*\/mcp\/context7\/connect$/.test(c)));
    assert.ok(fake.calls.some((c) => /POST .*\/mcp\/context7\/disconnect$/.test(c)));
  });
});
