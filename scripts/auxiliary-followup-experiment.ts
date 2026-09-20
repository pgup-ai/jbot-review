import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseGitDiff, GIT_DIFF_ARGS } from '../src/shared/git.ts';
import { reviewExperiment } from '../src/shared/review-experiment.ts';
import type { Octokit } from '../src/shared/github.ts';
import type { ReviewRunOptions } from '../src/shared/runner.ts';

process.loadEnvFile();
const root = process.cwd();
const control = process.argv[2];
const output = process.argv[3];
if (!control || !output)
  throw new Error(
    'Usage: tsx scripts/auxiliary-followup-experiment.ts <control-checkout> <output-dir>',
  );
for (const cwd of [root, control])
  if (execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim())
    throw new Error(`Experiment requires a clean checkout: ${cwd}`);
mkdirSync(output, { recursive: true });
const model = 'cline/cline-free/muse-spark-1.3-contributor';
const workspace = mkdtempSync(join(tmpdir(), 'jbot-followup-'));
const gitConfigDirectory = mkdtempSync(join(tmpdir(), 'jbot-followup-config-'));
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
const commit = (message: string) => {
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', message);
  return git('rev-parse', 'HEAD');
};
const revision = (cwd: string) =>
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
process.env.GIT_CONFIG_GLOBAL = join(gitConfigDirectory, 'config');
const rows: object[] = [];
try {
  git('init', '-q');
  mkdirSync(join(workspace, 'src'));
  writeFileSync(
    join(workspace, 'AGENTS.md'),
    '# Review contracts\nAll submitted jobs must appear in the returned batches exactly once. The configured limit is a per-batch capacity, not a limit on total processed jobs. The worker invokes the exported entry point for all queued jobs.\nThe exported queue policy in src/policy.ts must retain an explicit owner: "batch-worker" field.\n',
  );
  const before =
    'export function reviewBatch(jobs: number[], limit: number) {\n  const batches: number[][] = [];\n  for (let i = 0; i < jobs.length; i += limit) batches.push(jobs.slice(i, i + limit));\n  return batches;\n}\n';
  writeFileSync(join(workspace, 'src/batch.ts'), before);
  writeFileSync(
    join(workspace, 'src/worker.ts'),
    'import { reviewBatch } from "./batch.ts";\nexport function drain(jobs: number[]) { return reviewBatch(jobs, 100).flat(); }\n',
  );
  writeFileSync(
    join(workspace, 'src/policy.ts'),
    'export const policy = { capacity: 100, owner: "batch-worker" };\n',
  );
  const baseSha = commit('Initial queue');
  const probe = () =>
    JSON.parse(
      execFileSync(
        'node',
        [
          '--input-type=module',
          '-e',
          'import {drain} from "./src/worker.ts"; console.log(JSON.stringify(drain(Array.from({length:201},(_,i)=>i)).length))',
        ],
        { cwd: workspace, encoding: 'utf8' },
      ),
    );
  const baseCount = probe();
  writeFileSync(
    join(workspace, 'src/batch.ts'),
    'export function reviewBatch(jobs: number[], limit: number) {\n  return [jobs.slice(0, limit)];\n}\n',
  );
  writeFileSync(join(workspace, 'src/policy.ts'), 'export const policy = { capacity: 100 };\n');
  for (let i = 0; i < 45; i++)
    writeFileSync(
      join(workspace, `src/region_${i}.ts`),
      `export const capacities = [\n${Array.from({ length: 42 }, (_, j) => `  { id: ${j}, capacity: ${100 + j}, enabled: true },`).join('\n')}\n];\n`,
    );
  const firstHead = commit('Add region capacities and simplify queue partitioning');
  const headCount = probe();
  const reviewers = {
    control: (await import(pathToFileURL(join(control, 'src/shared/runner.ts')).href)).runPrReview,
    treatment: (await import('../src/shared/runner.ts')).runPrReview,
  };
  const run = async (arm: keyof typeof reviewers, name: string, priorBody = '') => {
    const headSha = git('rev-parse', 'HEAD');
    const files = parseGitDiff(git(...GIT_DIFF_ARGS, `${baseSha}...${headSha}`));
    const dir = join(output, name);
    mkdirSync(dir, { recursive: true });
    const priorReviews = priorBody
      ? [
          {
            id: 1,
            node_id: 'review-1',
            state: 'COMMENTED',
            body: priorBody,
            user: { login: 'jbot' },
          },
        ]
      : [];
    // Read-only fake GitHub state exercises the production path without posting or a token.
    const octokit = {
      rest: {
        pulls: {
          get: async () => ({ data: { state: 'open', merged: false, head: { sha: headSha } } }),
          listFiles: 'files',
          listReviews: 'reviews',
          listReviewComments: 'comments',
          listCommits: 'commits',
        },
        checks: { listForRef: 'checks' },
      },
      paginate: async (endpoint: string) => {
        if (endpoint === 'files') return files;
        if (endpoint === 'reviews') return priorReviews;
        if (endpoint === 'commits')
          return [
            { sha: headSha, commit: { message: 'Capacity rollout', author: { name: 'Fixture' } } },
          ];
        if (endpoint === 'comments' || endpoint === 'checks') return [];
        throw new Error(`Unexpected GitHub endpoint: ${endpoint}`);
      },
      graphql: async () => ({
        viewer: { login: 'jbot' },
        nodes: [],
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            closingIssuesReferences: { nodes: [], totalCount: 0 },
          },
        },
      }),
    } as unknown as Octokit;
    let result: Parameters<NonNullable<ReviewRunOptions['onReviewResult']>>[0] | undefined;
    let body = '';
    const started = Date.now();
    await reviewers[arm]({
      octokit,
      owner: 'fixture',
      repo: 'followup',
      pullNumber: 1,
      pullTitle: 'Add capacity tables and simplify queue partitioning',
      pullBody: 'Existing worker callers remain unchanged.',
      workspace,
      telemetryDirectory: dir,
      model,
      apiKey: process.env.CLINE_AUTH_JSON ?? '',
      baseRef: baseSha,
      baseSha,
      headSha,
      options: {
        dryRun: true,
        sdkEngine: 'opencode',
        skipUnchanged: false,
        reviewPasses: 2,
        dynamicFanout: true,
        enhancedContext: true,
        guidelinePass: true,
        verifyFindings: true,
        reviewShards: 1,
        maxConcurrentSessions: 3,
        timeBudgetMinutes: 10,
        experiment: reviewExperiment({
          JBOT_REVIEW_EXPERIMENT: arm === 'control' ? 'diff-batches' : 'adaptive',
        }),
        onReviewResult: (value: typeof result) => {
          result = value;
        },
      },
      log: (message: string) => {
        appendFileSync(join(dir, 'review.log'), message + '\n');
        if (message.startsWith('Dry run review body:\n'))
          body = message.slice('Dry run review body:\n'.length);
      },
    });
    const telemetry = readFileSync(join(dir, 'telemetry.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const row = {
      arm,
      name,
      durationMs: Date.now() - started,
      headSha,
      fixtureHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
      findings: result?.findings,
      incomplete: result?.incompleteSessions,
      phases: telemetry.filter((r) => r.kind === 'phase' && r.scope === 'run'),
      coverage: telemetry.filter((r) => r.kind === 'coverage'),
      origins: telemetry.filter((r) => r.kind === 'finding'),
      calls: telemetry.filter(
        (r) => r.kind === 'phase' && r.scope === 'session' && r.phase.endsWith('-execution'),
      ).length,
    };
    rows.push(row);
    writeFileSync(join(output, 'rows.json'), JSON.stringify(rows, null, 2));
    const reused = row.coverage.filter((r) => r.state === 'reused');
    if (arm === 'treatment' && name.startsWith('docs-') && reused.length !== 2)
      throw new Error('Invalid trial: both completed auxiliary passes must be reused.');
    if (name.startsWith('code-') && reused.length)
      throw new Error('Invalid trial: a code change reused auxiliary coverage.');
    if (result?.incompleteSessions?.length)
      throw new Error('Invalid trial: review coverage was incomplete.');
    console.log(
      JSON.stringify({
        name,
        durationMs: row.durationMs,
        calls: row.calls,
        findings: result?.findings.map((f) => ({
          path: f.path,
          title: f.title,
          uncertain: f.verificationUncertain,
        })),
      }),
    );
    return `${body}\n<!-- jbot-review:review -->`;
  };
  writeFileSync(
    join(output, 'manifest.json'),
    JSON.stringify(
      {
        control: revision(control),
        treatmentCommit: revision(root),
        model,
        repetitions: 3,
        baseCount,
        headCount,
        firstHead,
        qualityGate: 'Targeted follow-up experiment; not the full corpus.',
      },
      null,
      2,
    ),
  );
  const prior = await run('treatment', 'initial-treatment');
  writeFileSync(join(workspace, 'README.md'), 'Document the regional capacity rollout.\n');
  commit('Document rollout');
  for (let i = 1; i <= 3; i++)
    for (const arm of (i % 2
      ? ['control', 'treatment']
      : ['treatment', 'control']) as (keyof typeof reviewers)[])
      await run(arm, `docs-${arm}-${i}`, prior);
  writeFileSync(
    join(workspace, 'src/worker.ts'),
    'import { reviewBatch } from "./batch.ts";\nexport function drain(jobs: number[]) { return reviewBatch(jobs, 50).flat(); }\n',
  );
  commit('Change worker capacity');
  await run('control', 'code-control', prior);
  await run('treatment', 'code-treatment', prior);
} finally {
  if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(gitConfigDirectory, { recursive: true, force: true });
}
