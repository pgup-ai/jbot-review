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
  addContextPack,
  buildShardPlans,
  buildAuxiliaryPlans,
  prioritizeAuxiliaryPlans,
  addReviewEvidence,
  targetedDiff,
  measureReviewPrompt,
  reviewDelivery,
  reviewPromptBudget,
} from '../src/shared/review-plan.ts';
import {
  assembleReviewPrompt,
  assembleGuidelineCompliancePrompt,
  GUIDELINE_REVIEW_LENS,
  REVIEW_LENSES,
  UNTRUSTED_PR_CONTENT_NOTE,
} from '../src/shared/prompt.ts';
import {
  buildClinePromptArg,
  CLINE_MAX_ARGV_BYTES,
  CLINE_MODEL_LIMITS,
} from '../src/shared/cline.ts';
import { COMMANDCODE_MODEL_LIMITS } from '../src/shared/commandcode.ts';
import { runShardedReview } from '../src/shared/runner.ts';
import { budgetReviewBackend } from '../src/shared/prompt-budget.ts';
import {
  boundedPromptContext,
  withNoToolsReviewDirective,
  compactReviewPageContext,
} from '../src/shared/prompt.ts';
import { catalogModelLimits } from '../src/shared/pi.ts';
import { formatGuidelines } from '../src/shared/review-context.ts';
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
  const verification = targetedDiff(plans, [{ path: 'src/huge.ts', line: 0, body: '' }]);
  assert.ok(Buffer.byteLength(verification) <= 36 * 1024 + 2);
  assert.match(verification, /Hunks truncated for src\/huge.ts/);
});

test('uses known free-model capacity for fewer complete pages and ranks auxiliary risk', () => {
  const files = [
    {
      filename: 'docs/notes.md',
      patch: '@@ -0,0 +1,4000 @@\n' + '+docs text content\n'.repeat(4000),
    },
    { filename: 'src/api/orders.ts', patch: '@@ -1 +1 @@\n-old()\n+new()' },
  ];
  const small = buildShardPlans({ ...base, shards: [files] });
  const larger = reviewPromptBudget(
    'cline',
    CLINE_MODEL_LIMITS['cline-free/muse-spark-1.3-contributor'],
  );
  const plans = buildShardPlans({ ...base, budget: larger, shards: [files] });
  for (const limits of Object.values(CLINE_MODEL_LIMITS))
    assert.ok(
      plans.every(
        (plan) =>
          measureReviewPrompt(renderPrompt(plan.context), reviewPromptBudget('cline', limits)).fits,
      ),
    );
  assert.ok(plans.length < small.length);
  for (const plan of plans)
    assert.ok(
      Buffer.byteLength(buildClinePromptArg(renderPrompt(plan.context))) <= CLINE_MAX_ARGV_BYTES,
    );
  assert.equal(reviewDelivery(plans, new Set(plans.map((p) => p.label))).deliveredHunks, 2);
  const commandCodeFallback = buildShardPlans({
    ...base,
    budget: reviewPromptBudget('commandcode'),
    shards: [files],
  });
  for (const limits of Object.values(COMMANDCODE_MODEL_LIMITS)) {
    const nativeBudget = reviewPromptBudget('commandcode', limits);
    const nativePlans = buildShardPlans({ ...base, budget: nativeBudget, shards: [files] });
    assert.ok(nativePlans.length < commandCodeFallback.length);
    assert.ok(
      nativePlans.every(
        (plan) => measureReviewPrompt(renderPrompt(plan.context), nativeBudget).fits,
      ),
    );
    assert.equal(
      reviewDelivery(nativePlans, new Set(nativePlans.map((p) => p.label))).deliveredHunks,
      2,
    );
  }
  const ranked = prioritizeAuxiliaryPlans(small);
  assert.ok(ranked[0].assignedFiles.includes('src/api/orders.ts'));
  assert.deepEqual(new Set(ranked), new Set(small));
});

test('budgets instructions, guidelines, context and output separately from transport bytes', async () => {
  const limits = await catalogModelLimits('opencode', 'kimi-k2.7-code', true);
  assert.ok(limits);
  assert.equal(limits.contextTokens, limits.outputTokens);
  assert.ok(measureReviewPrompt(renderPrompt(''), reviewPromptBudget('pi', limits)).fits);
  assert.equal(await catalogModelLimits('openai', 'jbot-nonexistent-model', true), undefined);
  assert.ok(
    measureReviewPrompt(
      'x'.repeat(150000),
      reviewPromptBudget('opencode', { contextTokens: 256000 }),
    ).fits,
  );
  assert.equal(
    measureReviewPrompt('x'.repeat(150000), reviewPromptBudget('cline', { contextTokens: 256000 }))
      .fits,
    false,
  );
  assert.equal(measureReviewPrompt('x'.repeat(150000), reviewPromptBudget('opencode')).fits, false);
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
  const compact = compactReviewPageContext(
    'old comments '.repeat(5000),
    'PR intent and linked issue contract',
    'summary scope',
    'review focus',
    'Ranked caller evidence',
  );
  assert.equal(compactReviewPageContext('small context', 'scope', '', '', ''), 'small context');
  const largeContext = 'context '.repeat(3000);
  assert.equal(compactReviewPageContext(largeContext, largeContext, '', '', ''), largeContext);
  assert.ok(compact.startsWith(UNTRUSTED_PR_CONTENT_NOTE));
  assert.match(compact, /PR intent and linked issue contract/);
  assert.match(compact, /Ranked caller evidence/);
  assert.match(compact, /prior review comments are omitted/);
  const paged = buildShardPlans({
    ...base,
    coreContext: compact,
    shards: [[{ filename: 'a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }]],
  });
  assert.match(paged[0].context, /\+new/);
  assert.equal(reviewDelivery(paged, new Set(paged.map((p) => p.label))).deliveredHunks, 1);

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
  for (const context of [plans[0].context, plans[0].baseContext]) {
    assert.ok(context.startsWith(UNTRUSTED_PR_CONTENT_NOTE));
    assert.equal(context.split(UNTRUSTED_PR_CONTENT_NOTE).length, 2);
    assert.ok(context.indexOf('## Diff hunks') < context.indexOf('CORE'));
  }
  const paged = buildShardPlans({ ...base, diffFirst: true, shards });
  assert.equal(
    paged[0].context.split('## Your assigned files')[0],
    paged[1].context.split('## Your assigned files')[0],
  );
  const prefix = paged[0].context.split('## Your assigned files')[0];
  assert.ok(prefix.includes('CORE') && prefix.includes('C7'));
  assert.ok(paged[0].context.indexOf('CORE') < paged[0].context.indexOf('## Diff hunks'));
  assert.doesNotMatch(prefix, /reviewer [12]\b/);
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

test('large auxiliary guidelines preserve every rule and hunk within the assembled budget', () => {
  const labels = ['.cursorrules', '.windsurfrules', '.coderabbit.yaml', 'greptile.json'];
  const docs = Array.from({ length: 32 }, (_, i) => ({
    label: i < labels.length ? labels[i] : `rule-${i}.md`,
    text: `### Internal section\n${'東京 rule. '.repeat(240)}`,
    relevance: 1 as const,
  }));
  const guidelineLabels = docs.map((doc) => doc.label);
  const guidelines = formatGuidelines({ docs, referenced: [], budgetExhausted: false });
  const files = Array.from({ length: 7 }, (_, i) => ({
    filename: `src/file-${i}.ts`,
    patch: '@@ -1 +1 @@\n-old()\n+new()',
  }));
  for (const renderPrompt of [
    (context: string, rules: string) =>
      assembleReviewPrompt(
        context,
        rules,
        `${REVIEW_LENSES.interactions}\n${GUIDELINE_REVIEW_LENS}`,
      ),
    assembleGuidelineCompliancePrompt,
  ]) {
    assert.throws(
      () =>
        buildShardPlans({
          ...base,
          shards: [files],
          renderPrompt: (context) => renderPrompt(context, guidelines),
        }),
      /before any diff/,
    );
    const plans = buildAuxiliaryPlans({
      ...base,
      shards: [files],
      guidelines,
      guidelineLabels,
      renderPrompt,
      evidenceReserveBytes: 8192,
    });
    assert.ok(plans.length > 1);
    assert.equal(plans.map((plan) => plan.guidelines).join(''), guidelines);
    assert.equal(new Set(plans.map((plan) => plan.label)).size, plans.length);
    for (const plan of plans) {
      assert.ok(
        guidelineLabels.some(
          (label) =>
            plan.guidelines!.startsWith(`### ${label}\n`) ||
            plan.guidelines!.startsWith(`### ${label} [part `),
        ),
      );
      assert.equal(plan.units!.length, 7);
      assert.ok(
        measureReviewPrompt(renderPrompt(plan.context, plan.guidelines!), budget, 8192).fits,
      );
      assert.equal(plan.diffCoverage.omittedFiles + plan.diffCoverage.truncatedFiles, 0);
    }
    const rootRules = formatGuidelines({
      docs: labels.map((label) => ({
        label,
        text: 'Preserve the public contract.\n'.repeat(1000),
        relevance: 1,
      })),
      referenced: [],
      budgetExhausted: false,
    });
    const rootPlans = buildAuxiliaryPlans({
      ...base,
      shards: [files],
      guidelines: rootRules,
      guidelineLabels: labels,
      renderPrompt,
    });
    assert.ok(rootPlans.length > 1);
    assert.equal(rootPlans.map((plan) => plan.guidelines).join(''), rootRules);
    const small = buildAuxiliaryPlans({
      ...base,
      shards: [files],
      guidelineLabels,
      guidelines: 'Global rules',
      renderPrompt,
    });
    assert.equal(small.length, 1);
    assert.equal(small[0].guidelines, 'Global rules');
    assert.throws(
      () =>
        buildAuxiliaryPlans({
          ...base,
          shards: [files],
          guidelineLabels,
          guidelines: 'x'.repeat(130000),
          renderPrompt,
        }),
      /before any diff/,
    );
  }
});

test('auxiliary planning frees guideline space for a long changed line without dropping it', () => {
  const guidelines = `### a.md\n${'rule '.repeat(4000)}\n\n### b.md\n${'rule '.repeat(4000)}`;
  const patch = `@@ -0,0 +1 @@\n+${'x'.repeat(30000)}`;
  const shards = [[{ filename: 'src/long.ts', patch }]];
  const renderPrompt = (context: string, rules: string) => assembleReviewPrompt(context, rules);
  assert.throws(
    () =>
      buildShardPlans({
        ...base,
        shards,
        evidenceReserveBytes: 8192,
        renderPrompt: (context) => renderPrompt(context, guidelines),
      }),
    /one diff line/,
  );
  const options = {
    ...base,
    shards,
    guidelines,
    guidelineLabels: ['a.md', 'b.md'],
    renderPrompt,
    evidenceReserveBytes: 8192,
  };
  const plans = buildAuxiliaryPlans(options);
  assert.equal(plans.length, 2);
  assert.equal(plans.map((plan) => plan.guidelines).join(''), guidelines);
  for (const plan of plans) {
    assert.equal(plan.units![0].file.patch, patch);
    assert.ok(measureReviewPrompt(renderPrompt(plan.context, plan.guidelines!), budget, 8192).fits);
  }
  assert.throws(
    () =>
      buildAuxiliaryPlans({
        ...options,
        shards: [[{ filename: 'src/long.ts', patch: `@@ -0,0 +1 @@\n+${'x'.repeat(200000)}` }]],
      }),
    /one diff line/,
  );
});

test('the context pack sits before the page diff, and pages it cannot serve fall back', async () => {
  const budget = reviewPromptBudget('opencode', { contextTokens: 200_000 });
  const renderPrompt = (context: string, contextPack = false) =>
    assembleReviewPrompt(context, '', '', false, true, { contextPack });
  const file = {
    filename: 'money.ts',
    patch:
      '@@ -1,3 +1,3 @@\n export function total(n: number) {\n-  return n;\n+  return n * 100;\n }',
  };
  const page = () =>
    buildShardPlans({
      coreContext: '## Pull request\nTitle: money',
      context7Block: '',
      shards: [[file]],
      renderPrompt: (context) => renderPrompt(context),
      budget,
      evidenceReserveBytes: 8192,
    })[0];
  const pack = {
    text: '## Context pack\nPACKED',
    supplied: {
      ranges: new Map(),
      lines: new Map(),
      symbols: new Set<string>(),
      directories: new Set<string>(),
    },
    state: 'complete' as const,
    omitted: 0,
    slices: {},
  };
  const plans = [page(), page(), page(), page()];
  const before = { context: plans[3].context, baseContext: plans[3].baseContext };
  const fallbacks: typeof plans = [];
  const results = await addContextPack({
    plans,
    build: async (plan) => {
      if (plan === plans[1]) return { ...pack, text: '' };
      if (plan === plans[2]) throw new Error('boom');
      if (plan === plans[3]) return { ...pack, text: '## Context pack\n' + 'x'.repeat(300_000) };
      return pack;
    },
    fallback: async (plan) => {
      fallbacks.push(plan);
    },
    renderPrompt,
    budget,
    log: () => {},
  });
  assert.deepEqual(
    results.map((result) => [result.state, result.reason]),
    [
      ['complete', undefined],
      ['fallback', 'empty'],
      ['fallback', 'error'],
      ['fallback', 'overflow'],
    ],
  );
  assert.match(plans[0].context, /PACKED\n\n## Diff hunks/);
  assert.ok(plans[0].baseContext.includes('PACKED'));
  assert.ok(!plans[1].context.includes('PACKED'));
  assert.deepEqual({ context: plans[3].context, baseContext: plans[3].baseContext }, before);
  assert.deepEqual(
    plans.map((plan) => plan.contextPack),
    [true, undefined, undefined, undefined],
  );
  assert.equal(fallbacks.length, 3);
  assert.ok(fallbacks.includes(plans[3]));
});
