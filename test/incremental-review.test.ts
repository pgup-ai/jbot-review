import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  withReviewCoverage,
  completedReviewHead,
  compactJbotReviewBody,
  type PrFile,
} from '../src/shared/github.ts';
import {
  BASELINE_REFRESH_REASONS,
  fetchMissingCommit,
  impactedReviewFiles,
  planIncrementalReview,
  reviewBaseline,
  ruleDocsChanged,
  withReviewBaseline,
} from '../src/shared/incremental-review.ts';
import { buildIncrementalReviewContext } from '../src/shared/prompt.ts';

const policy = 'c'.repeat(64);
const body = (head: string, base: string) =>
  withReviewCoverage(withReviewBaseline('<sup>driver</sup>', { head, base, policy }), head, true);

function gitRepo(prefix: string) {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
      { cwd: workspace, encoding: 'utf8' },
    ).trim();
  const write = (path: string, text: string) => {
    mkdirSync(join(workspace, path, '..'), { recursive: true });
    writeFileSync(join(workspace, path), text);
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { workspace, git, write, commit };
}

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
    body(head, base).replace(`"policy":"${policy}"`, `"policy":"${policy}","recheck":"a.ts"`),
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
  const locals = new Map([
    [
      'cases/eval.ts',
      ['export const CASES = [1].map((line) => { const event = line; return event; });'],
    ],
    [
      'links/service.ts',
      ['export function link(event: number) { const line = event; return line; }'],
    ],
  ]);
  const localFiles = [...locals.keys()].map((filename) => ({ filename }));
  assert.deepEqual(
    impactedReviewFiles(localFiles, ['cases/eval.ts'], locals).map((file) => file.filename),
    ['cases/eval.ts'],
  );
  for (const [changed, text] of [
    ['core/limits.ts', 'export const first = 0,\n  second = () => 1;'],
    ['core/math.js', 'function second() { return 1; }'],
  ]) {
    const shared = new Map([
      [changed, [text]],
      ['worker/run.ts', ['import { second } from "@core/limits";\nsecond();']],
      ['ui/cart.js', ['second();']],
    ]);
    const sharedFiles = [...shared.keys()].map((filename) => ({ filename }));
    assert.deepEqual(
      impactedReviewFiles(sharedFiles, [changed], shared).map((file) => file.filename),
      [changed, 'worker/run.ts', 'ui/cart.js'],
    );
  }
});

test('incremental planning uses a successful ancestor and falls back on uncertain follow-ups', async () => {
  const { workspace, git, write, commit } = gitRepo('jbot-incremental-');
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
      priorBodies: [body(reviewed, base), 'A later review with an incomplete session.'],
      rulesChangedSince: async () => false,
    };
    const result = await planIncrementalReview(input);
    assert.equal(result.mode, 'incremental');
    assert.deepEqual(
      result.files.map((file) => file.filename),
      ['core/limit.ts', 'worker/job.ts'],
    );
    // A file whose concern verification left open is reviewed again, unchanged or not.
    const recheck = withReviewCoverage(
      withReviewBaseline('<sup>driver</sup>', {
        head: reviewed,
        base,
        policy,
        recheck: ['other/label.ts', 'gone.ts'],
      }),
      reviewed,
      true,
    );
    assert.deepEqual(
      (await planIncrementalReview({ ...input, priorBodies: [recheck] })).files.map(
        (file) => file.filename,
      ),
      ['core/limit.ts', 'worker/job.ts', 'other/label.ts'],
    );
    const emitted = new Set<string>();
    for (const [overrides, reason] of [
      [{ forceFull: true }, 'explicit-or-incomplete-review'],
      [{ priorBodies: [] }, 'no-completed-baseline'],
      [{ base: undefined }, 'base-changed'],
      [{ policy: 'd'.repeat(64) }, 'policy-changed'],
      [{ head: reviewed }, 'same-head-rerun'],
      [{ rulesChangedSince: async () => true }, 'guidelines-changed'],
      [{ head: 'f'.repeat(40) }, 'history-or-impact-unavailable'],
      [
        // A package.json can call changed code from a script, even inside a fixtures directory.
        { files: [...files, { filename: 'fixtures/package.json', patch: 'patch' }] },
        'unsupported-or-large-pr',
      ],
    ] as const) {
      const plan = await planIncrementalReview({ ...input, ...overrides });
      assert.equal(plan.mode, 'full', reason);
      assert.equal(plan.reason, reason);
      emitted.add(plan.reason);
      assert.deepEqual(plan.files, overrides.files ?? files);
    }
    // A renamed reason must not silently stop the clean-run baseline refresh.
    for (const reason of BASELINE_REFRESH_REASONS) assert.ok(emitted.has(reason), reason);
    // Generated snapshots, the governance routing YAML and untouched JSON fixtures load into no code.
    const inert = await planIncrementalReview({
      ...input,
      files: [
        ...files,
        ...[
          'db/migrations/.snapshot-app.json',
          'fixtures/limit.json',
          'core/__fixtures__/limit.json',
          'core/__snapshots__/limit.spec.ts.snap',
          '.pr-governance/review/rules-for-diff.yaml',
        ].map((filename) => ({ filename, patch: '@@ -0,0 +1 @@\n+a' })),
      ],
    });
    assert.deepEqual(
      [inert.reason, inert.files.map((file) => file.filename)],
      ['bounded-followup', ['core/limit.ts', 'worker/job.ts']],
    );
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
    git('checkout', '-q', '--detach', head);
    write('pkg/index.ts', 'export default function implementation() {\n return 1;\n}\n');
    write('other/label.ts', 'export function label() {\n  return "ready";\n}\n');
    const untouchedDefault = commit();
    write('other/label.ts', 'export function label() {\n  return "idle";\n}\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBodies: [body(untouchedDefault, base)],
          files: [...files, { filename: 'pkg/index.ts', patch: '@@ -0,0 +1 @@\n+a' }],
        })
      ).reason,
      'bounded-followup',
    );
    // An unchanged file loading a changed one through a form the graph cannot follow.
    git('checkout', '-q', '--detach', head);
    write('app/loader.ts', "export const load = () => import('../core/limit');\n");
    const loader = commit();
    write('core/limit.ts', 'export function limit() {\n  return 2;\n}\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBodies: [body(loader, base)],
          files: [...files, { filename: 'app/loader.ts', patch: '@@ -0,0 +1 @@\n+a' }],
        })
      ).reason,
      'unsupported-module-dependencies',
    );
    // A computed specifier could name any changed module.
    git('checkout', '-q', '--detach', head);
    write(
      'app/plugins.ts',
      'export const load = (name: string) => import(`../plugins/${name}`);\n',
    );
    const plugins = commit();
    write('core/limit.ts', 'export function limit() {\n  return 3;\n}\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBodies: [body(plugins, base)],
          files: [...files, { filename: 'app/plugins.ts', patch: '@@ -0,0 +1 @@\n+a' }],
        })
      ).reason,
      'unsupported-module-dependencies',
    );
    // An edited file's namespace import of a module outside the PR, relative or aliased, or
    // `import'` in a string, reaches no PR file; one of a PR file does, as does an unchanged PR
    // file loading the changed module through an alias that never names it.
    git('checkout', '-q', '--detach', head);
    write('util/format.ts', 'export function format(value: number) {\n  return value;\n}\n');
    write(
      'tsconfig.json',
      '{"compilerOptions":{"paths":{"@fmt":["util/format.ts"],"@label":["other/label.ts"],"@svc":["core/limit.ts"]}}}',
    );
    const namespaced = (from: string, value: number) =>
      `import * as fmt from '${from}';\nexport function limit() {\n  return fmt.format(${value});\n}\nexport const title = 'integration import';\n`;
    for (const [from, reason, selected] of [
      ['../util/format', 'bounded-followup', ['core/limit.ts', 'worker/job.ts']],
      ['@fmt', 'bounded-followup', ['core/limit.ts', 'worker/job.ts']],
      ['../other/label', 'unsupported-module-dependencies', files.map((file) => file.filename)],
      ['@label', 'unsupported-module-dependencies', files.map((file) => file.filename)],
    ] as const) {
      write('core/limit.ts', namespaced(from, 7));
      const prior = commit();
      write('core/limit.ts', namespaced(from, 8));
      const plan = await planIncrementalReview({
        ...input,
        head: commit(),
        priorBodies: [body(prior, base)],
      });
      assert.deepEqual([plan.reason, plan.files.map((file) => file.filename)], [reason, selected]);
    }
    write('core/limit.ts', 'export function limit() {\n  return 7;\n}\n');
    write('other/label.ts', "import * as svc from '@svc';\nexport const label = () => svc;\n");
    const aliased = commit();
    write('core/limit.ts', 'export function limit() {\n  return 8;\n}\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBodies: [body(aliased, base)],
        })
      ).reason,
      'unsupported-module-dependencies',
    );
    // None of these block a follow-up: an unchanged listener whose key the change doesn't name,
    // imports of modules outside the PR or from packages, prose, and an added import line.
    git('checkout', '-q', '--detach', head);
    write(
      'ledger/listener.ts',
      "import { OnEvent } from '@nestjs/event-emitter';\nexport class L {\n  @OnEvent('ledger.posted')\n  handle() {\n    return 1;\n  }\n}\n",
    );
    write('util/format.ts', 'export function format(value: number) {\n  return value;\n}\n');
    write(
      'other/label.ts',
      "import dayjs from 'dayjs';\nimport { format } from '../util/format';\nexport function label() {\n  return format(dayjs().day());\n}\n",
    );
    write('docs/format.md', 'Notes.\n');
    const quiet = commit();
    const quietFiles = [
      ...files,
      ...['ledger/listener.ts', 'docs/format.md'].map((filename) => ({
        filename,
        patch: '@@ -0,0 +1 @@\n+a',
      })),
    ];
    write(
      'core/limit.ts',
      "import { format } from '../util/format';\nexport function limit() {\n  return format(6);\n}\n",
    );
    const quietPlan = { ...input, priorBodies: [body(quiet, base)], files: quietFiles };
    const importAdded = commit();
    assert.equal(
      (await planIncrementalReview({ ...quietPlan, head: importAdded })).reason,
      'bounded-followup',
    );
    // Prose named like a module outside the PR is no reference to it, even edited alone.
    write('docs/format.md', 'Notes on limits.\n');
    const proseOnly = await planIncrementalReview({
      ...quietPlan,
      head: commit(),
      priorBodies: [body(importAdded, base)],
    });
    assert.deepEqual(
      [proseOnly.reason, proseOnly.files.map((file) => file.filename)],
      ['bounded-followup', ['docs/format.md']],
    );
    write(
      'core/limit.ts',
      "import { format } from '../util/format';\nexport function limit() {\n  return format('ledger.posted'.length);\n}\n",
    );
    assert.equal(
      (await planIncrementalReview({ ...quietPlan, head: commit() })).reason,
      'string-keyed-dependencies',
    );
    write(
      'core/limit.ts',
      "import { format } from '../util/format';\nexport function limit() {\n  return format(bus.emit(LedgerEvents.Posted));\n}\n",
    );
    const constantKey = commit();
    for (const line of [
      'class Holder {\n  constructor(@Inject(TOKEN) readonly token: string) {}\n}',
      'const provider = { provide: TOKEN, useValue: 1 };',
    ]) {
      write(
        'core/limit.ts',
        `import { format } from '../util/format';\n${line}\nexport function limit() {\n  return format(6);\n}\n`,
      );
      assert.equal(
        (await planIncrementalReview({ ...quietPlan, head: commit() })).reason,
        'string-keyed-dependencies',
        line,
      );
    }
    assert.equal(
      (await planIncrementalReview({ ...quietPlan, head: constantKey })).reason,
      'string-keyed-dependencies',
    );
    assert.equal(
      (
        await planIncrementalReview({
          ...quietPlan,
          head: constantKey,
          files: [...quietFiles, { filename: 'docs/guide.mdx', patch: '@@ -0,0 +1 @@\n+a' }],
        })
      ).reason,
      'unsupported-or-large-pr',
    );
    // A fix's own tests do not count toward a broad follow-up: files under __tests__/ (named
    // like modules here, so only the directory matches), and specs with their Jest snapshots.
    const names = ['alpha', 'bravo', 'charlie'];
    const suite = (value: number) => `export function suite() {\n  return ${value};\n}\n`;
    for (const suites of [
      names.map((name) => `core/__tests__/${name}.ts`),
      [
        ...names.map((name) => `core/${name}.test.ts`),
        ...names.map((name) => `core/__snapshots__/${name}.test.ts.snap`),
      ],
    ]) {
      git('checkout', '-q', '--detach', head);
      for (const path of suites) write(path, suite(1));
      const untested = commit();
      for (const path of suites) write(path, suite(2));
      write('core/limit.ts', 'export function limit() {\n  return 4;\n}\n');
      assert.equal(
        (
          await planIncrementalReview({
            ...input,
            head: commit(),
            priorBodies: [body(untested, base)],
            files: [
              ...files,
              ...suites.map((filename) => ({ filename, patch: '@@ -0,0 +1 @@\n+a' })),
            ],
          })
        ).reason,
        'bounded-followup',
        suites[0],
      );
    }
    // A test under a sensitive directory is not itself sensitive.
    for (const [path, reason] of [
      ['api/__tests__/handler.test.ts', 'bounded-followup'],
      ['api/handler.ts', 'sensitive-followup'],
      ['api/spec/schema.ts', 'sensitive-followup'],
      ['api/test/route.ts', 'sensitive-followup'],
      ['apps/api/src/helper.ts', 'bounded-followup'],
      ['packages/api/src/helper.ts', 'bounded-followup'],
      ['apps/api/src/controllers/limits.ts', 'sensitive-followup'],
      ['src/routes/oauth/ramp/index.lazy.tsx', 'bounded-followup'],
      ['src/routes/oauth/ramp/index.ts', 'sensitive-followup'],
      ['src/api/routes/limits.tsx', 'sensitive-followup'],
    ] as const) {
      git('checkout', '-q', '--detach', head);
      write(path, 'export function check() {\n  return 1;\n}\n');
      const prior = commit();
      write(path, 'export function check() {\n  return 2;\n}\n');
      const plan = await planIncrementalReview({
        ...input,
        head: commit(),
        priorBodies: [body(prior, base)],
        files: [...files, { filename: path, patch: '@@ -0,0 +1 @@\n+a' }],
      });
      assert.equal(plan.reason, reason, path);
    }
    // A route page with a server handler (Remix) on either side is an endpoint despite its extension.
    const page = (value: number) => `export function Page() {\n  return ${value};\n}\n`;
    for (const [before, after] of [
      [
        `export async function action() {}\n${page(1)}`,
        `export async function action() {}\n${page(2)}`,
      ],
      [
        `  export const loader = () => 1;\n${page(1)}`,
        `  export const loader = () => 1;\n${page(2)}`,
      ],
      [`export { loader } from './users.server';\n${page(1)}`, page(1)],
    ]) {
      git('checkout', '-q', '--detach', head);
      write('src/routes/users.tsx', before);
      const handled = commit();
      write('src/routes/users.tsx', after);
      const plan = await planIncrementalReview({
        ...input,
        head: commit(),
        priorBodies: [body(handled, base)],
        files: [...files, { filename: 'src/routes/users.tsx', patch: '@@ -0,0 +1 @@\n+a' }],
      });
      assert.equal(plan.reason, 'sensitive-followup', after);
    }
    // A Jest snapshot under a sensitive directory is test output too, however many lines moved.
    git('checkout', '-q', '--detach', head);
    const output = (value: number) => `exports[\`case 1\`] = \`${value}\`;\n`.repeat(130);
    write('api/handler.spec.ts', "it('handles', () => 1);\n");
    write('api/__snapshots__/handler.spec.ts.snap', output(1));
    const recorded = commit();
    write('api/__snapshots__/handler.spec.ts.snap', output(2));
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBodies: [body(recorded, base)],
          files: [
            ...files,
            ...['api/handler.spec.ts', 'api/__snapshots__/handler.spec.ts.snap'].map(
              (filename) => ({
                filename,
                patch: '@@ -0,0 +1 @@\n+a',
              }),
            ),
          ],
        })
      ).reason,
      'bounded-followup',
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
    // A new test file, even one longer than the edit cap, is reviewed with the fix it covers.
    git('checkout', '-q', '--detach', head);
    write('core/limit.ts', 'export function limit() {\n  return 11;\n}\n');
    write(
      'core/limit.spec.ts',
      `import { limit } from './limit';\nexport const cases = 1;\n${"it('caps', () => limit());\n".repeat(130)}`,
    );
    write('core/__snapshots__/limit.spec.ts.snap', 'exports[`caps 1`] = `11`;\n');
    const withSpec = await planIncrementalReview({
      ...input,
      head: commit(),
      files: [
        ...files,
        ...['core/limit.spec.ts', 'core/__snapshots__/limit.spec.ts.snap'].map((filename) => ({
          filename,
          patch: '@@ -0,0 +1 @@\n+a',
        })),
      ],
    });
    assert.deepEqual(
      [withSpec.reason, withSpec.files.map((file) => file.filename)],
      [
        'bounded-followup',
        [
          'core/limit.ts',
          'worker/job.ts',
          'core/limit.spec.ts',
          'core/__snapshots__/limit.spec.ts.snap',
        ],
      ],
    );
    // An edited Jest snapshot brings its spec and the code the spec covers; an edited
    // migration snapshot is a schema change.
    git('checkout', '-q', '--detach', head);
    write(
      'other/label.spec.ts',
      "import { label } from './label';\nit('labels', () => label());\n",
    );
    write('other/__snapshots__/label.spec.ts.snap', 'exports[`labels 1`] = `"active"`;\n');
    write('db/migrations/.snapshot-app.json', '{"tables":[]}\n');
    const snapshots = commit();
    const snapshotFiles = [
      ...files,
      ...[
        'other/label.spec.ts',
        'other/__snapshots__/label.spec.ts.snap',
        'db/migrations/.snapshot-app.json',
      ].map((filename) => ({ filename, patch: '@@ -0,0 +1 @@\n+a' })),
    ];
    for (const [path, text, reason, selected] of [
      [
        'other/__snapshots__/label.spec.ts.snap',
        'exports[`labels 1`] = `"idle"`;\n',
        'bounded-followup',
        ['other/label.ts', 'other/label.spec.ts', 'other/__snapshots__/label.spec.ts.snap'],
      ],
      [
        'db/migrations/.snapshot-app.json',
        '{"tables":["ledger"]}\n',
        'sensitive-followup',
        snapshotFiles.map((file) => file.filename),
      ],
    ] as const) {
      git('checkout', '-q', '--detach', snapshots);
      write(path, text);
      const plan = await planIncrementalReview({
        ...input,
        head: commit(),
        priorBodies: [body(snapshots, base)],
        files: snapshotFiles,
      });
      assert.deepEqual(
        [plan.reason, plan.files.map((file) => file.filename)],
        [reason, selected],
        path,
      );
    }
    // Without its spec in the PR, the snapshot would be reviewed apart from the test it records.
    git('checkout', '-q', '--detach', snapshots);
    write('other/__snapshots__/label.spec.ts.snap', 'exports[`labels 1`] = `"idle"`;\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          head: commit(),
          priorBodies: [body(snapshots, base)],
          files: snapshotFiles.filter((file) => file.filename !== 'other/label.spec.ts'),
        })
      ).reason,
      'references-outside-pr',
    );
    // An edited JSON fixture may be read by path, which the import graph cannot see.
    git('checkout', '-q', '--detach', head);
    write('fixtures/limit.json', '{ "limit": 0 }\n');
    const fixtured = commit();
    write('fixtures/limit.json', '{ "limit": 1 }\n');
    assert.equal(
      (
        await planIncrementalReview({
          ...input,
          priorBodies: [body(fixtured, base)],
          head: commit(),
          files: [...files, { filename: 'fixtures/limit.json', patch: 'patch' }],
        })
      ).reason,
      'unsupported-or-large-pr',
    );
    // A helper under __tests__/ can be named by config, unlike a spec.
    for (const path of ['core/new.ts', 'core/__tests__/setup.ts']) {
      git('checkout', '-q', '--detach', head);
      write(path, 'export const value = 1;\n');
      assert.equal(
        (await planIncrementalReview({ ...input, head: commit() })).reason,
        'added-removed-or-renamed-file',
        path,
      );
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('rule docs count as changed between heads only when their content moved', async () => {
  const { workspace, git, write, commit } = gitRepo('jbot-rules-');
  try {
    git('init', '-q');
    write('AGENTS.md', 'Use LoadedModel.\n');
    write('docs/EXEMPTIONS.md', 'Tests may build fixtures by hand.\n');
    write('.cursorrules', 'Prefer named exports.\n');
    write('src/notes.txt', 'not guidance\n');
    write('src/a.ts', 'export const a = 1;\n');
    const reviewed = commit();
    write('src/a.ts', 'export const a = 2;\n');
    const codeOnly = commit();
    write('AGENTS.md', 'Use LoadedModel for populated relations.\n');
    const ruleEdit = commit();
    const none = new Set<string>();
    const changed = (paths: string[], from: string, to: string, prPaths = none) =>
      ruleDocsChanged(workspace, { paths, prEdited: [], prPaths, complete: true }, from, to);
    assert.equal(await changed(['AGENTS.md'], reviewed, codeOnly), false);
    assert.equal(await changed(['AGENTS.md'], reviewed, ruleEdit), true);
    assert.equal(await changed([], reviewed, ruleEdit), false);
    assert.equal(await changed(['AGENTS.md'], 'f'.repeat(40), ruleEdit), true);
    // A deleted doc is not in today's discovery; only the PR's own deletions are left out.
    rmSync(join(workspace, 'docs/EXEMPTIONS.md'));
    const deletion = commit();
    assert.equal(await changed([], ruleEdit, deletion), true);
    assert.equal(await changed([], ruleEdit, deletion, new Set(['docs/EXEMPTIONS.md'])), false);
    rmSync(join(workspace, '.cursorrules'));
    const cursorRules = commit();
    assert.equal(await changed([], deletion, cursorRules), true);
    rmSync(join(workspace, 'src/notes.txt'));
    const unrelated = commit();
    assert.equal(await changed([], cursorRules, unrelated), false);
    // Rename detection must not hide a guideline file moved to a non-guideline name.
    git('mv', 'AGENTS.md', 'NOTES.txt');
    assert.equal(await changed([], unrelated, commit()), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a base edit to a rule doc the PR also edits counts; edits by the PR itself do not', async () => {
  const { workspace, git, write, commit } = gitRepo('jbot-rules-base-');
  try {
    git('init', '-q', '-b', 'main');
    write('AGENTS.md', 'Intro.\n\n\n\n\nRules.\n');
    write('src/a.ts', 'export const a = 1;\n');
    commit();
    git('checkout', '-q', '-b', 'pr');
    write('AGENTS.md', 'Intro, edited by the PR.\n\n\n\n\nRules.\n');
    const reviewed = commit();
    git('checkout', '-q', 'main');
    write('AGENTS.md', 'Intro.\n\n\n\n\nRules, now mandatory.\n');
    const main = commit();
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-edit', 'main');
    const merged = git('rev-parse', 'HEAD');
    write('AGENTS.md', 'Intro, edited again by the PR.\n\n\n\n\nRules, now mandatory.\n');
    const ownEdit = commit();
    const rules = {
      paths: [],
      prEdited: ['AGENTS.md'],
      prPaths: new Set(['AGENTS.md']),
      base: main,
      complete: true,
    };
    assert.equal(await ruleDocsChanged(workspace, rules, reviewed, merged), true);
    assert.equal(await ruleDocsChanged(workspace, rules, merged, ownEdit), false);
    // Discovery out of budget: any guidance a later base merge brings in counts, still not the PR's edits.
    git('checkout', '-q', 'main');
    write('docs/unlisted.md', 'A rule discovery never reached.\n');
    const mainDoc = commit();
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-edit', 'main');
    const mergedDoc = git('rev-parse', 'HEAD');
    const partial = { paths: [], prEdited: [], prPaths: new Set<string>(), base: mainDoc };
    assert.equal(
      await ruleDocsChanged(workspace, { ...partial, complete: false }, ownEdit, mergedDoc),
      true,
    );
    assert.equal(
      await ruleDocsChanged(workspace, { ...partial, complete: true }, ownEdit, mergedDoc),
      false,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a merge from the base branch re-reviews only the PR files it or the author touched', async () => {
  const { workspace, git, write, commit } = gitRepo('jbot-incremental-merge-');
  const mergeMain = (path: string, text: string) => {
    git('checkout', '-q', 'main');
    write(path, text);
    const main = commit();
    git('checkout', '-q', 'pr');
    git('merge', '-q', '--no-edit', 'main');
    return main;
  };
  const charlie = (label: string, value: number) =>
    `export function charlie() {\n  const label = '${label}';\n  // one\n  // two\n  // three\n  // four\n  return ${value};\n}\n`;
  try {
    git('init', '-q', '-b', 'main');
    write('tsconfig.json', '{ "compilerOptions": { "paths": { "@app/*": ["*"] } } }\n');
    write('a/alpha.ts', 'export function alpha() {\n  return 1;\n}\n');
    write(
      'b/beta.ts',
      "import { gamma } from '@app/shared/gamma';\nexport function beta() {\n  return gamma();\n}\n",
    );
    write('c/charlie.ts', charlie('c', 3));
    write('shared/gamma.ts', 'export function gamma() {\n  return 3;\n}\n');
    write('auth/session.ts', 'export function session() {\n  return 1;\n}\n');
    write('docs/notes.ts', 'export const notes = 0;\n');
    const base = commit();
    git('checkout', '-q', '-b', 'pr');
    write('a/alpha.ts', 'export function alpha() {\n  return 10;\n}\n');
    write(
      'b/beta.ts',
      "import { gamma } from '@app/shared/gamma';\nexport function beta() {\n  return gamma() + 1;\n}\n",
    );
    write('c/charlie.ts', charlie('c', 30));
    for (const name of ['delta', 'echo'])
      write(
        `${name[0]}/${name}.ts`,
        `import { gamma } from '@app/shared/gamma';\nexport function ${name}() {\n  return gamma();\n}\n`,
      );
    write(
      'f/foxtrot.ts',
      "import { session } from '@app/auth/session';\nexport function foxtrot() {\n  return session();\n}\n",
    );
    write('g/golf.ts', "export * from '../shared/gamma';\n");
    const reviewed = commit();
    const prFiles = (...paths: string[]) =>
      paths.map((filename) => ({ filename, patch: '@@ -1 +1 @@\n-a\n+b' }));
    const files = prFiles('a/alpha.ts', 'b/beta.ts', 'c/charlie.ts');
    const scope = async (
      head: string,
      mainTip: string,
      prior: string,
      priorBase: string,
      extra: PrFile[] = [],
    ) => {
      const plan = await planIncrementalReview({
        workspace,
        files: [...files, ...extra],
        head,
        base: mainTip,
        policy,
        priorBodies: [body(prior, priorBase)],
        rulesChangedSince: async () => false,
      });
      return [plan.mode, plan.reason, plan.files.map((file) => file.filename)];
    };

    // Main's change stays out even when the review already recorded that base tip.
    let mainTip = mergeMain('docs/notes.ts', 'export const notes = 1;\n');
    write('a/alpha.ts', 'export function alpha() {\n  return 11;\n}\n');
    let head = commit();
    assert.deepEqual(await scope(head, mainTip, reviewed, mainTip), [
      'incremental',
      'bounded-base-merge',
      ['a/alpha.ts'],
    ]);
    // A PR file importing a merged module by alias joins the review, up to the file limit.
    const [notesTip, edited] = [mainTip, head];
    mainTip = mergeMain('shared/gamma.ts', 'export function gamma() {\n  return 4;\n}\n');
    head = git('rev-parse', 'HEAD');
    // With no author edit since the baseline, the shadow still selects the merged module's importers.
    const mergeOnly = await planIncrementalReview({
      workspace,
      files,
      head,
      base: mainTip,
      policy,
      priorBodies: [body(edited, notesTip)],
      rulesChangedSince: async () => false,
    });
    assert.deepEqual(mergeOnly.shadow?.files, ['b/beta.ts']);
    assert.deepEqual(await scope(head, mainTip, reviewed, base), [
      'incremental',
      'bounded-base-merge',
      ['a/alpha.ts', 'b/beta.ts'],
    ]);
    const importers = prFiles('d/delta.ts', 'e/echo.ts');
    assert.deepEqual(await scope(head, mainTip, reviewed, base, importers), [
      'full',
      'broad-or-empty-followup',
      [...files, ...importers].map((file) => file.filename),
    ]);
    // An untouched PR file re-exporting a merged module is outside the graph.
    assert.deepEqual(
      (await scope(head, mainTip, reviewed, base, prFiles('g/golf.ts'))).slice(0, 2),
      ['full', 'unsupported-module-dependencies'],
    );
    // A PR file the merge itself edited is re-reviewed, even with no new author edit.
    const nextTip = mergeMain('c/charlie.ts', charlie('C', 3));
    const merge = git('rev-parse', 'HEAD');
    assert.deepEqual(await scope(merge, nextTip, head, mainTip), [
      'incremental',
      'bounded-base-merge',
      ['c/charlie.ts'],
    ]);
    // A base tip the PR has not merged forces a full review, whatever the author edited.
    git('checkout', '-q', 'main');
    write('docs/notes.ts', 'export const notes = 2;\n');
    const unmergedTip = commit();
    git('checkout', '-q', 'pr');
    write('a/alpha.ts', 'export function alpha() {\n  return 12;\n}\n');
    assert.deepEqual((await scope(commit(), unmergedTip, merge, nextTip)).slice(0, 2), [
      'full',
      'base-changed',
    ]);
    // Importing a sensitive module the merge changed gets the full review a sensitive edit gets,
    // whether or not the author also edited the importer.
    const sensitiveTip = mergeMain(
      'auth/session.ts',
      'export function session() {\n  return 2;\n}\n',
    );
    const foxtrot = prFiles('f/foxtrot.ts');
    const unedited = git('rev-parse', 'HEAD');
    write(
      'f/foxtrot.ts',
      "import { session } from '@app/auth/session';\nexport function foxtrot() {\n  return session() + 1;\n}\n",
    );
    for (const head of [unedited, commit()])
      assert.deepEqual((await scope(head, sensitiveTip, merge, nextTip, foxtrot)).slice(0, 2), [
        'full',
        'sensitive-followup',
      ]);
    // A merged test module under a sensitive directory is not itself sensitive.
    const hotelBase = mergeMain(
      'api/__tests__/fixture.test.ts',
      'export function fixture() {\n  return 1;\n}\n',
    );
    write(
      'h/hotel.ts',
      "import { fixture } from '@app/api/__tests__/fixture.test';\nexport function hotel() {\n  return fixture();\n}\n",
    );
    const hotelHead = commit();
    const fixtureTip = mergeMain(
      'api/__tests__/fixture.test.ts',
      'export function fixture() {\n  return 2;\n}\n',
    );
    write('a/alpha.ts', 'export function alpha() {\n  return 13;\n}\n');
    assert.deepEqual(
      await scope(commit(), fixtureTip, hotelHead, hotelBase, prFiles('h/hotel.ts')),
      ['incremental', 'bounded-base-merge', ['a/alpha.ts', 'h/hotel.ts']],
    );
    // A merged non-code module still counts for an unchanged file that loads it.
    const configBase = mergeMain('shared/config.json', '{ "limit": 1 }\n');
    write(
      'i/india.ts',
      "const config = require('../shared/config.json');\nexport function india() {\n  return config;\n}\n",
    );
    const indiaHead = commit();
    const configTip = mergeMain('shared/config.json', '{ "limit": 2 }\n');
    write('a/alpha.ts', 'export function alpha() {\n  return 14;\n}\n');
    assert.deepEqual(
      (await scope(commit(), configTip, indiaHead, configBase, prFiles('i/india.ts'))).slice(0, 2),
      ['full', 'unsupported-module-dependencies'],
    );
    // A merged dotfile has no module name to match.
    const dotfileHead = git('rev-parse', 'HEAD');
    const dotfileTip = mergeMain('.nvmrc', '22\n');
    write('a/alpha.ts', 'export function alpha() {\n  return 15;\n}\n');
    assert.deepEqual(
      await scope(commit(), dotfileTip, dotfileHead, configTip, prFiles('g/golf.ts')),
      ['incremental', 'bounded-base-merge', ['a/alpha.ts']],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('an amend or a rebase re-reviews only the PR files it or the author touched', async () => {
  const { workspace, git, write, commit } = gitRepo('jbot-incremental-rebase-');
  const source = (name: string, value: number) =>
    `export function ${name}() {\n  return ${value};\n}\n`;
  try {
    git('init', '-q', '-b', 'main');
    write('a/alpha.ts', source('alpha', 1));
    write('b/beta.ts', source('beta', 2));
    write('c/charlie.ts', source('charlie', 3));
    write('docs/notes.ts', 'export const notes = 0;\n');
    const base = commit();
    git('checkout', '-q', '-b', 'pr');
    write('a/alpha.ts', source('alpha', 10));
    write('b/beta.ts', source('beta', 20));
    // A source file the PR already deleted at the baseline has no text to read at either head.
    git('rm', '-q', 'c/charlie.ts');
    const reviewed = commit();
    const files = ['a/alpha.ts', 'b/beta.ts', 'c/charlie.ts'].map((filename) => ({
      filename,
      patch: '@@ -1 +1 @@\n-a\n+b',
    }));
    const scope = async (head: string, mainTip: string) => {
      const plan = await planIncrementalReview({
        workspace,
        files,
        head,
        base: mainTip,
        policy,
        priorBodies: [body(reviewed, base)],
        rulesChangedSince: async () => false,
      });
      return [plan.mode, plan.reason, plan.files.map((file) => file.filename)];
    };
    write('a/alpha.ts', source('alpha', 11));
    git('commit', '-qa', '--amend', '--no-edit');
    assert.deepEqual(await scope(git('rev-parse', 'HEAD'), base), [
      'incremental',
      'bounded-followup',
      ['a/alpha.ts'],
    ]);
    git('checkout', '-q', 'main');
    write('e/echo.ts', source('echo', 5));
    const tip = commit();
    git('checkout', '-q', 'pr');
    git('rebase', '-q', 'main');
    const rebased = git('rev-parse', 'HEAD');
    assert.deepEqual(await scope(rebased, tip), [
      'incremental',
      'bounded-base-merge',
      ['a/alpha.ts'],
    ]);
    // Rebuilt on the older base point but keeping a file main added, the head's PR diff gains a
    // file the review only saw as base, which the head-to-head diff does not show.
    git('rebase', '-q', '--onto', base, tip);
    git('checkout', tip, '--', 'e/echo.ts');
    write('a/alpha.ts', source('alpha', 12));
    const rebuilt = commit();
    const plan = await planIncrementalReview({
      workspace,
      files: [...files, { filename: 'e/echo.ts', patch: '@@ -0,0 +1 @@\n+b' }],
      head: rebuilt,
      base: tip,
      policy,
      priorBodies: [body(rebased, tip)],
      rulesChangedSince: async () => false,
    });
    assert.deepEqual([plan.mode, plan.reason], ['full', 'base-changed']);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a reviewed head missing from the checkout is fetched without storing the token', async () => {
  const origin = gitRepo('jbot-fetch-origin-');
  const clone = mkdtempSync(join(tmpdir(), 'jbot-fetch-clone-'));
  const shallow = mkdtempSync(join(tmpdir(), 'jbot-fetch-shallow-'));
  try {
    origin.git('init', '-q', '-b', 'main');
    origin.write('a.ts', 'export const a = 1;\n');
    origin.commit();
    execFileSync('git', ['clone', '-q', origin.workspace, clone]);
    origin.write('a.ts', 'export const a = 2;\n');
    const missing = origin.commit();
    await fetchMissingCommit(clone, missing, origin.workspace, 'secret-token');
    execFileSync('git', ['cat-file', '-e', `${missing}^{commit}`], { cwd: clone });
    assert.doesNotMatch(
      readFileSync(join(clone, '.git', 'config'), 'utf8'),
      /secret-token|extraheader/,
    );
    // A shallow clone takes the depth-limited fetch.
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${origin.workspace}`, shallow]);
    origin.write('a.ts', 'export const a = 3;\n');
    const later = origin.commit();
    await fetchMissingCommit(shallow, later, `file://${origin.workspace}`, 'secret-token');
    execFileSync('git', ['cat-file', '-e', `${later}^{commit}`], { cwd: shallow });
    // A failed fetch fails open, leaving the planner to review in full.
    await fetchMissingCommit(clone, 'e'.repeat(40), join(clone, 'missing'), 'secret-token');
  } finally {
    rmSync(origin.workspace, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
    rmSync(shallow, { recursive: true, force: true });
  }
});

test('a dotenv edit re-reviews the file and the PR files reading its keys', async () => {
  const { workspace, git, write, commit } = gitRepo('jbot-incremental-dotenv-');
  try {
    git('init', '-q');
    write('.env.production', 'VITE_URL=x\n');
    write('src/env.ts', 'export const url = import.meta.env.VITE_URL;\n');
    write('src/use.ts', "import { url } from './env';\nexport const use = () => url;\n");
    write('other/a.ts', 'export const a = 1;\n');
    write('lib/outside.ts', 'export const other = import.meta.env.VITE_OTHER;\n');
    // Docs naming a key read no value.
    write('docs/flags.md', 'VITE_UNUSED is reserved.\n');
    write('config/.env.ts', 'const port = 1;\n');
    const base = commit();
    write(
      'src/env.ts',
      'export const url = import.meta.env.VITE_URL;\nexport const flag = import.meta.env.VITE_FLAG;\n',
    );
    const reviewed = commit();
    write('.env.production', 'VITE_URL=x\nVITE_FLAG=true\n');
    const head = commit();
    write('.env.production', 'VITE_URL=x\nVITE_FLAG=true\nVITE_OTHER=1\n');
    const outside = commit();
    const edit = (text: string, from = reviewed) => {
      git('checkout', '-q', '--detach', from);
      write('.env.production', text);
      return commit();
    };
    const unread = edit('VITE_URL=x\n# note\nexport VITE_UNUSED=1\n');
    const multiline = edit('VITE_URL="x\ny"\n');
    const large = edit(
      ['VITE_URL=x', ...Array.from({ length: 121 }, (_, i) => `VITE_K${i}=1`)].join('\n'),
    );
    const computed = [
      "(name: string) => import.meta.env['VITE_' + name]",
      '(name: string) => process.env?.[name]',
      '(name: string) => {\n  const { [name]: value } = process.env;\n  return value;\n}',
    ].map((reader) => {
      git('checkout', '-q', '--detach', reviewed);
      write('lib/outside.ts', `export const other = ${reader};\n`);
      const from = commit();
      return [edit('VITE_URL=y\n', from), from] as const;
    });
    git('checkout', '-q', '--detach', reviewed);
    // A .env.ts module is code: an export edit there is a contract change.
    write('config/.env.ts', 'export const port = 1;\n');
    const module = commit();
    // Paths stay plain under a user's color.ui=always.
    git('config', 'color.ui', 'always');
    const plan = (at: string, from = reviewed) =>
      planIncrementalReview({
        workspace,
        files: ['.env.production', 'src/env.ts', 'src/use.ts', 'other/a.ts', 'config/.env.ts'].map(
          (filename) => ({
            filename,
            patch: '@@ -1 +1 @@\n-a\n+b',
          }),
        ),
        head: at,
        base,
        policy,
        priorBodies: [body(from, base)],
        rulesChangedSince: async () => false,
      });
    for (const [at, files] of [
      [head, ['.env.production', 'src/env.ts']],
      [unread, ['.env.production']],
    ] as const) {
      const result = await plan(at);
      assert.deepEqual(
        [result.mode, result.files.map((file) => file.filename)],
        ['incremental', files],
      );
    }
    assert.equal((await plan(outside)).reason, 'references-outside-pr');
    assert.equal((await plan(multiline)).reason, 'unsupported-or-large-pr');
    assert.equal((await plan(large)).reason, 'broad-or-contract-change');
    assert.equal((await plan(module)).reason, 'broad-or-contract-change');
    for (const [at, from] of computed)
      assert.equal((await plan(at, from)).reason, 'string-keyed-dependencies');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the shadow scope selects edited files and their importers without changing the plan', async () => {
  const { workspace, git, write, commit } = gitRepo('jbot-incremental-shadow-');
  try {
    git('init', '-q');
    write('tsconfig.json', '{ "compilerOptions": { "paths": { "@app/*": ["*"] } } }\n');
    write('core/limit.ts', 'export function limit() {\n  return 5;\n}\n');
    write('lib/index.ts', "export * from '../core/limit';\n");
    write('worker/job.ts', "import { limit } from '../core/limit';\nexport const job = limit;\n");
    write('api/use.ts', "import { limit } from '@app/lib';\nexport const use = limit;\n");
    write('boot/main.ts', "import '../core/limit';\n");
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      write(`other/${name}.ts`, `export const ${name} = 1;\n`);
    const base = commit();
    write('other/a.ts', 'export const a = 2;\n');
    const reviewed = commit();
    write('core/limit.ts', 'export function limit() {\n  return 0;\n}\n');
    const head = commit();
    rmSync(join(workspace, 'core/limit.ts'));
    const deleted = commit();
    const prFiles = (...paths: string[]) =>
      paths.map((filename) => ({ filename, patch: '@@ -1 +1 @@\n-a\n+b' }));
    const plan = (files: PrFile[], at = head) =>
      planIncrementalReview({
        workspace,
        files,
        head: at,
        base,
        policy,
        priorBodies: [body(reviewed, base)],
        rulesChangedSince: async () => false,
      });
    const selected = prFiles('core/limit.ts', 'worker/job.ts', 'api/use.ts', 'boot/main.ts');
    const unrelated = prFiles(...['a', 'b', 'c', 'd', 'e'].map((name) => `other/${name}.ts`));
    const files = [...selected, ...unrelated];
    const result = await plan([...files, ...prFiles('config.yaml')]);
    assert.equal(result.reason, 'unsupported-or-large-pr');
    assert.equal(result.files.length, 10);
    // A deleted file still reaches the importers of a barrel re-exporting it.
    for (const shadow of [result.shadow, (await plan(files, deleted)).shadow])
      assert.deepEqual(
        { ...shadow, planningMs: 0 },
        {
          mode: 'incremental',
          reason: 'delta-importers',
          files: ['core/limit.ts', 'worker/job.ts', 'api/use.ts', 'boot/main.ts'],
          planningMs: 0,
        },
      );
    assert.equal(
      (await plan([...selected, ...unrelated.slice(0, 1)])).shadow?.reason,
      'broad-impact',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
