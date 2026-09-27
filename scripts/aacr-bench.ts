// AACR-Bench external holdout: sample → run (jbot review:local per PR) → score (AACR judge).
//   npm run holdout:aacr -- sample --dataset D --out F [--per-language 1] [--seed 20260927]
//   npm run holdout:aacr -- run --dataset D --sample F --model M --out DIR [--concurrency 4] [--timeout-min 30]
//   npm run holdout:aacr -- score --dataset D --sample F --results DIR --judge-model M [--line-window 1] [--concurrency 4]
import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import {
  createCliProcessScope,
  onCliFatalSignal,
  runCliProcess,
} from '../src/shared/cli-process.ts';
import { parseBenchmarkTelemetry } from '../src/shared/benchmark-runner.ts';
import { PROVIDERS, providerCredentialSources } from '../src/shared/config.ts';
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
// meta.json is written last, so it marks a case whose outputs are all on disk.
const finished = (caseDir: string) =>
  existsSync(join(caseDir, 'jbot.json')) && existsSync(join(caseDir, 'meta.json'));
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
  const provider = PROVIDERS[parseModelName(model).providerID];
  const credentialEnv = Object.fromEntries(
    [
      ...(provider ? providerCredentialSources(provider).map((source) => source.env) : []),
      provider?.custom?.baseURL.env,
    ].flatMap((name) => (name && process.env[name] ? [[name, process.env[name]]] : [])),
  );
  mkdirSync(repos, { recursive: true });
  mkdirSync(join(out, 'official'), { recursive: true });
  const prepared = new Map<string, string>();
  // Resumable: finished instances are skipped; a fresh --out re-reviews them.
  for (const instance of instances.filter((i) => !finished(join(out, i.instanceId)))) {
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
  // Ctrl-C tears down every review's process group, not just its tsx wrapper.
  const processes = createCliProcessScope();
  const unregister = onCliFatalSignal(() => processes.stop());
  await pool(instances, Number(option('concurrency', '4')), async (instance) => {
    const repo = prepared.get(instance.instanceId);
    if (!repo) return;
    const worktree = mkdtempSync(join(tmpdir(), 'jbot-aacr-'));
    try {
      const caseDir = join(out, instance.instanceId);
      mkdirSync(caseDir, { recursive: true });
      const official = join(out, 'official', `${instance.instanceId}.json`);
      for (const stale of [join(caseDir, 'jbot.json'), join(caseDir, 'meta.json'), official])
        rmSync(stale, { force: true });
      rmSync(worktree, { recursive: true });
      git(repo, 'worktree', 'add', '--detach', worktree, instance.head);
      const log = createWriteStream(join(caseDir, 'review.log'));
      const started = Date.now();
      // A neutral launch dir keeps jbot's own .env out; only the provider's credentials pass through.
      const env = {
        PATH: process.env.PATH!,
        HOME: process.env.HOME!,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        ...credentialEnv,
        MODEL: model,
        JBOT_BENCHMARK_DRY_RUN: 'true',
        JBOT_BENCHMARK_OUTPUT: join(caseDir, 'jbot.json'),
      };
      let exit: { code: number | null; error?: string };
      try {
        const { exitCode } = await processes.run(instance.instanceId, () =>
          runCliProcess(
            join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx'),
            [
              join(PROJECT_ROOT, 'src', 'local', 'index.ts'),
              '--workspace',
              worktree,
              '--base',
              instance.base,
            ],
            { cwd: caseDir, env, timeoutMs, timeoutMessage: 'review timed out', output: log },
          ),
        );
        exit = { code: exitCode };
      } catch (error) {
        exit = { code: null, error: (error as Error).message };
      } finally {
        await new Promise((done) => log.end(done));
      }
      const wallMs = Date.now() - started;
      const output = join(caseDir, 'jbot.json');
      const result = existsSync(output)
        ? readJson<{ findings: Finding[]; telemetry?: string }>(output)
        : undefined;
      const usage = parseBenchmarkTelemetry(result?.telemetry);
      if (result)
        // Token totals follow OCR's accounting: input includes cache reads, output includes reasoning.
        writeFileSync(
          official,
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
      writeFileSync(
        join(caseDir, 'meta.json'),
        JSON.stringify({ ...exit, wallMs, findings: result?.findings.length }),
      );
      console.log(
        `${result ? 'done' : 'FAILED'} ${instance.instanceId} exit=${exit.code}${exit.error ? ` (${exit.error})` : ''} ${Math.round(wallMs / 1000)}s`,
      );
    } catch (error) {
      console.log(`FAILED ${instance.instanceId}: ${(error as Error).message.split('\n')[0]}`);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      git(repo, 'worktree', 'prune');
    }
  }).finally(unregister);
}

async function score() {
  const instances = sampledInstances();
  const results = resolve(required('results'));
  const judgeModel = required('judge-model');
  const lineWindow = option('line-window', '1')!;
  const evaluated = instances.filter((instance) => finished(join(results, instance.instanceId)));
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
      lineWindow === 'none' ? Infinity : Number(lineWindow),
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
      lineWindow,
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
