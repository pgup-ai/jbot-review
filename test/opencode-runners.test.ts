import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { OpencodeRuntime } from '../src/shared/opencode-server.ts';
import {
  disableContext7Mcp,
  enableContext7Mcp,
  finalizeOpencodeSessionsByLabel,
  runFindingVerification,
  runReview,
} from '../src/shared/opencode.ts';
import type { Finding } from '../src/shared/types.ts';
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
  });

  it('uses the reviewer agent when opted in', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '{"findings":[]}' }));
    await runReview(runtime(fake, { reviewerAgent: true }), 'openai/gpt-5', 'ctx', '', log);
    assert.equal([...fake.sessions.values()][0]!.agent, 'jbot-reviewer');
  });

  it('repairs a malformed attempt with one same-session re-prompt', async () => {
    let n = 0;
    const fake = fakeOpencodeServer(() =>
      ++n === 1 ? { text: 'not json' } : { text: '{"findings":[]}' },
    );
    const result = await runReview(runtime(fake), 'openai/gpt-5', 'ctx', '', log);
    assert.deepEqual(result.findings, []);
    assert.equal(fake.prompts.length, 2);
    assert.equal(new Set(fake.prompts.map((p) => p.sessionID)).size, 1);
  });

  it('marks a review wrapped up by the grace finalize partial and skips the guideline sweep', async () => {
    const fake = fakeOpencodeServer((session) =>
      session.agent === 'jbot-wrapup' ? { text: '{"findings":[]}' } : { hang: true },
    );
    const rt = runtime(fake);
    const review = runReview(rt, 'openai/gpt-5', 'ctx', '', log, {
      timeoutMs: 60_000,
      guidelineSweep: { guidelines: 'g', findings: [] } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(finalizeOpencodeSessionsByLabel(rt.client, 'review', log, 30_000), 1);
    const result = await review;
    assert.equal(result.partial, true);
    assert.equal(fake.prompts.length, 2);
  });
});

describe('runFindingVerification on V2', () => {
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

  it('forks the single main review session when JBOT_VERIFY_FORK is on', async () => {
    const fake = fakeOpencodeServer((session) =>
      session.forkedFrom ? { text: verdicts } : { text: '{"findings":[]}' },
    );
    const rt = runtime(fake, { verifyFork: true });
    await runReview(rt, 'openai/gpt-5', 'ctx', '', log);
    await runFindingVerification(rt, 'openai/gpt-5', 'ctx', [finding], log);
    const forked = [...fake.sessions.values()].find((s) => s.forkedFrom);
    assert.ok(forked, 'verification session was forked from the review session');
  });
});

describe('context7 MCP on V2', () => {
  it('adds and connects the remote server with Code Mode off, then disconnects it', async () => {
    const fake = fakeOpencodeServer(() => ({ text: '' }));
    const rt = runtime(fake);
    assert.equal(await enableContext7Mcp(rt, 'ctx7-key', log), true);
    await disableContext7Mcp(rt, log);
    assert.ok(fake.calls.some((c) => /PUT .*\/mcp\/context7$/.test(c)));
    assert.ok(fake.calls.some((c) => /POST .*\/mcp\/context7\/connect$/.test(c)));
    assert.ok(fake.calls.some((c) => /POST .*\/mcp\/context7\/disconnect$/.test(c)));
  });
});
