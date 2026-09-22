import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runPrReview } from '../src/shared/runner.ts';
import { reviewBaseline } from '../src/shared/incremental-review.ts';
import { reviewExperiment } from '../src/shared/review-experiment.ts';
import type { PrFile } from '../src/shared/github.ts';

const output = resolve(process.argv[2] ?? '.jbot-review/incremental-comparison');
mkdirSync(output, { recursive: true });
const workspace = mkdtempSync(join(tmpdir(), 'jbot-incremental-comparison-'));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
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
const sources: Record<string, string> = {
  'core/batch.ts':
    'export function batchWidth(remaining: number) {\n  return Math.min(2, remaining);\n}\n',
  'jobs/drain.ts': `import { batchWidth as width } from '../core/batch.ts';
export function drain<T>(items: T[]): T[][] {
  const groups: T[][] = [];
  for (let cursor = 0; cursor < items.length;) {
    const size = width(items.length - cursor);
    groups.push(items.slice(cursor, cursor + size));
    cursor += size;
  }
  return groups;
}
`,
  'billing/payable.ts':
    'export function payable(cents: number, discount: number) {\n  return Math.max(0, cents - discount);\n}\n',
  'display/label.ts':
    'export function label(active: boolean) {\n  return active ? "Active" : "Inactive";\n}\n',
  'time/seconds.ts':
    'export function seconds(milliseconds: number) {\n  return milliseconds / 1000;\n}\n',
  'text/slug.ts':
    'export function slug(text: string) {\n  return text.trim().toLowerCase().replace(/\\s+/g, "-");\n}\n',
  'collections/unique.ts':
    'export function unique<T>(values: T[]) {\n  return [...new Set(values)];\n}\n',
  'dates/isLeapYear.ts':
    'export function isLeapYear(year: number) {\n  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);\n}\n',
};
git('init', '-q');
write(
  'README.md',
  'Standalone utility library. Amount inputs are nonnegative integer cents; discounts may exceed the amount. Payable amounts must never be negative. drain must return consecutive nonempty batches of up to two items and terminate for every finite array.\n',
);
const base = commit();
for (const [path, text] of Object.entries(sources)) write(path, text);
const baselineHead = commit();
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    { workspace, base, baselineHead, model: 'opencode/mimo-v2.6-flash-free', repetitions: 3 },
    null,
    2,
  ),
);
const filesAtHead = (): PrFile[] =>
  Object.keys(sources).map((filename) => ({
    filename,
    patch: git('diff', '--no-ext-diff', '--no-textconv', `${base}...HEAD`, '--', filename)
      .split('\n')
      .filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file mode)/.test(line))
      .join('\n'),
  }));
const rows: unknown[] = [];
async function review(name: string, incremental: boolean, priorReview?: string) {
  const directory = join(output, name);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, 'log.txt');
  writeFileSync(logPath, '');
  let body = '';
  let result: unknown;
  const start = performance.now();
  await runPrReview({
    owner: 'local',
    repo: 'incremental-fixture',
    pullNumber: 0,
    pullTitle: 'Add batch, billing and formatting utilities',
    pullBody:
      'Public utility functions for downstream callers. Payable amounts must be clamped to zero; discounts may exceed the subtotal. Batch draining must terminate for every finite input.',
    workspace,
    telemetryDirectory: directory,
    model: 'opencode/mimo-v2.6-flash-free',
    apiKey: process.env.OPENCODE_API_KEY ?? '',
    baseRef: base,
    baseSha: base,
    headSha: git('rev-parse', 'HEAD'),
    localDiff: {
      files: filesAtHead(),
      commits: [],
      priorReview: incremental ? priorReview : undefined,
    },
    options: {
      dryRun: true,
      sdkEngine: 'opencode',
      reviewPasses: 2,
      dynamicFanout: true,
      guidelinePass: false,
      reviewShards: 1,
      verifyFindings: true,
      enhancedContext: true,
      context7Mode: 'off',
      maxConcurrentSessions: 3,
      timeBudgetMinutes: 5,
      modelOptions: { reasoningEffort: 'low' },
      modelOptionsExplicit: true,
      promptCache: true,
      experiment: reviewExperiment({ JBOT_REVIEW_EXPERIMENT: 'diff-batches' }),
      onReviewResult: (value) => {
        result = value;
      },
    },
    log: (message) => {
      appendFileSync(logPath, message + '\n');
      if (message.startsWith('Dry run review body:\n'))
        body = message.slice('Dry run review body:\n'.length);
    },
  });
  const row = {
    name,
    head: git('rev-parse', 'HEAD'),
    base,
    incremental,
    durationMs: Math.round(performance.now() - start),
    result,
  };
  writeFileSync(join(directory, 'review.md'), body);
  writeFileSync(join(directory, 'result.json'), JSON.stringify(row, null, 2));
  rows.push(row);
  writeFileSync(join(output, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(
    JSON.stringify({
      name,
      durationMs: row.durationMs,
      baselineEligible: Boolean(reviewBaseline(body)),
    }),
  );
  return body;
}
const baselineBody = await review('baseline', false);
if (!reviewBaseline(baselineBody))
  throw new Error('Baseline did not complete; inspect its diagnostics.');
for (const scenario of ['direct', 'cross-file', 'clean']) {
  git('checkout', '-q', '--detach', baselineHead);
  if (scenario === 'direct')
    write(
      'billing/payable.ts',
      sources['billing/payable.ts'].replace('Math.max(0, cents - discount)', 'cents - discount'),
    );
  if (scenario === 'cross-file')
    write(
      'core/batch.ts',
      sources['core/batch.ts'].replace('Math.min(2, remaining)', 'remaining < 2 ? 0 : 2'),
    );
  if (scenario === 'clean')
    write('display/label.ts', sources['display/label.ts'].replace('"Inactive"', '"Disabled"'));
  commit();
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const incremental of repetition % 2 ? [true, false] : [false, true]) {
      await review(
        `${scenario}-${repetition + 1}-${incremental ? 'incremental' : 'full'}`,
        incremental,
        baselineBody,
      );
    }
  }
}
console.log(`Results: ${output}; fixture: ${workspace}`);
