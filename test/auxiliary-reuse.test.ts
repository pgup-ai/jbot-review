import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  auxiliaryBaselines,
  auxiliaryPolicy,
  isRoutineDocumentation,
  planAuxiliaryReuse,
  planComplianceRecheck,
  withAuxiliaryBaselines,
} from '../src/shared/auxiliary-reuse.ts';

test('reuse accepts only driver completion metadata, never a marker inside a model summary', () => {
  const row = {
    session: 'review-interactions',
    base: 'a'.repeat(40),
    head: 'b'.repeat(40),
    policy: auxiliaryPolicy('model and rules'),
  };
  const body = withAuxiliaryBaselines('<sup>Reviewed with model</sup>', [row]);
  assert.deepEqual(auxiliaryBaselines(body), [row]);
  assert.deepEqual(auxiliaryBaselines(`${body}\n<sup>Actual driver footer</sup>`), []);
  assert.deepEqual(auxiliaryBaselines('<sup>x</sup>\n<!-- jbot-review:auxiliary:[{}] -->'), []);
  assert.deepEqual(auxiliaryBaselines('<sup>x</sup>\n<!-- jbot-review:auxiliary:[broken] -->'), []);
  assert.notEqual(row.policy, auxiliaryPolicy('changed rules'));
  for (const path of [
    'src/config.ts',
    'AGENTS.md',
    'docs/api.md',
    'docs/contracts.md',
    'docs/audits/result.json',
    'ui/component.mdx',
    '.github/workflows/ci.yml',
  ])
    assert.equal(isRoutineDocumentation([path]), false, path);
});

test('documentation reuse requires a successful ancestor with matching base and policy for each pass', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-aux-reuse-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'fixture',
    );
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q');
    writeFileSync(join(workspace, 'worker.ts'), 'export const capacity = 100;\n');
    const base = commit();
    writeFileSync(join(workspace, 'worker.ts'), 'export const capacity = 10;\n');
    const reviewed = commit();
    writeFileSync(join(workspace, 'README.md'), 'Documentation follow-up\n');
    const head = commit();
    const policy = auxiliaryPolicy('same model and rules');
    const baseline = { session: 'review-interactions', base, head: reviewed, policy };
    const input = {
      workspace,
      base,
      head,
      policyFor: () => policy,
      sessions: ['review-interactions', 'guideline-compliance'],
      priorBodies: [withAuxiliaryBaselines('<sup>driver</sup>', [baseline])],
      rulesChangedSince: async () => false,
    };
    const decisions = await planAuxiliaryReuse(input);
    assert.equal(decisions[0].baseline?.head, reviewed);
    assert.equal(decisions[1].reason, 'no-completed-baseline');
    for (const [override, reason] of [
      [{ head: reviewed }, 'explicit-rerun'],
      [{ head: base }, 'history-unavailable'],
      [{ base: reviewed }, 'base-changed'],
      [{ policyFor: () => auxiliaryPolicy('new model') }, 'policy-changed'],
      [{ rulesChangedSince: async () => true }, 'guidelines-changed'],
      [{ priorBodies: ['reviewed head, but incomplete auxiliaries'] }, 'no-completed-baseline'],
      [
        { priorBodies: [...input.priorBodies, '<sup>Newer incomplete run</sup>'] },
        'no-completed-baseline',
      ],
      [{ reviewedHead: head }, 'explicit-rerun'],
    ] as const) {
      const result = await planAuxiliaryReuse({ ...input, ...override });
      assert.equal(result[0].reason, reason);
      assert.equal(result[0].baseline, undefined);
    }
    const guideline = { ...baseline, session: 'guideline-compliance' };
    const followup = {
      ...input,
      sessions: ['guideline-compliance'],
      priorBodies: [withAuxiliaryBaselines('<sup>driver</sup>', [guideline])],
      guidelineFollowup: { baseline: reviewed, coveredByMain: true },
    };
    assert.equal((await planAuxiliaryReuse(followup))[0].reason, 'global-guidelines-in-main');
    assert.equal((await planAuxiliaryReuse(followup))[0].baseline?.head, reviewed);
    for (const [override, reason] of [
      [{ guidelineFollowup: { baseline: reviewed, coveredByMain: false } }, 'relevant-guidelines'],
      [
        { guidelineFollowup: { baseline: head, coveredByMain: true } },
        'guideline-baseline-mismatch',
      ],
      [{ policyFor: () => auxiliaryPolicy('changed rules') }, 'policy-changed'],
      [{ priorBodies: ['incomplete prior guideline review'] }, 'no-completed-baseline'],
    ] as const) {
      const [decision] = await planAuxiliaryReuse({ ...followup, ...override });
      assert.equal(decision.reason, reason);
      assert.equal(decision.baseline, undefined);
    }
    writeFileSync(join(workspace, 'worker.ts'), 'export const capacity = 1;\n');
    commit();
    writeFileSync(join(workspace, 'README.md'), 'Another documentation-only commit\n');
    assert.equal(
      (await planAuxiliaryReuse({ ...input, head: commit() }))[0].reason,
      'relevant-changes',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a follow-up re-checks compliance only on files whose edits differ from the audited diff', async () => {
  const [reviewed, base] = ['a'.repeat(40), 'b'.repeat(40)];
  const policy = auxiliaryPolicy('compliance prompt and rules');
  const row = { session: 'guideline-compliance', head: reviewed, base, policy };
  const auditedFiles = [
    { filename: 'a.ts', patch: '@@ -1,3 +1,3 @@\n ctx\n-x\n+y' },
    { filename: 'b.ts', patch: '@@ -1 +1 @@\n-p\n+q' },
    { filename: 'img.png' },
  ];
  const input = {
    priorBody: withAuxiliaryBaselines('<sup>driver</sup>', [row]),
    policy,
    head: 'c'.repeat(40),
    files: [
      // Merging the base moved the hunk and changed its context; the edit is the same.
      { filename: 'a.ts', patch: '@@ -9,3 +9,3 @@\n other\n-x\n+y' },
      { filename: 'b.ts', patch: '@@ -1 +1 @@\n-p\n+r' },
      { filename: 'c.ts', patch: '@@ -0,0 +1 @@\n+new' },
      { filename: 'img.png' },
    ],
    // The pass's own base...head, whatever the PR's base is today.
    audited: async (...range: string[]) =>
      range.join() === `${base},${reviewed}` ? auditedFiles : [],
    rulesChangedSince: async () => false,
  };
  assert.deepEqual(await planComplianceRecheck(input), {
    reason: 'edits-since-review',
    baseline: row,
    files: ['b.ts', 'c.ts', 'img.png'],
  });
  assert.deepEqual(await planComplianceRecheck({ ...input, files: auditedFiles.slice(0, 2) }), {
    reason: 'no-edits-since-review',
    baseline: row,
    files: [],
  });
  for (const [override, reason] of [
    [{ priorBody: '<sup>driver</sup>' }, 'no-completed-baseline'],
    [{ policy: auxiliaryPolicy('changed rules') }, 'policy-changed'],
    [{ head: reviewed }, 'same-head-rerun'],
    [{ rulesChangedSince: async () => true }, 'guidelines-changed'],
    [{ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts` })) }, 'large-pr'],
    [{ audited: () => Promise.reject(new Error('compare capped')) }, 'history-unavailable'],
    [{ files: [{ filename: 'b.ts', patch: '@@ -1 +1 @@\n-p\n+r' }] }, 'every-file-changed'],
  ] as const) {
    const plan = await planComplianceRecheck({ ...input, ...override });
    assert.equal(plan.reason, reason);
    assert.equal(plan.files, undefined);
  }
});
