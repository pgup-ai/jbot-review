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
      policy,
      sessions: ['review-interactions', 'guideline-compliance'],
      priorBodies: [withAuxiliaryBaselines('<sup>driver</sup>', [baseline])],
    };
    const decisions = await planAuxiliaryReuse(input);
    assert.equal(decisions[0].baseline?.head, reviewed);
    assert.equal(decisions[1].reason, 'no-completed-baseline');
    for (const [override, reason] of [
      [{ head: reviewed }, 'explicit-rerun'],
      [{ head: base }, 'history-unavailable'],
      [{ base: reviewed }, 'base-changed'],
      [{ policy: auxiliaryPolicy('new model') }, 'policy-changed'],
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
      [{ policy: auxiliaryPolicy('changed rules') }, 'policy-changed'],
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
