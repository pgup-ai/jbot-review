import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  withReviewCoverage,
  completedReviewHead,
  compactJbotReviewBody,
  type PrFile,
} from '../src/shared/github.ts';
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
  const compacted = compactJbotReviewBody(incremental, 1);
  assert.deepEqual(reviewBaseline(compacted), { head, base, policy });
  assert.equal(completedReviewHead(compacted), undefined);
  assert.equal(compactJbotReviewBody(compacted, 1), compacted);

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
  const longPaths = Array.from({ length: 40 }, (_, i) => ({
    filename: `${i}/${'界'.repeat(70)}.ts`,
  }));
  const bounded = buildIncrementalReviewContext(
    { mode: 'incremental', reason: 'bounded-followup', files: [] },
    longPaths,
  );
  assert.doesNotMatch(bounded, /\uFFFD/);
  const listed = bounded
    .split('Previously reviewed PR files outside this follow-up:\n')[1]
    .split('\n[')[0];
  assert.ok(Buffer.byteLength(listed) <= 8192);
  assert.ok(listed.split('\n').every((path) => longPaths.some((file) => file.filename === path)));
  assert.match(bounded, /Remaining file names omitted/);
  for (const declaration of ['interface Contract', 'type Contract =']) {
    const types = new Map([
      [
        'core/shape.ts',
        [
          `export ${declaration} {\n value: string;\n}`,
          `export ${declaration} {\n value: number;\n}`,
        ],
      ],
      [
        'worker/job.ts',
        [
          'import { Contract as Input } from "@shapes";\nexport function run(value: Input) { return value.value; }',
        ],
      ],
      ['other/unrelated.ts', ['export const unrelated = 0;']],
    ]);
    const typeFiles = [...types.keys()].map((filename) => ({
      filename,
      patch: '@@ -2 +2 @@\n- value: string;\n+ value: number;',
    }));
    assert.deepEqual(
      impactedReviewFiles(typeFiles, ['core/shape.ts'], types).map((file) => file.filename),
      ['core/shape.ts', 'worker/job.ts'],
    );
  }
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
      // A later review that set no baseline does not hide the completed one before it.
      priorBodies: [body(reviewed, base), 'A later review with an unverified finding.'],
    };
    const result = await planIncrementalReview(input);
    assert.equal(result.mode, 'incremental');
    assert.deepEqual(
      result.files.map((file) => file.filename),
      ['core/limit.ts', 'worker/job.ts'],
    );
    for (const [overrides, reason] of [
      [{ forceFull: true }, 'explicit-or-incomplete-review'],
      [{ priorBodies: [] }, 'no-completed-baseline'],
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
          priorBodies: [body(outsideHead, base)],
        })
      ).reason,
      'references-outside-pr',
    );
    for (const target of [
      'core/store.mjs',
      'core/store.cjs',
      'pkg/index.mjs',
      'pkg/index.mts',
      'pkg/index.cts',
      'pkg/index.jsx',
    ]) {
      git('checkout', '-q', '--detach', head);
      const specifier = target.startsWith('pkg/') ? '../pkg' : '../core/store';
      write(
        'worker/job.ts',
        `import make from '${specifier}';\nexport function job() { return make(); }\n`,
      );
      write(target, 'export default function implementation() {\n return 1;\n}\n');
      const prior = commit();
      write(target, 'export default function implementation() {\n return 0;\n}\n');
      const plan = await planIncrementalReview({
        ...input,
        head: commit(),
        priorBodies: [body(prior, base)],
        files: [...files, { filename: target, patch: '@@ -2 +2 @@\n- return 1;\n+ return 0;' }],
      });
      assert.equal(plan.mode, 'full', target);
      assert.equal(plan.reason, 'unresolved-import', target);
    }
    git('checkout', '-q', '--detach', head);
    write('pkg/index.ts', 'export default function implementation() {\n return 1;\n}\n');
    write('outside.ts', 'import make from "./pkg";\nmake();\n');
    const defaultBaseline = commit();
    write('pkg/index.ts', 'export default function implementation() {\n return 0;\n}\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBodies: [body(defaultBaseline, base)],
          files: [
            ...files,
            { filename: 'pkg/index.ts', patch: '@@ -2 +2 @@\n- return 1;\n+ return 0;' },
          ],
        })
      ).reason,
      'unsupported-module-dependencies',
    );
    for (const [decorator, tripped] of [
      ["@OnEvent('ledger.posted')", true],
      ["@MessagePattern({ cmd: 'sum' })", true],
      ['@OnEvent(LedgerEvents.Posted)', false],
    ] as const) {
      git('checkout', '-q', '--detach', head);
      const listener = (returned: number) =>
        `import { OnEvent } from '@nestjs/event-emitter';\nexport class L {\n  ${decorator}\n  handle() {\n    return ${returned};\n  }\n}\n`;
      write('ledger/listener.ts', listener(1));
      const prior = commit();
      write('ledger/listener.ts', listener(2));
      const plan = await planIncrementalReview({
        ...input,
        head: commit(),
        priorBodies: [body(prior, base)],
        files: [
          ...files,
          { filename: 'ledger/listener.ts', patch: '@@ -2 +2 @@\n- return 1;\n+ return 2;' },
        ],
      });
      assert.equal(
        plan.reason,
        tripped ? 'string-keyed-dependencies' : 'bounded-followup',
        decorator,
      );
    }
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
