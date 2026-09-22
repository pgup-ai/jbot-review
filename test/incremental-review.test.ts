import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withReviewCoverage, completedReviewHead, type PrFile } from '../src/shared/github.ts';
import {
  impactedReviewFiles,
  planIncrementalReview,
  reviewBaseline,
  withReviewBaseline,
} from '../src/shared/incremental-review.ts';
import { buildIncrementalReviewContext } from '../src/shared/prompt.ts';

const policy = 'c'.repeat(64);
const body = (head: string, base: string) =>
  withReviewCoverage(withReviewBaseline('<sup>driver</sup>', { head, base, policy }), head, true);

test('incremental baselines require driver metadata and completed coverage', () => {
  const head = 'a'.repeat(40),
    base = 'b'.repeat(40);
  assert.deepEqual(reviewBaseline(body(head, base)), { head, base, policy });
  const incremental = withReviewCoverage(
    withReviewBaseline('<sup>driver</sup>', { head, base, policy }),
    head,
    true,
    'incremental',
  );
  assert.deepEqual(reviewBaseline(incremental), { head, base, policy });
  assert.equal(completedReviewHead(incremental), undefined);
  assert.equal(completedReviewHead(incremental, 'incremental'), head);

  for (const invalid of [
    body(head, base).replace('completed-head:', 'incomplete-head:'),
    body(head, base).replace(`"head":"${head}"`, `"head":"${base}"`),
    body(head, base) + '\n<sup>actual footer</sup>',
    '<sup>driver</sup>\n<!-- jbot-review:baseline:{broken} -->\n',
  ])
    assert.equal(reviewBaseline(invalid), undefined);
});

test('impact expansion includes aliased callers and callees from earlier PR files', () => {
  const sources = new Map([
    [
      'worker/job.ts',
      ['export function run() { return cap(); }\nimport { limit as cap } from "../core/limit";'],
    ],
    [
      'core/limit.ts',
      ['export function limit() { return 5; }', 'export function limit() { return 0; }'],
    ],
    ['other/unrelated.ts', ['export function label() { return "ready"; }']],
  ]);
  const files = [...sources.keys()].map((filename) => ({ filename, patch: '@@ -1 +1 @@\n-a\n+b' }));
  for (const changed of ['core/limit.ts', 'worker/job.ts']) {
    const selected = impactedReviewFiles(files, [changed], sources);
    assert.deepEqual(
      selected.map((file) => file.filename),
      ['worker/job.ts', 'core/limit.ts'],
    );
    assert.equal(selected[0].patch, files[0].patch);
  }
  const context = buildIncrementalReviewContext(
    {
      mode: 'incremental',
      reason: 'bounded-followup',
      files: files.slice(0, 2),
      baseline: 'a'.repeat(40),
    },
    files,
  );
  assert.match(context, /other\/unrelated.ts/);
  assert.match(context, /ALL their base-to-head hunks/);
});

test('incremental planning uses a successful ancestor and falls back on uncertain follow-ups', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-incremental-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(join(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), text);
  };
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
    write('core/limit.ts', 'export function limit() {\n  return 5;\n}\n');
    write(
      'worker/job.ts',
      'import { limit as cap } from "../core/limit";\nexport function job() { return cap(); }\n',
    );
    write('other/label.ts', 'export function label() { return "ready"; }\n');
    const base = commit();
    write('other/label.ts', 'export function label() { return "active"; }\n');
    const reviewed = commit();
    write('core/limit.ts', 'export function limit() {\n  return 0;\n}\n');
    const head = commit();
    const files: PrFile[] = ['core/limit.ts', 'worker/job.ts', 'other/label.ts'].map(
      (filename) => ({ filename, patch: '@@ -1 +1 @@\n-a\n+b' }),
    );
    const input = {
      workspace,
      files,
      head,
      base,
      policy,
      priorBody: body(reviewed, base),
    };
    const result = await planIncrementalReview(input);
    assert.equal(result.mode, 'incremental');
    assert.deepEqual(
      result.files.map((file) => file.filename),
      ['core/limit.ts', 'worker/job.ts'],
    );
    for (const [overrides, reason] of [
      [{ forceFull: true }, 'explicit-or-incomplete-review'],
      [{ priorBody: '' }, 'no-completed-baseline'],
      [{ base: head }, 'base-changed'],
      [{ policy: 'd'.repeat(64) }, 'policy-changed'],
      [{ head: reviewed }, 'same-head-rerun'],
      [{ head: base }, 'history-or-impact-unavailable'],
      [
        { files: [...files, { filename: 'config.json', patch: 'patch' }] },
        'unsupported-or-large-pr',
      ],
    ] as const) {
      const plan = await planIncrementalReview({ ...input, ...overrides });
      assert.equal(plan.mode, 'full', reason);
      assert.equal(plan.reason, reason);
      assert.deepEqual(plan.files, overrides.files ?? files);
    }
    write(
      'unchanged/wrapper.ts',
      'import { limit } from "../core/limit";\nexport const wrapper = () => limit();\n',
    );
    const outsideHead = commit();
    write('core/limit.ts', 'export function limit() {\n  return 1;\n}\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBody: body(outsideHead, base),
        })
      ).reason,
      'references-outside-pr',
    );
    git('checkout', '-q', '--detach', head);
    write('core/limit.ts', 'export function limit() {\n  return 10;\n}\n');
    assert.equal(
      (await planIncrementalReview({ ...input, worktree: true })).reason,
      'uncommitted-changes',
    );
    write('core/limit.ts', 'export const limit = () => 10;\n');
    assert.equal(
      (await planIncrementalReview({ ...input, head: commit() })).reason,
      'broad-or-contract-change',
    );
    write('core/new.ts', 'export const value = 1;\n');
    assert.equal(
      (await planIncrementalReview({ ...input, head: commit() })).reason,
      'added-removed-or-renamed-file',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
