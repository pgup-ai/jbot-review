import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  EXPLORATION_LIMITS,
  ExplorationBudget,
  assertRecoverableCoverage,
  enforcesExplorationBudget,
  planExploration,
  selectExplorationTier,
  SOFT_FINISH_MIN_SESSIONS,
  softFinishThresholds,
} from '../src/shared/exploration-policy.ts';
import {
  createPiGitDiffTool,
  createPiReadTool,
  withPiExplorationBudget,
} from '../src/shared/pi.ts';

const plan = (over: Partial<Parameters<typeof planExploration>[0]> = {}) =>
  planExploration({ tier: 'standard', truncatedFiles: [], omittedFiles: [], ...over });

describe('planExploration', () => {
  it('enters recovery only when the prompt admits a gap', () => {
    assert.equal(plan().mode, 'embedded');
    assert.equal(plan({ truncatedFiles: ['a.ts'] }).mode, 'coverage-recovery');
    assert.equal(plan({ omittedFiles: ['b.ts'] }).mode, 'coverage-recovery');
    assert.equal(plan({ singleShot: true, omittedFiles: ['b.ts'] }).mode, 'single-shot');

    // Truncated and omitted overlap when a file is both; the gap list dedupes.
    assert.deepEqual(
      plan({ truncatedFiles: ['a.ts', 'b.ts'], omittedFiles: ['b.ts'] }).coverageGaps,
      ['a.ts', 'b.ts'],
    );
    // A single-shot session has no tools, so it can carry no gap to recover.
    assert.deepEqual(plan({ singleShot: true, omittedFiles: ['b.ts'] }).coverageGaps, []);
  });
});

describe('selectExplorationTier', () => {
  it('spends least on tests and most on risk or breadth', () => {
    const tier = (over: Partial<Parameters<typeof selectExplorationTier>[0]>) =>
      selectExplorationTier({ changedFiles: 3, touchesRiskyPath: false, testOnly: false, ...over });

    assert.equal(tier({}), 'standard');
    assert.equal(tier({ testOnly: true }), 'minimal');
    assert.equal(tier({ touchesRiskyPath: true }), 'elevated');
    assert.equal(tier({ changedFiles: 40 }), 'elevated');
    // A test-only change stays minimal however broad or risky it looks.
    assert.equal(tier({ testOnly: true, touchesRiskyPath: true, changedFiles: 40 }), 'minimal');
  });
});

describe('enforcesExplorationBudget', () => {
  it('is true only for a backend that can refuse a call', () => {
    assert.equal(enforcesExplorationBudget('enforceable'), true);
    // An observable backend reports tool use but cannot deny it, and an opaque
    // one reports nothing; neither may be described as enforcing a budget.
    assert.equal(enforcesExplorationBudget('observable'), false);
    assert.equal(enforcesExplorationBudget('opaque'), false);
    assert.equal(enforcesExplorationBudget(undefined), false);
  });
});

describe('assertRecoverableCoverage', () => {
  it('rejects a gap with no permitted recovery path', () => {
    assert.doesNotThrow(() => assertRecoverableCoverage(plan()));
    assert.doesNotThrow(() => assertRecoverableCoverage(plan({ omittedFiles: ['a.ts'] })));
    assert.throws(
      () =>
        assertRecoverableCoverage({ mode: 'embedded', tier: 'standard', coverageGaps: ['a.ts'] }),
      /coverage gap/,
    );
  });
});

describe('ExplorationBudget', () => {
  it('spends ordinary calls and soft-stops once the tier runs out', () => {
    // Searches, not reads: `minimal` allows fewer adjacent files than ordinary
    // calls, so reads would trip the adjacent limit first and test that instead.
    const budget = new ExplorationBudget(plan({ tier: 'minimal' }));
    for (let call = 0; call < EXPLORATION_LIMITS.minimal.ordinaryCalls; call += 1) {
      const request = { kind: 'search', query: `q${call}` } as const;
      assert.equal(budget.request(request).allow, true, `call ${call}`);
      budget.record(request, 10);
    }

    const stopped = budget.request({ kind: 'search', query: 'one-too-many' });
    assert.equal(stopped.allow, false);
    assert.equal(stopped.refusal, 'soft-stop');
    assert.match(stopped.message ?? '', /Answer now/);
    assert.equal(budget.exhausted, true);

    // The next call is a refusal, not a repeat of the warning.
    assert.equal(budget.request({ kind: 'search', query: 'later' }).refusal, 'budget-exhausted');
  });

  it('stops on output bytes even while calls remain', () => {
    const budget = new ExplorationBudget(plan({ tier: 'minimal' }));
    const first = { kind: 'read', path: 'huge.ts' } as const;
    assert.equal(budget.request(first).allow, true);
    budget.record(first, EXPLORATION_LIMITS.minimal.toolOutputBytes);

    assert.equal(budget.request({ kind: 'read', path: 'next.ts' }).refusal, 'soft-stop');
  });

  it('stops a repeat past the tier allowance, for a read or an equivalent search', () => {
    const minimal = new ExplorationBudget(plan({ tier: 'minimal' }));
    const same = { kind: 'read', path: 'a.ts' } as const;
    minimal.record(same, 10);
    // minimal allows no repeats at all.
    assert.equal(minimal.request(same).refusal, 'soft-stop');

    const searching = new ExplorationBudget(plan({ tier: 'minimal' }));
    const query = { kind: 'search', query: 'handleRequest' } as const;
    searching.record(query, 10);
    assert.equal(searching.request(query).refusal, 'soft-stop');

    const standard = new ExplorationBudget(plan({ tier: 'standard' }));
    standard.record(same, 10);
    assert.equal(standard.request(same).allow, true);
    standard.record(same, 10);
    assert.equal(standard.request(same).refusal, 'soft-stop');
  });

  it('stops once the adjacent-file allowance is spent, counting reads only', () => {
    const budget = new ExplorationBudget(plan({ tier: 'minimal' }));
    for (let file = 0; file < EXPLORATION_LIMITS.minimal.adjacentFiles; file += 1) {
      const request = { kind: 'read', path: `adj${file}.ts` } as const;
      assert.equal(budget.request(request).allow, true);
      budget.record(request, 10);
    }
    assert.equal(budget.request({ kind: 'read', path: 'one-more.ts' }).refusal, 'soft-stop');
  });

  it('exempts recovery of a named gap and leaves recovery once every gap is served', () => {
    const budget = new ExplorationBudget(
      plan({ tier: 'minimal', omittedFiles: ['gap-a.ts', 'gap-b.ts'] }),
    );
    assert.equal(budget.mode, 'coverage-recovery');

    // Recovering both gaps costs nothing, even at the smallest tier.
    for (const path of ['gap-a.ts', 'gap-b.ts']) {
      const request = { kind: 'diff', path } as const;
      const verdict = budget.request(request);
      assert.equal(verdict.allow, true);
      assert.equal(verdict.exempt, true, path);
      budget.record(request, 50_000);
    }

    assert.deepEqual(budget.pendingGaps, []);
    assert.equal(budget.mode, 'embedded');
    // The full ordinary allowance survives the recovery.
    const ordinary = { kind: 'read', path: 'after.ts' } as const;
    assert.equal(budget.request(ordinary).allow, true);
    assert.equal(budget.request(ordinary).exempt, false);
  });

  it('refuses recovery for a path the prompt never flagged', () => {
    const budget = new ExplorationBudget(plan({ omittedFiles: ['gap.ts'] }));
    const verdict = budget.request({ kind: 'diff', path: 'unrelated.ts' });

    assert.equal(verdict.allow, false);
    assert.equal(verdict.refusal, 'unrelated-recovery');
    assert.match(verdict.message ?? '', /gap\.ts/);
    // A refusal is not a soft stop: the session may still explore normally.
    assert.equal(budget.exhausted, false);
  });

  it('leaves a whole-diff request outside the recovery exemption', () => {
    const budget = new ExplorationBudget(plan({ omittedFiles: ['gap.ts'] }));
    const whole = { kind: 'diff' } as const;

    const verdict = budget.request(whole);
    assert.equal(verdict.allow, true);
    assert.equal(verdict.exempt, false, 'an unscoped diff is ordinary work, not recovery');
  });

  it('gives a single-shot session no tools at all', () => {
    const budget = new ExplorationBudget(plan({ singleShot: true }));
    const verdict = budget.request({ kind: 'read', path: 'a.ts' });

    assert.equal(verdict.allow, false);
    assert.equal(verdict.refusal, 'no-tools');
  });
});

describe('pi enforces the budget at its tool boundary', () => {
  const sdk = { defineTool: (definition: unknown) => definition } as never;
  type Tool = {
    execute: (id: unknown, params: unknown) => Promise<{ content: { text: string }[] }>;
  };
  const textOf = async (tool: unknown, params: unknown) =>
    (await (tool as Tool).execute('id', params)).content[0].text;

  const workspace = mkdtempSync(join(tmpdir(), 'jbot-budget-'));
  writeFileSync(join(workspace, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(workspace, 'b.ts'), 'export const b = 2;\n');

  it('refuses a read once the budget is spent, and says so again after', async () => {
    const read = createPiReadTool(sdk, workspace);
    const budget = new ExplorationBudget(
      planExploration({ tier: 'minimal', truncatedFiles: [], omittedFiles: [] }),
    );

    await withPiExplorationBudget(budget, async () => {
      for (let file = 0; file < EXPLORATION_LIMITS.minimal.adjacentFiles; file += 1) {
        writeFileSync(join(workspace, `f${file}.ts`), 'x\n');
        assert.doesNotMatch(await textOf(read, { path: `f${file}.ts` }), /budget/i);
      }
      assert.match(await textOf(read, { path: 'a.ts' }), /Answer now/);
      assert.match(await textOf(read, { path: 'b.ts' }), /refused/i);
    });
  });

  it('keeps a path outside the repo a permission denial, not a budget refusal', async () => {
    const read = createPiReadTool(sdk, workspace);
    const budget = new ExplorationBudget(
      planExploration({ tier: 'minimal', truncatedFiles: [], omittedFiles: [] }),
    );

    await withPiExplorationBudget(budget, async () => {
      assert.match(await textOf(read, { path: '../outside.ts' }), /outside the repository/);
      // The refusal spent nothing, so ordinary exploration still works.
      assert.doesNotMatch(await textOf(read, { path: 'a.ts' }), /budget|Answer now/i);
    });
  });

  it('lets a named coverage gap through git_diff without spending budget', async () => {
    const diff = createPiGitDiffTool(sdk, workspace, { base: 'HEAD', worktree: true });
    const budget = new ExplorationBudget(
      planExploration({ tier: 'minimal', truncatedFiles: ['a.ts'], omittedFiles: [] }),
    );

    await withPiExplorationBudget(budget, async () => {
      // Not a git repo here, so the diff fails — the point is that the budget
      // permitted the call rather than refusing it.
      assert.doesNotMatch(await textOf(diff, { path: 'a.ts' }), /budget|Answer now/i);
      assert.match(await textOf(diff, { path: 'unrelated.ts' }), /limited to the omitted/);
    });
  });
});

describe('softFinishThresholds', () => {
  const samples = (backend: string, tier: 'minimal' | 'standard', turns: number[]) =>
    turns.map((usefulTurns) => ({ backend, tier, usefulTurns }));

  it('sets a threshold only for a cohort with enough sessions', () => {
    const enough = samples(
      'pi',
      'standard',
      Array.from({ length: SOFT_FINISH_MIN_SESSIONS }, (_, index) => (index % 10) + 1),
    );
    const thin = samples('opencode', 'standard', [4, 5, 6]);

    const thresholds = softFinishThresholds([...enough, ...thin]);

    assert.equal(thresholds.has('opencode:standard'), false, 'a thin cohort gets no threshold');
    const pi = thresholds.get('pi:standard');
    assert.equal(pi?.sessions, SOFT_FINISH_MIN_SESSIONS);
    assert.ok(pi !== undefined && pi.p90 <= pi.p99);
  });

  it('separates cohorts by backend and tier', () => {
    const thresholds = softFinishThresholds([
      ...samples(
        'pi',
        'standard',
        Array.from({ length: 30 }, () => 2),
      ),
      ...samples(
        'pi',
        'minimal',
        Array.from({ length: 30 }, () => 9),
      ),
    ]);

    assert.equal(thresholds.get('pi:standard')?.p90, 2);
    assert.equal(thresholds.get('pi:minimal')?.p90, 9);
  });
});
