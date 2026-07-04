import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildBody,
  buildShardPlans,
  buildSummaryScopeBlock,
  shouldSummarizeChangesSinceLastReview,
  buildMainShardFailureMessage,
  computeFinderTimeoutMs,
  computeRetryTimeoutMs,
  computeRunDeadline,
  computeVerificationTimeoutMs,
  emitReviewTelemetry,
  formatReviewedWith,
  normalizeOptions,
  renderReviewMetadataBlock,
  runPrReview,
} from '../src/shared/runner.ts';
import { createTelemetryRecorder } from '../src/shared/telemetry.ts';
import type { Octokit } from '../src/shared/github.ts';
import type { Finding } from '../src/shared/types.ts';

const PRIOR_JBOT_REVIEW = [
  '## J-Bot Code Review',
  '- earlier summary',
  '**Reviewed head:** `abc123def456`',
].join('\n');

/** Longest common leading substring — the region a provider can cache. */
function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

describe('buildShardPlans cache-stable prefix', () => {
  it('keeps the shared context as a byte-identical prefix across shards', () => {
    const coreContext = '## Pull request\nTitle: T\nDescription: shared core context';
    const context7Block = '## Context7 docs\nSHARED_CONTEXT7';
    const plans = buildShardPlans({
      coreContext,
      fullDiffBlock: '',
      context7Block,
      shards: [[{ filename: 'src/a.ts' }], [{ filename: 'src/b.ts' }]],
    });

    assert.equal(plans.length, 2);
    assert.notEqual(plans[0].context, plans[1].context);

    const prefix = commonPrefix(plans[0].context, plans[1].context);
    // The cacheable region carries the expensive shared content...
    assert.ok(prefix.includes(coreContext), 'coreContext must be in the shared prefix');
    assert.ok(prefix.includes('SHARED_CONTEXT7'), 'context7 must be in the shared prefix');
    // ...and none of the per-shard assignment (which is what diverges).
    assert.doesNotMatch(prefix, /reviewer 1\b/);
    assert.doesNotMatch(prefix, /reviewer 2\b/);
  });
});

describe('buildSummaryScopeBlock', () => {
  it('no longer instructs shards to describe changes since the reviewed head', () => {
    const block = buildSummaryScopeBlock();
    assert.doesNotMatch(block, /reviewed head/i);
    assert.doesNotMatch(block, /Latest prior reviewed head/i);
  });

  it('keeps the scope guardrail and asks for conclusions only', () => {
    const block = buildSummaryScopeBlock();
    assert.match(block, /affect ONLY the text of the "summary" field/);
    assert.match(block, /findings always come from the complete PR diff/);
    assert.match(block, /review conclusions/i);
  });

  // Regression pins for the wording that originally leaked into review scope on
  // small models (the headline recall gap): never tell the model to diff or
  // review only the prior..head delta. The delta narrative now lives in a
  // separate non-finder pass, so the finder shards never see this framing.
  it('never tells the model to diff or review only the delta', () => {
    const block = buildSummaryScopeBlock();
    assert.doesNotMatch(block, /git log/i);
    assert.doesNotMatch(block, /git diff/i);
    assert.doesNotMatch(block, /summarize only/i);
    assert.doesNotMatch(block, /review only/i);
  });
});

describe('shouldSummarizeChangesSinceLastReview', () => {
  it('is false on the first review (no prior jbot reviews)', () => {
    assert.equal(shouldSummarizeChangesSinceLastReview([], 'fffeeeddd111'), false);
  });

  it('is false when the head is unchanged since the last review', () => {
    assert.equal(shouldSummarizeChangesSinceLastReview([PRIOR_JBOT_REVIEW], 'abc123def456'), false);
  });

  it('is true on a re-review with a real delta', () => {
    assert.equal(shouldSummarizeChangesSinceLastReview([PRIOR_JBOT_REVIEW], 'fffeeeddd111'), true);
  });
});

describe('buildBody', () => {
  const finding: Finding = { path: 'a.ts', line: 1, severity: 'P2', title: 't', body: 'b' };

  it('renders the changes-since block above the summary when findings are present', () => {
    const body = buildBody(
      '- Reworked archive path.',
      '- Verdict looks good.',
      [finding],
      [],
      'm',
      'o',
      'r',
    );
    assert.match(body, /## J-Bot Code Review/);
    assert.match(body, /\*\*Changes since last review\*\*/);
    assert.ok(
      body.indexOf('Changes since last review') < body.indexOf('Verdict looks good'),
      'block must precede the summary',
    );
  });

  it('omits the changes-since block (and header) when the text is empty', () => {
    const body = buildBody('', '- Verdict looks good.', [finding], [], 'm', 'o', 'r');
    assert.doesNotMatch(body, /Changes since last review/);
  });

  it('drops the per-shard verification narrative on a zero-findings review', () => {
    const body = buildBody(
      '',
      '- I verified the auth path and it is sound.',
      [],
      [],
      'm',
      'o',
      'r',
    );
    assert.doesNotMatch(body, /I verified the auth path/);
    assert.match(body, /No new findings/);
  });

  it('keeps the summary when there are findings to contextualize', () => {
    const body = buildBody('', '- Grouped finding summary.', [finding], [], 'm', 'o', 'r');
    assert.match(body, /Grouped finding summary/);
  });

  it('omits the summary block (no filler) when findings exist but the summary is empty', () => {
    const body = buildBody('', '', [finding], [], 'm', 'o', 'r');
    assert.doesNotMatch(body, /No summary provided/);
  });

  it('omits the summary block when every summary line is an all-clear verdict', () => {
    const body = buildBody(
      '',
      'No blocking findings in the assigned files.',
      [finding],
      [],
      'm',
      'o',
      'r',
    );
    assert.doesNotMatch(body, /No summary provided/);
    assert.doesNotMatch(body, /No blocking findings/);
  });

  it('keeps the changes-since block on a clean re-review even when the summary is dropped', () => {
    const body = buildBody(
      '- Rebased onto main.',
      '- low-value verification narrative.',
      [],
      [],
      'm',
      'o',
      'r',
    );
    assert.match(body, /\*\*Changes since last review\*\*/);
    assert.match(body, /Rebased onto main/);
    assert.doesNotMatch(body, /low-value verification narrative/);
  });
});

describe('session timeout budgeting', () => {
  it('gives finders the full budget minus the posting reserve, within clamps', () => {
    assert.equal(computeFinderTimeoutMs(0), undefined);
    assert.equal(computeFinderTimeoutMs(10), 10 * 60_000 - 30_000); // ~9.5m for a 10m budget
    assert.equal(computeFinderTimeoutMs(1), 30_000); // never exceeds the run deadline
    assert.equal(computeFinderTimeoutMs(30), 30 * 60_000 - 30_000); // default budget
    assert.equal(computeFinderTimeoutMs(120), 30 * 60_000); // ceiling
  });

  it('gives verification what actually remains, or signals a skip', () => {
    assert.equal(computeVerificationTimeoutMs(0, 999_999), undefined);
    // 6m budget, 3m elapsed: 3m - 30s reserve = 150s remaining.
    assert.equal(computeVerificationTimeoutMs(6, 3 * 60_000), 150_000);
    // Nearly exhausted: skip signal (0), never a tiny unusable timeout.
    assert.equal(computeVerificationTimeoutMs(6, 6 * 60_000), 0);
    // Huge budget: capped at 5 minutes.
    assert.equal(computeVerificationTimeoutMs(120, 0), 5 * 60_000);
  });
});

describe('shard retry budgeting', () => {
  it('retries with the original timeout when no budget is set', () => {
    assert.equal(computeRetryTimeoutMs(undefined, 1_000, 390_000), 390_000);
    assert.equal(computeRetryTimeoutMs(undefined, 1_000, undefined), undefined);
  });

  it('caps the retry at the remaining budget', () => {
    const deadline = 600_000;
    // 4 minutes remain, finder timeout is 6.5 — retry gets the 4 minutes.
    assert.equal(computeRetryTimeoutMs(deadline, 360_000, 390_000), 240_000);
    // Plenty remains — retry keeps the finder timeout.
    assert.equal(computeRetryTimeoutMs(deadline, 100_000, 390_000), 390_000);
  });

  it('skips the retry when under a usable minute remains', () => {
    assert.equal(computeRetryTimeoutMs(600_000, 550_000, 390_000), 0);
    assert.equal(computeRetryTimeoutMs(600_000, 700_000, 390_000), 0);
  });
});

describe('computeRunDeadline', () => {
  it('derives the absolute deadline from the budget minus the posting reserve', () => {
    assert.equal(computeRunDeadline(10, 1_000_000), 1_000_000 + 10 * 60_000 - 30_000);
    assert.equal(computeRunDeadline(0, 1_000_000), undefined);
  });
});

describe('buildMainShardFailureMessage', () => {
  it('makes partial main-review coverage a fatal error', () => {
    const message = buildMainShardFailureMessage(1, 2, new Error('git diff failed'));

    assert.match(message, /1 of 2 main review shard\(s\) failed/);
    assert.match(message, /refusing to post partial review coverage/);
    assert.match(message, /git diff failed/);
  });

  it('labels a missing error as unknown', () => {
    const message = buildMainShardFailureMessage(2, 3, undefined);

    assert.match(message, /2 of 3 main review shard\(s\) failed/);
    assert.match(message, /First failure: unknown error/);
  });

  it('stringifies a non-Error failure value', () => {
    const message = buildMainShardFailureMessage(1, 4, 'provider 429');

    assert.match(message, /First failure: provider 429/);
  });
});

describe('renderReviewMetadataBlock', () => {
  it('renders collapsed review metadata with model and token counters', () => {
    const block = renderReviewMetadataBlock('opencode/deepseek-v4-flash-free', {
      models: ['opencode/deepseek-v4-flash-free'],
      input: 100,
      output: 20,
      reasoning: 30,
      cacheRead: 40,
      cacheWrite: 50,
      costUsd: 1.23456,
      creditCost: 2.5,
      acuCost: 3,
    }).join('\n');

    assert.match(block, /^<details>/m);
    assert.doesNotMatch(block, /<details open>/);
    assert.match(block, /<summary>Review metadata<\/summary>/);
    assert.match(block, /model=opencode\/deepseek-v4-flash-free/);
    assert.match(block, /input=100/);
    assert.match(block, /output=20/);
    assert.match(block, /reasoning=30/);
    assert.match(block, /cache read=40/);
    assert.match(block, /cache write=50/);
    assert.match(block, /cost usd=1\.2346/);
    assert.match(block, /credit cost=2\.5000/);
    assert.match(block, /acu cost=3/);
  });

  it('labels aggregate totals with every model that contributed usage', () => {
    const block = renderReviewMetadataBlock('openai/gpt-5', {
      models: ['openai/gpt-5', 'opencode-go/minimax-m3'],
      input: 100,
      output: 20,
      reasoning: 30,
      cacheRead: 40,
      cacheWrite: 50,
    }).join('\n');

    assert.match(block, /models=openai\/gpt-5, opencode-go\/minimax-m3/);
    assert.doesNotMatch(block, /model=openai\/gpt-5\ninput=100/);
  });

  it('includes the main model even when only aux providers report token usage', () => {
    const block = renderReviewMetadataBlock('devin/glm-5.2', {
      models: ['opencode/deepseek-v4-flash-free'],
      input: 100,
      output: 20,
      reasoning: 30,
      cacheRead: 40,
      cacheWrite: 50,
    }).join('\n');

    assert.match(block, /models=devin\/glm-5\.2, opencode\/deepseek-v4-flash-free/);
  });

  it('omits non-finite cost totals from review metadata', () => {
    const block = renderReviewMetadataBlock('opencode/deepseek-v4-flash-free', {
      models: ['opencode/deepseek-v4-flash-free'],
      input: 100,
      output: 20,
      reasoning: 30,
      cacheRead: 40,
      cacheWrite: 50,
      costUsd: Infinity,
      creditCost: NaN,
      acuCost: -Infinity,
    }).join('\n');

    assert.match(block, /input=100/);
    assert.doesNotMatch(block, /cost usd=/);
    assert.doesNotMatch(block, /credit cost=/);
    assert.doesNotMatch(block, /acu cost=/);
  });

  it('omits the block when token usage was unavailable', () => {
    assert.deepEqual(renderReviewMetadataBlock('opencode/deepseek-v4-flash-free'), []);
  });
});

describe('formatReviewedWith', () => {
  it('mentions auxiliary models when they differ from the main reviewer', () => {
    assert.equal(
      formatReviewedWith('devin/glm-5.2', {
        models: ['opencode/deepseek-v4-flash-free'],
        input: 100,
        output: 20,
        reasoning: 30,
        cacheRead: 40,
        cacheWrite: 50,
      }),
      'Reviewed with `devin/glm-5.2`; auxiliary sessions used `opencode/deepseek-v4-flash-free`.',
    );
  });
});

describe('runPrReview local mode (localDiff)', () => {
  // Blank workspace skips ensureGitSafeDirectory, so tests never touch the
  // developer's global git config.
  const base = {
    owner: 'local',
    repo: 'local',
    pullNumber: 0,
    pullTitle: 'local review',
    pullBody: '',
    workspace: '',
    model: 'opencode/test-model',
    apiKey: 'test-key',
  };

  it('throws when localDiff is provided without dryRun', async () => {
    await assert.rejects(
      runPrReview({
        ...base,
        localDiff: { files: [], commits: [] },
        options: {},
        log: () => {},
      }),
      /dryRun/,
    );
  });

  // A GitHub-backed run with no client fails with the accurate reason, not the
  // local-mode Proxy's misleading message.
  it('throws a clear error when neither octokit nor localDiff is provided', async () => {
    await assert.rejects(
      runPrReview({ ...base, options: { dryRun: true }, log: () => {} }),
      /octokit client unless localDiff/,
    );
  });

  // No `octokit` at all: the runner's internal landmine Proxy throws on ANY
  // property access, so completing proves local mode performs zero GitHub
  // calls on this path — structurally, not by mock bookkeeping.
  it('completes a doc-only local dry run with no octokit and no GitHub access', async () => {
    const logs: string[] = [];
    await runPrReview({
      ...base,
      localDiff: {
        files: [{ filename: 'README.md', patch: '@@ -1 +1 @@\n-a\n+b' }],
        commits: [],
      },
      options: { dryRun: true },
      log: (msg) => logs.push(msg),
    });
    assert.ok(logs.some((msg) => /doc-only/i.test(msg)));
  });

  it('completes with zero reviewable local files with no octokit', async () => {
    const logs: string[] = [];
    await runPrReview({
      ...base,
      localDiff: { files: [{ filename: 'img.png' }], commits: [] },
      options: { dryRun: true },
      log: (msg) => logs.push(msg),
    });
    assert.ok(logs.some((msg) => /no reviewable files/i.test(msg)));
  });

  // Pins the production seam: without localDiff, the diff still comes from
  // listPrFiles (octokit.paginate), byte-identical to the pre-seam behavior.
  it('still sources the diff from GitHub when localDiff is absent', async () => {
    const sentinel = new Error('listPrFiles reached');
    const fake = {
      rest: { pulls: { listFiles: {} } },
      paginate: () => Promise.reject(sentinel),
    } as unknown as Octokit;
    await assert.rejects(
      runPrReview({ ...base, octokit: fake, options: { dryRun: true }, log: () => {} }),
      (error: unknown) => error === sentinel,
    );
  });
});

describe('emitReviewTelemetry sink', () => {
  const finding: Finding = { path: 'a.ts', line: 1, severity: 'P1', title: 't', body: 'b' };

  it('does nothing when telemetry is disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbot-tel-off-'));
    try {
      const logs: string[] = [];
      emitReviewTelemetry(createTelemetryRecorder(false), dir, (m) => logs.push(m));
      assert.equal(logs.length, 0, 'no log line when disabled');
      assert.throws(() => readFileSync(join(dir, '.jbot-review', 'telemetry.jsonl')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a JSONL file and logs a disposition summary when enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbot-tel-on-'));
    try {
      const rec = createTelemetryRecorder(true);
      const [f] = rec.produced('review', [finding]);
      for (const stage of ['gated', 'deduped', 'suppressed', 'verified', 'filtered'] as const) {
        rec.snapshot(stage, [f]);
      }
      rec.route({ inline: [f], fileLevel: [], orphaned: [], rescued: [] });

      const logs: string[] = [];
      emitReviewTelemetry(rec, dir, (m) => logs.push(m));

      assert.ok(logs.some((l) => /Telemetry: 1 finding\(s\).*posted-inline/.test(l)));
      const written = readFileSync(join(dir, '.jbot-review', 'telemetry.jsonl'), 'utf8');
      assert.match(written, /"disposition":"posted-inline"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails open (logs, does not throw) when the file cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbot-tel-bad-'));
    try {
      // Make a workspace path whose parent is a FILE, so mkdir hits ENOTDIR.
      writeFileSync(join(dir, 'blocker'), 'x');
      const rec = createTelemetryRecorder(true);
      rec.produced('review', [finding]);
      const logs: string[] = [];
      assert.doesNotThrow(() =>
        emitReviewTelemetry(rec, join(dir, 'blocker'), (m) => logs.push(m)),
      );
      assert.ok(logs.some((l) => /telemetry write skipped/.test(l)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('normalizeOptions defaults', () => {
  it('caps sessions at 3 by default and keeps explicit 0 as the unlimited escape hatch', () => {
    assert.equal(normalizeOptions(undefined).maxConcurrentSessions, 3);
    assert.equal(normalizeOptions({}).maxConcurrentSessions, 3);
    assert.equal(normalizeOptions({ maxConcurrentSessions: 0 }).maxConcurrentSessions, 0);
    assert.equal(normalizeOptions({ maxConcurrentSessions: 5 }).maxConcurrentSessions, 5);
  });

  it('defaults the measurement-loop flags on, with working opt-outs', () => {
    assert.equal(normalizeOptions(undefined).reviewTelemetry, true);
    assert.equal(normalizeOptions(undefined).evidenceQuotes, true);
    assert.equal(normalizeOptions({ reviewTelemetry: false }).reviewTelemetry, false);
    assert.equal(normalizeOptions({ evidenceQuotes: false }).evidenceQuotes, false);
  });
});
