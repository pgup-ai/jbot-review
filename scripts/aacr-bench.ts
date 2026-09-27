// AACR-Bench external holdout: sample → run (jbot review:local per PR) → score (AACR judge).
//   npm run holdout:aacr -- sample --dataset D --out F [--per-language 1] [--seed 20260927]
//   npm run holdout:aacr -- run --dataset D --sample F --model M --out DIR [--concurrency 4] [--timeout-min 30]
//   npm run holdout:aacr -- score --dataset D --sample F --results DIR --judge-model M [--line-window 1] [--concurrency 4]
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseModelName } from '@symma/protocol';

import {
  parseAacrDataset,
  sampleAacrInstances,
  toJudgeComments,
  toOfficialResult,
  type AacrInstance,
} from '../src/shared/aacr-bench.ts';
import { judgeMetrics, scoreCases, type JudgeCounts } from '../src/shared/benchmark-judge.ts';
import { parseBenchmarkTelemetry } from '../src/shared/benchmark-runner.ts';
import { PROVIDERS } from '../src/shared/config.ts';
import { startOpencodeJudge } from '../src/shared/semantic-judge.ts';
import type { Finding } from '../src/shared/types.ts';
import { benchmarkArgument } from './benchmark-args.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const option = (name: string, fallback?: string) => benchmarkArgument(name) ?? fallback;
function required(name: string): string {
  const value = benchmarkArgument(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

function sampledInstances(): AacrInstance[] {
  const byId = new Map(
    parseAacrDataset(readJson(required('dataset'))).map((i) => [i.instanceId, i]),
  );
  return readJson<{ instanceId: string }[]>(required('sample')).map(({ instanceId }) => {
    const instance = byId.get(instanceId);
    if (!instance) throw new Error(`Sample instance ${instanceId} is not in the dataset.`);
    return instance;
  });
}

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function sample() {
  const instances = parseAacrDataset(readJson(required('dataset')));
  const picked = sampleAacrInstances(instances, {
    perLanguage: Number(option('per-language', '1')),
    seed: Number(option('seed', '20260927')),
  });
  const out = required('out');
  const manifest = picked.map(
    ({ instanceId, repo, prNumber, language, base, head, changeLines }) => ({
      instanceId,
      repo,
      prNumber,
      language,
      base,
      head,
      changeLines,
    }),
  );
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${picked.length} instances → ${out}`);
}

/** Treeless bare clone: merge-base works on history alone; head files arrive at checkout. */
function ensureCommits(repos: string, instance: AacrInstance): string {
  const dir = join(repos, instance.repo.replace('/', '__'));
  if (!existsSync(dir))
    git(
      repos,
      'clone',
      '--bare',
      '--filter=tree:0',
      `https://github.com/${instance.repo}.git`,
      dir,
    );
  // Reviews need source, not LFS payloads, and git-lfs may be absent: keep pointer files.
  for (const key of ['process', 'smudge', 'clean']) git(dir, 'config', `filter.lfs.${key}`, '');
  git(dir, 'config', 'filter.lfs.required', 'false');
  try {
    git(dir, 'fetch', '--filter=tree:0', 'origin', instance.base, instance.head);
  } catch {
    // A head only reachable from the PR ref cannot always be fetched by id.
    git(
      dir,
      'fetch',
      '--filter=tree:0',
      'origin',
      instance.base,
      `+refs/pull/${instance.prNumber}/head:refs/aacr/pr-${instance.prNumber}`,
    );
  }
  return dir;
}

async function run() {
  const instances = sampledInstances();
  const model = required('model');
  const out = resolve(required('out'));
  const repos = resolve(option('repos', join(PROJECT_ROOT, '.jbot-review', 'aacr', 'repos'))!);
  const timeoutMs = Number(option('timeout-min', '30')) * 60_000;
  const keyEnv = PROVIDERS[parseModelName(model).providerID]?.keyEnv;
  mkdirSync(repos, { recursive: true });
  mkdirSync(join(out, 'official'), { recursive: true });
  const prepared = new Map<string, string>();
  // Finished instances are kept, so an interrupted run resumes instead of re-reviewing.
  for (const instance of instances.filter(
    (i) => !existsSync(join(out, i.instanceId, 'jbot.json')),
  )) {
    const started = Date.now();
    try {
      prepared.set(instance.instanceId, ensureCommits(repos, instance));
      console.log(
        `fetched ${instance.instanceId} in ${Math.round((Date.now() - started) / 1000)}s`,
      );
    } catch (error) {
      console.log(
        `SETUP FAILED ${instance.instanceId}: ${(error as Error).message.split('\n')[0]}`,
      );
    }
  }
  await pool(instances, Number(option('concurrency', '4')), async (instance) => {
    const repo = prepared.get(instance.instanceId);
    if (!repo) return;
    const worktree = mkdtempSync(join(tmpdir(), 'jbot-aacr-'));
    try {
      const caseDir = join(out, instance.instanceId);
      mkdirSync(caseDir, { recursive: true });
      rmSync(worktree, { recursive: true });
      git(repo, 'worktree', 'add', '--detach', worktree, instance.head);
      const log = openSync(join(caseDir, 'review.log'), 'w');
      const started = Date.now();
      // A neutral launch dir keeps jbot's own .env out; only the model's key is passed through.
      const env = {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        ...(keyEnv && process.env[keyEnv] ? { [keyEnv]: process.env[keyEnv] } : {}),
        MODEL: model,
        JBOT_BENCHMARK_DRY_RUN: 'true',
        JBOT_BENCHMARK_OUTPUT: join(caseDir, 'jbot.json'),
      };
      const exit = await new Promise<{ code: number | null; timedOut: boolean }>((done) => {
        const child = spawn(
          join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
          [
            join(PROJECT_ROOT, 'src', 'local', 'index.ts'),
            '--workspace',
            worktree,
            '--base',
            instance.base,
          ],
          { cwd: caseDir, env, stdio: ['ignore', log, log] },
        );
        const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          closeSync(log);
          done({ code, timedOut: signal === 'SIGTERM' });
        });
      });
      const wallMs = Date.now() - started;
      const output = join(caseDir, 'jbot.json');
      const result = existsSync(output)
        ? readJson<{ findings: Finding[]; telemetry?: string }>(output)
        : undefined;
      const usage = parseBenchmarkTelemetry(result?.telemetry);
      writeFileSync(
        join(caseDir, 'meta.json'),
        JSON.stringify({ ...exit, wallMs, findings: result?.findings.length }),
      );
      if (result)
        // Token totals follow OCR's accounting: input includes cache reads, output includes reasoning.
        writeFileSync(
          join(out, 'official', `${instance.instanceId}.json`),
          JSON.stringify(
            toOfficialResult({
              instance,
              comments: toJudgeComments(result.findings),
              durationSeconds: wallMs / 1000,
              inputTokens: usage.inputTokens + usage.cacheReadTokens,
              outputTokens: usage.outputTokens + usage.reasoningTokens,
            }),
            null,
            2,
          ),
        );
      console.log(
        `${result ? 'done' : 'FAILED'} ${instance.instanceId} exit=${exit.code} ${Math.round(wallMs / 1000)}s`,
      );
    } catch (error) {
      console.log(`FAILED ${instance.instanceId}: ${(error as Error).message.split('\n')[0]}`);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      git(repo, 'worktree', 'prune');
    }
  });
}

async function score() {
  const instances = sampledInstances();
  const results = resolve(required('results'));
  const judgeModel = required('judge-model');
  const window = option('line-window', '1')!;
  const evaluated = instances.filter((instance) =>
    existsSync(join(results, instance.instanceId, 'jbot.json')),
  );
  const judge = await startOpencodeJudge(judgeModel, Number(option('concurrency', '4')));
  try {
    const cases = evaluated.map((instance) => ({
      caseId: instance.instanceId,
      references: instance.references,
      generated: toJudgeComments(
        readJson<{ findings: Finding[] }>(join(results, instance.instanceId, 'jbot.json')).findings,
      ),
    }));
    const scored = await scoreCases(
      cases,
      judge.sameConcern,
      window === 'none' ? Infinity : Number(window),
    );
    const language = new Map(instances.map((instance) => [instance.instanceId, instance.language]));
    const byLanguage: Record<string, JudgeCounts> = {};
    for (const item of scored.cases) {
      const sum = (byLanguage[language.get(item.caseId)!] ??= {
        expected: 0,
        generated: 0,
        lineMatched: 0,
        semanticMatched: 0,
      });
      for (const key of Object.keys(sum) as (keyof JudgeCounts)[]) sum[key] += item.counts[key];
    }
    const perCase = scored.cases.map((item) => ({
      ...item,
      meta: readJson(join(results, item.caseId, 'meta.json')),
      tokens: readJson<{ review: { summary: unknown } }>(
        join(results, 'official', `${item.caseId}.json`),
      ).review.summary,
    }));
    const expectedAll = instances.reduce((sum, instance) => sum + instance.references.length, 0);
    const summary = {
      generatedAt: new Date().toISOString(),
      judgeModel,
      lineWindow: window,
      sampled: instances.length,
      evaluated: evaluated.length,
      failed: instances.filter((i) => !evaluated.includes(i)).map((i) => i.instanceId),
      counts: scored.counts,
      metrics: scored.metrics,
      // Official metrics skip failed instances; this recall charges them as misses.
      allSampleRecall: expectedAll
        ? Math.round((scored.counts.semanticMatched / expectedAll) * 1000) / 1000
        : 0,
      byLanguage: Object.fromEntries(
        Object.entries(byLanguage).map(([key, counts]) => [
          key,
          { counts, metrics: judgeMetrics(counts) },
        ]),
      ),
      judge: judge.stats,
      perCase,
    };
    writeFileSync(join(results, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify({ ...summary, byLanguage: undefined, perCase: undefined }, null, 2));
  } finally {
    judge.stop();
  }
}

const commands: Record<string, () => unknown> = { sample, run, score };
const command = commands[process.argv[2] ?? ''];
if (!command)
  throw new Error(
    'Usage: holdout:aacr <sample|run|score> ... (see the header of scripts/aacr-bench.ts)',
  );
await command();
