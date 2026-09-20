import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvidenceStore } from '../src/shared/evidence.ts';
import { parseAddedLines } from '../src/shared/patch.ts';
import assert from 'node:assert/strict';
import { Semaphore } from '../src/shared/opencode.ts';
import { test } from 'node:test';
import {
  buildShardPlans,
  addReviewEvidence,
  targetedDiff,
  measureReviewPrompt,
  reviewDelivery,
  reviewPromptBudget,
} from '../src/shared/review-plan.ts';
import { assembleReviewPrompt, UNTRUSTED_PR_CONTENT_NOTE } from '../src/shared/prompt.ts';
import { buildClinePromptArg, CLINE_MAX_ARGV_BYTES } from '../src/shared/cline.ts';
import { runShardedReview } from '../src/shared/runner.ts';
import { budgetReviewBackend } from '../src/shared/prompt-budget.ts';
import { boundedPromptContext, withNoToolsReviewDirective } from '../src/shared/prompt.ts';
import {
  limitReviewBackendSessions,
  type ReviewBackend,
} from '../src/shared/session-concurrency.ts';

const renderPrompt = (context: string) => assembleReviewPrompt(context, 'Repository rules.');
const budget = reviewPromptBudget('cline');
const base = {
  coreContext: `${UNTRUSTED_PR_CONTENT_NOTE}\n\nCORE`,
  context7Block: 'C7',
  renderPrompt,
  budget,
};

test('one requested shard pages a huge hunk without losing late changes or exceeding Cline argv', () => {
  const lines = Array.from({ length: 14000 }, (_, n) => `+const value${n} = '東京-${n}';`);
  const files = [{ filename: 'src/huge.ts', patch: `@@ -0,0 +1,14000 @@\n${lines.join('\n')}` }];
  const plans = buildShardPlans({ ...base, shards: [files] });
  assert.ok(plans.length > 4, 'page count must not be capped by the initial shard limit');
  assert.deepEqual(
    plans.flatMap((p) => p.units!.flatMap((u) => u.file.patch!.split('\n').slice(1))),
    lines,
  );
  assert.deepEqual(
    plans.flatMap((p) => p.units!.flatMap((u) => [...parseAddedLines(u.file.patch)])),
    Array.from({ length: 14000 }, (_, i) => i + 1),
  );
  for (const plan of plans) {
    assert.ok(
      Buffer.byteLength(buildClinePromptArg(renderPrompt(plan.context))) <= CLINE_MAX_ARGV_BYTES,
    );
    assert.ok(plan.context.startsWith(UNTRUSTED_PR_CONTENT_NOTE));
    assert.equal(plan.diffCoverage.omittedFiles + plan.diffCoverage.truncatedFiles, 0);
  }
  assert.equal(reviewDelivery(plans, new Set(plans.map((p) => p.label))).deliveredHunks, 1);
  assert.equal(
    reviewDelivery(plans, new Set(plans.slice(1).map((p) => p.label))).deliveredHunks,
    0,
  );
});

test('budgets instructions, guidelines, context and output separately from transport bytes', async () => {
  const tokenLimited = {
    ...budget,
    contextTokens: 100,
    outputTokens: 20,
    harnessTokens: 10,
    transportBytes: 1000,
  };
  assert.equal(measureReviewPrompt('a'.repeat(71), tokenLimited).fits, false);
  assert.equal(measureReviewPrompt('東'.repeat(23), tokenLimited).fits, true);
  assert.equal(
    measureReviewPrompt('a'.repeat(40), { ...tokenLimited, transportBytes: 39 }).fits,
    false,
  );
  assert.throws(
    () =>
      buildShardPlans({
        ...base,
        renderPrompt: (context) => assembleReviewPrompt(context, 'x'.repeat(130000)),
        shards: [[{ filename: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }]],
      }),
    /before any diff/,
  );
  assert.throws(
    () =>
      buildShardPlans({
        ...base,
        shards: [[{ filename: 'a.ts', patch: `@@ -1 +1 @@\n+${'x'.repeat(150000)}` }]],
      }),
    /one diff line/,
  );
  const plans = buildShardPlans({
    ...base,
    coreContext: 'old review context '.repeat(8000),
    shards: [[{ filename: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }]],
  });
  assert.match(plans[0].context, /PR metadata and prior-review context truncated/);
  assert.match(plans[0].context, /\+new/);
  assert.ok(measureReviewPrompt(renderPrompt(plans[0].context), budget).fits);
  assert.ok(Buffer.byteLength(boundedPromptContext('東京'.repeat(1000), 256, 'Source')) <= 256);
  assert.ok(Buffer.byteLength(withNoToolsReviewDirective('')) < budget.harnessTokens);

  let calls = 0;
  const backend = budgetReviewBackend(
    {
      name: 'test',
      runReview: async () => {
        calls++;
        return { summary: '', findings: [] };
      },
      runGuidelineComplianceCheck: async () => {
        calls++;
        return [];
      },
      runFindingVerification: async () => {
        calls++;
        return [];
      },
      runAddressedPriorCommentsCheck: async () => {
        calls++;
        return [];
      },
      runChangesSinceLastReview: async () => {
        calls++;
        return '';
      },
    } as ReviewBackend,
    budget,
  );
  const operations = [
    (context: string) => backend.runReview('test/model', context, '', () => {}),
    (context: string) => backend.runGuidelineComplianceCheck('test/model', context, '', () => {}),
    (context: string) => backend.runFindingVerification('test/model', context, [], () => {}),
    (context: string) => backend.runAddressedPriorCommentsCheck('test/model', context, () => {}),
    (context: string) => backend.runChangesSinceLastReview('test/model', context, () => {}),
  ];
  for (const operation of operations) {
    await operation('context');
    const before = calls;
    await assert.rejects(operation('x'.repeat(100000)), /assembled prompt/);
    assert.equal(calls, before);
  }
  assert.equal(calls, operations.length);
});

test('a trailing no-newline marker stays with its line when a large replacement splits', () => {
  const body = [`-${'a'.repeat(50000)}`, `+${'b'.repeat(50000)}`, '\\ No newline at end of file'];
  const plans = buildShardPlans({
    ...base,
    shards: [[{ filename: 'a.ts', patch: `@@ -1 +1 @@\n${body.join('\n')}` }]],
  });
  assert.equal(plans.length, 2);
  assert.match(plans[0].units![0].file.patch!, /^@@ -1,1 \+0,0 @@/);
  assert.match(plans[1].units![0].file.patch!, /^@@ -1,0 \+1,1 @@/);
  assert.match(targetedDiff(plans, [{ path: 'a.ts', line: 1, body: '' }]), /-aaaaa/);
  assert.deepEqual(
    plans.flatMap((p) => p.units!.flatMap((u) => u.file.patch!.split('\n').slice(1))),
    body,
  );
  for (const plan of plans) assert.ok(measureReviewPrompt(renderPrompt(plan.context), budget).fits);
});

test('all assigned hunks are embedded; batched reads are supporting cross-shard context only', () => {
  const shards = ['a', 'b'].map((name) => [
    {
      filename: `src/${name}.ts`,
      patch: `@@ -1 +1 @@\n-old${name}\n+new${name}\n@@ -10 +10 @@\n-oldTail${name}\n+newTail${name}`,
    },
  ]);
  const plans = buildShardPlans({
    ...base,
    shards,
    batchDiffScope: { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) },
  });
  assert.equal(plans.length, 2);
  for (const [i, plan] of plans.entries()) {
    assert.ok(plan.context.includes(shards[i][0].patch));
    assert.ok(plan.baseContext.includes(shards[i][0].patch));
    assert.ok(plan.context.includes(`'${shards[1 - i][0].filename}'`));
    assert.match(plan.context, /Shared change map/);
  }
  assert.equal(reviewDelivery(plans, new Set(plans.map((p) => p.label))).expectedHunks, 4);
});

test('single-page diff-first keeps the trust boundary before author-controlled content', () => {
  const shards = ['a.ts', 'b.ts'].map((filename) => [
    { filename, patch: '@@ -1 +1 @@\n-old\n+new' },
  ]);
  const plans = buildShardPlans({
    ...base,
    diffFirst: true,
    shards: shards.slice(0, 1),
  });
  assert.ok(plans[0].context.startsWith(UNTRUSTED_PR_CONTENT_NOTE));
  assert.equal(plans[0].context.split(UNTRUSTED_PR_CONTENT_NOTE).length, 2);
  assert.ok(plans[0].context.indexOf('## Diff hunks') < plans[0].context.indexOf('CORE'));
  const paged = buildShardPlans({ ...base, diffFirst: true, shards });
  assert.equal(
    paged[0].context.split('## Your assigned files')[0],
    paged[1].context.split('## Your assigned files')[0],
  );
  assert.ok(paged[0].context.indexOf('CORE') < paged[0].context.indexOf('## Diff hunks'));
});

test('queued pages respect session concurrency and a failed page cannot count as complete delivery', async () => {
  const shards = Array.from({ length: 6 }, (_, i) => [
    { filename: `a${i}.ts`, patch: '@@ -1 +1 @@\n-old\n+new' },
  ]);
  const plans = buildShardPlans({ ...base, shards });
  for (const failure of ['throw', 'partial']) {
    let active = 0,
      maximum = 0;
    const backend = limitReviewBackendSessions(
      {
        name: 'fake',
        async runReview(_model, _context, _guidelines, _log, options) {
          maximum = Math.max(maximum, ++active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          if (options?.label === 'review-shard-6') {
            if (failure === 'throw') throw new Error('context length exceeded');
            return { summary: '', findings: [], partial: true };
          }
          return { summary: '', findings: [] };
        },
      } as ReviewBackend,
      'main',
      new Semaphore(2),
    );
    const rows: Parameters<NonNullable<Parameters<typeof runShardedReview>[0]['onCoverage']>>[0][] =
      [];
    await assert.rejects(
      runShardedReview({
        backend,
        model: 'test/model',
        guidelinesForPrompt: '',
        shardPlans: plans,
        changedFiles: shards.flat().map((f) => f.filename),
        context7Active: false,
        context7ApiKey: '',
        log: () => {},
        onCoverage: (row) => rows.push(row),
      }),
      /refusing to post partial/,
    );
    assert.equal(maximum, 2);
    assert.deepEqual(rows.find((row) => row.delivery)?.delivery, {
      expectedHunks: 6,
      deliveredHunks: 5,
      expectedTasks: 6,
      completedTasks: 5,
      incompleteTasks: 1,
    });
  }
});

test('late diff pages receive actual unchanged caller code and verifier selection includes citations and file-level findings', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'review-page-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', workspace]);
  await writeFile(
    join(workspace, 'money.ts'),
    'export function total(n: number) {\nreturn n * 100;\n}\n',
  );
  await writeFile(
    join(workspace, 'consumer.ts'),
    "import { total as amount } from './money.js';\nexport const charge = amount(1) * 100;\n",
  );
  execFileSync('git', ['add', '.'], { cwd: workspace });
  const filler = Array.from({ length: 22 }, (_, i) => ({
    filename: `f${i}.ts`,
    patch: '@@ -1 +1 @@\n-a\n+b',
  }));
  const file = {
    filename: 'money.ts',
    patch: '@@ -1,3 +1,3 @@\n export function total(n: number) {\n-return n;\n+return n * 100;\n }',
  };
  const all = [...filler, file];
  const plans = buildShardPlans({ ...base, shards: [[file]], evidenceReserveBytes: 8192 });
  await addReviewEvidence(plans, new EvidenceStore(workspace, all), renderPrompt, budget, () => {});
  assert.match(plans[0].context, /charge = amount\(1\) \* 100/);
  assert.ok(measureReviewPrompt(renderPrompt(plans[0].context), budget).fits);
  const other = buildShardPlans({ ...base, shards: [filler] });
  assert.match(
    targetedDiff([...other, ...plans], [{ path: 'f0.ts', line: 1, body: 'See `money.ts:2`.' }]),
    /return n \* 100/,
  );
  assert.match(
    targetedDiff(plans, [{ path: 'money.ts', line: 0, body: 'file-level concern' }]),
    /return n \* 100/,
  );
});
