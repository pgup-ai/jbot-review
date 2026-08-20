import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { onFatalSignal } from '@symma/protocol';

import {
  BENCHMARK_SCHEMA_VERSION,
  benchmarkCanonicalJson,
  characterizeBenchmarkVariance,
  evaluateBenchmarkQualityGate,
  scoreBenchmark,
  type BenchmarkCacheState,
  type BenchmarkDiffSize,
  type BenchmarkRiskTier,
} from '../src/shared/benchmark-score.ts';
import {
  validateAdjudicatedBenchmarkRows,
  type BenchmarkCaseRow,
} from '../src/shared/benchmark-rescore.ts';
import {
  BENCHMARK_RELEASE_SUBSETS,
  selectBenchmarkSubset,
  type BenchmarkReleaseSubset,
} from '../src/shared/benchmark-corpus.ts';
import { materializeBenchmarkFixture } from '../src/shared/benchmark-fixture.ts';
import {
  isBenchmarkGitHubCredential,
  parseBenchmarkPositiveInteger,
  validateBenchmarkManifest,
  type BenchmarkArm,
  type BenchmarkCase,
  type BenchmarkManifest,
} from '../src/shared/benchmark-manifest.ts';
import {
  classifyBenchmarkProcessFailure,
  emptyBenchmarkProgramMetrics,
  isBenchmarkRunnerOutput,
  parseBenchmarkTelemetry,
  type BenchmarkProgramMetrics,
  type BenchmarkRunnerOutput,
} from '../src/shared/benchmark-runner.ts';
import { benchmarkArgument } from './benchmark-args.ts';

const execFileAsync = promisify(execFile);
const GIT_REPOSITORY_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

function usage(): never {
  console.error(
    'usage: review-benchmark.ts --manifest <manifest.json> --output <directory> [--repetitions <n>] [--subset <smoke|core|full>] [--adjudicated-cases <cases.jsonl>]',
  );
  process.exit(2);
}

function readManifest(path: string): BenchmarkManifest {
  return validateBenchmarkManifest(JSON.parse(readFileSync(path, 'utf8')));
}

function computeCorpusHash(manifest: BenchmarkManifest, manifestDir: string): string {
  const hash = createHash('sha256');
  hash.update(benchmarkCanonicalJson(manifest.cases));
  for (const fixture of [...new Set(manifest.cases.map((item) => item.fixturePath).filter(Boolean))]
    .map((path) => resolve(manifestDir, path!))
    .sort()) {
    hashFixture(hash, fixture, fixture);
  }
  return `sha256:${hash.digest('hex')}`;
}

function hashFixture(hash: ReturnType<typeof createHash>, root: string, path: string): void {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path).sort()) hashFixture(hash, root, join(path, entry));
    return;
  }
  hash.update(path.slice(root.length));
  hash.update(readFileSync(path));
}

function expand(value: string, paths: Record<string, string>): string {
  return value.replace(
    /\$\{(projectRoot|workspace|output|fixture)\}/g,
    (_, key: string) => paths[key],
  );
}

async function prepareWorkspace(
  benchmarkCase: BenchmarkCase,
  manifestDir: string,
  root: string,
  fixtureMode: BenchmarkManifest['runner']['fixtureMode'],
): Promise<{ workspace: string; fixture: string; base?: string; cleanup: () => void }> {
  const workspace = join(root, 'workspace');
  const repository = benchmarkCase.repository
    ? resolve(manifestDir, benchmarkCase.repository)
    : undefined;
  const discard = (): void => {
    if (repository) {
      const removal = spawnSync(
        'git',
        ['-C', repository, 'worktree', 'remove', '--force', workspace],
        {
          stdio: 'ignore',
        },
      );
      if (removal.error || removal.status !== 0) {
        console.warn(`warning: worktree cleanup failed for ${benchmarkCase.id}.`);
      }
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      console.warn(`warning: temporary directory cleanup failed for ${benchmarkCase.id}.`);
    }
  };
  const unregister = onFatalSignal(discard);
  const cleanup = (): void => {
    unregister();
    discard();
  };
  try {
    if (repository) {
      await execFileAsync('git', [
        '-C',
        repository,
        'worktree',
        'add',
        '--detach',
        '--quiet',
        workspace,
        benchmarkCase.head,
      ]);
      return { workspace, fixture: '', cleanup };
    }

    mkdirSync(workspace, { recursive: true });
    const source = benchmarkCase.privateCaseHash
      ? resolvePrivateCase(benchmarkCase.privateCaseHash)
      : resolve(manifestDir, benchmarkCase.fixturePath!);
    if (fixtureMode === 'git') {
      const gitHome = join(root, 'git-home');
      mkdirSync(join(gitHome, 'templates'), { recursive: true });
      const gitEnv = fixtureGitEnvironment(gitHome);
      const files = materializeBenchmarkFixture(
        JSON.parse(readFileSync(source, 'utf8')),
        benchmarkCase.id,
      );
      for (const file of files) writeFixtureFile(workspace, file.path, file.base);
      const git = fixtureGitPrefix(workspace, gitEnv);
      await execFileAsync('git', [...git, 'init', '--quiet'], { env: gitEnv });
      await commitFixture(workspace, 'base', gitEnv, true);
      const base = (
        await execFileAsync('git', [...git, 'rev-parse', 'HEAD'], { env: gitEnv })
      ).stdout.trim();
      for (const file of files) writeFixtureFile(workspace, file.path, file.head);
      await commitFixture(workspace, 'head', gitEnv);
      return { workspace, fixture: '', base, cleanup };
    }
    const fixture = join(workspace, 'fixture.json');
    cpSync(source, fixture, { recursive: true });
    return { workspace, fixture, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function writeFixtureFile(workspace: string, path: string, content: string | null): void {
  const destination = resolve(workspace, path);
  const local = relative(workspace, destination);
  if (!local || local.startsWith('..') || isAbsolute(local)) {
    throw new Error(`Fixture path escapes the benchmark workspace: ${path}.`);
  }
  if (content === null) {
    rmSync(destination, { force: true });
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function fixtureGitEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TEMPLATE_DIR: join(home, 'templates'),
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS$)/.test(key) || GIT_REPOSITORY_ENV.has(key)) {
      delete env[key];
    }
  }
  return env;
}

function fixtureGitPrefix(workspace: string, env: NodeJS.ProcessEnv): string[] {
  return ['-c', `core.hooksPath=${env.GIT_TEMPLATE_DIR}`, '-C', workspace];
}

async function commitFixture(
  workspace: string,
  message: string,
  env: NodeJS.ProcessEnv,
  allowEmpty = false,
): Promise<void> {
  const prefix = fixtureGitPrefix(workspace, env);
  await execFileAsync('git', [...prefix, 'add', '--all'], { env });
  await execFileAsync(
    'git',
    [
      ...prefix,
      '-c',
      'user.name=J-Bot Benchmark',
      '-c',
      'user.email=benchmark@invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--quiet',
      ...(allowEmpty ? ['--allow-empty'] : []),
      '-m',
      message,
    ],
    { env },
  );
}

function resolvePrivateCase(contentHash: string): string {
  const root = process.env.JBOT_BENCHMARK_PRIVATE_CASE_ROOT?.trim();
  if (!root) throw new Error('JBOT_BENCHMARK_PRIVATE_CASE_ROOT is required for private cases.');
  const digest = contentHash.slice('sha256:'.length).toLowerCase();
  const path = resolve(root, `${digest}.json`);
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== digest) throw new Error('Private benchmark case hash mismatch.');
  return path;
}

async function runCase(
  benchmarkCase: BenchmarkCase,
  side: 'control' | 'treatment',
  arm: BenchmarkArm,
  repetition: number,
  manifest: BenchmarkManifest,
  manifestDir: string,
  projectRoot: string,
): Promise<BenchmarkCaseRow> {
  const root = await mkdtemp(join(tmpdir(), 'jbot-review-benchmark-'));
  const home = join(root, 'home');
  const output = join(root, 'result.json');
  let cleanup: (() => void) | undefined;
  try {
    const setupStarted = performance.now();
    let checkout: Awaited<ReturnType<typeof prepareWorkspace>>;
    try {
      checkout = await prepareWorkspace(
        benchmarkCase,
        manifestDir,
        root,
        manifest.runner.fixtureMode,
      );
    } catch {
      console.warn(`warning: workspace setup failed for ${benchmarkCase.id}.`);
      return {
        schemaVersion: BENCHMARK_SCHEMA_VERSION,
        arm: side,
        armName: arm.name,
        repetition,
        base: benchmarkCase.base,
        head: benchmarkCase.head,
        caseId: benchmarkCase.id,
        riskTier: benchmarkCase.riskTier,
        cacheState: benchmarkCase.cacheState,
        diffSize: benchmarkCase.diffSize,
        expectedClean: benchmarkCase.expectedClean,
        expectedFindings: benchmarkCase.expectedFindings,
        findings: [],
        latencyMs: performance.now() - setupStarted,
        costUsd: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
        failureClass: 'setup',
        program: emptyBenchmarkProgramMetrics(),
      };
    }
    cleanup = checkout.cleanup;
    mkdirSync(home, { recursive: true });
    const paths = { projectRoot, workspace: checkout.workspace, output, fixture: checkout.fixture };
    const command = manifest.runner.command.map((value) => expand(value, paths));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (isBenchmarkGitHubCredential(key)) delete env[key];
    }
    Object.assign(env, arm.env ?? {}, {
      HOME: home,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      JBOT_BENCHMARK_DRY_RUN: 'true',
      JBOT_BENCHMARK_OUTPUT: output,
      JBOT_BENCHMARK_CASE: benchmarkCase.id,
      JBOT_BENCHMARK_FIXTURE: checkout.fixture,
      JBOT_LOCAL_BASE: checkout.base ?? benchmarkCase.base,
      JBOT_LOCAL_REPORT: 'false',
    });

    const started = performance.now();
    let exitCode: number | null = 0;
    let signal: string | null = null;
    let timedOut = false;
    let failureClass: BenchmarkCaseRow['failureClass'] = null;
    try {
      await execFileAsync(command[0], command.slice(1), {
        cwd: manifest.runner.cwd === 'project' ? projectRoot : checkout.workspace,
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: manifest.timeoutMs,
      });
    } catch (error) {
      ({ exitCode, signal, timedOut, failureClass } = classifyBenchmarkProcessFailure(error));
    }
    const latencyMs = performance.now() - started;

    let result: BenchmarkRunnerOutput | undefined;
    if (existsSync(output)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(output, 'utf8'));
        if (!isBenchmarkRunnerOutput(parsed)) throw new Error('invalid benchmark runner output');
        result = parsed;
      } catch {
        if (failureClass === null) {
          exitCode = 1;
          failureClass = 'invalid-output';
        }
      }
    } else if (exitCode === 0) {
      exitCode = 1;
      failureClass = 'missing-output';
    }

    const program = parseBenchmarkTelemetry(result?.telemetry);
    const row: BenchmarkCaseRow = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      arm: side,
      armName: arm.name,
      repetition,
      base: benchmarkCase.base,
      head: benchmarkCase.head,
      caseId: benchmarkCase.id,
      riskTier: benchmarkCase.riskTier,
      cacheState: benchmarkCase.cacheState,
      diffSize: benchmarkCase.diffSize,
      expectedClean: benchmarkCase.expectedClean,
      expectedFindings: benchmarkCase.expectedFindings,
      findings: result?.findings ?? [],
      latencyMs,
      costUsd: result?.costUsd ?? program.costUsd,
      exitCode,
      signal,
      timedOut,
      failureClass,
      program,
    };
    return row;
  } finally {
    cleanup?.();
  }
}

function sumProgram(rows: BenchmarkCaseRow[]): BenchmarkProgramMetrics {
  return rows.reduce<BenchmarkProgramMetrics>(
    (sum, row) => ({
      inputTokens: sum.inputTokens + row.program.inputTokens,
      outputTokens: sum.outputTokens + row.program.outputTokens,
      reasoningTokens: sum.reasoningTokens + row.program.reasoningTokens,
      cacheReadTokens: sum.cacheReadTokens + row.program.cacheReadTokens,
      costUsd: sum.costUsd + row.program.costUsd,
      sessions: sum.sessions + row.program.sessions,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      sessions: 0,
    },
  );
}

function summarize(rows: BenchmarkCaseRow[]) {
  const successful = rows.filter((row) => row.failureClass === null);
  const score = (subset: BenchmarkCaseRow[]) => scoreBenchmark(subset);
  return {
    runs: rows.length,
    successfulRuns: successful.length,
    failedRuns: rows.length - successful.length,
    timedOutRuns: rows.filter((row) => row.timedOut).length,
    program: sumProgram(rows),
    variance: characterizeBenchmarkVariance(successful),
    score: score(successful),
    byRiskTier: Object.fromEntries(
      (['low', 'medium', 'high', 'critical'] as BenchmarkRiskTier[]).map((tier) => [
        tier,
        score(successful.filter((row) => row.riskTier === tier)),
      ]),
    ),
    byCacheState: Object.fromEntries(
      (['uncached', 'cached-same-head', 'cached-cross-run'] as BenchmarkCacheState[]).map(
        (state) => [state, score(successful.filter((row) => row.cacheState === state))],
      ),
    ),
    byDiffSize: Object.fromEntries(
      (['small', 'medium', 'large', 'very-large'] as BenchmarkDiffSize[]).map((size) => [
        size,
        score(successful.filter((row) => row.diffSize === size)),
      ]),
    ),
  };
}

async function main(): Promise<void> {
  const manifestArg = benchmarkArgument('manifest');
  const outputArg = benchmarkArgument('output');
  if (!manifestArg || !outputArg) usage();
  const manifestPath = resolve(manifestArg);
  const outputDir = resolve(outputArg);
  const manifest = readManifest(manifestPath);
  const manifestDir = dirname(manifestPath);
  const computedCorpusHash = computeCorpusHash(manifest, manifestDir);
  if (computedCorpusHash !== manifest.corpusHash) {
    throw new Error(
      `Corpus hash mismatch: manifest=${manifest.corpusHash}, computed=${computedCorpusHash}.`,
    );
  }
  const repetitionsArg = benchmarkArgument('repetitions');
  const repetitions = repetitionsArg
    ? parseBenchmarkPositiveInteger(repetitionsArg, '--repetitions')
    : manifest.repetitions;
  const subsetArg = benchmarkArgument('subset') ?? 'full';
  if (!BENCHMARK_RELEASE_SUBSETS.includes(subsetArg as BenchmarkReleaseSubset)) {
    throw new Error(`Unsupported benchmark subset: ${subsetArg}.`);
  }
  const subset = subsetArg as BenchmarkReleaseSubset;
  const benchmarkCases = selectBenchmarkSubset(manifest.cases, subset);
  if (benchmarkCases.length === 0) throw new Error(`Benchmark subset ${subset} is empty.`);
  if (existsSync(join(outputDir, 'summary.json')) || existsSync(join(outputDir, 'cases.jsonl'))) {
    throw new Error(`Output directory already contains benchmark results: ${outputDir}.`);
  }
  mkdirSync(outputDir, { recursive: true });
  const casesPath = join(outputDir, 'cases.jsonl');
  writeFileSync(casesPath, '');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const adjudicatedCasesArg = benchmarkArgument('adjudicated-cases');
  const rows: BenchmarkCaseRow[] = adjudicatedCasesArg
    ? validateAdjudicatedBenchmarkRows(
        readFileSync(resolve(adjudicatedCasesArg), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
        benchmarkCases,
        { control: manifest.control, treatment: manifest.treatment },
        repetitions,
      )
    : [];

  if (adjudicatedCasesArg) {
    for (const row of rows) appendFileSync(casesPath, `${JSON.stringify(row)}\n`);
  } else {
    for (const benchmarkCase of benchmarkCases) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const [side, arm] of [
          ['control', manifest.control],
          ['treatment', manifest.treatment],
        ] as const) {
          const row = await runCase(
            benchmarkCase,
            side,
            arm,
            repetition,
            manifest,
            manifestDir,
            projectRoot,
          );
          rows.push(row);
          appendFileSync(casesPath, `${JSON.stringify(row)}\n`);
          console.log(
            `${side.padEnd(9)} ${benchmarkCase.id} #${repetition}: exit=${row.exitCode ?? row.signal ?? row.failureClass} ${Math.round(row.latencyMs)}ms`,
          );
        }
      }
    }
  }

  const controlSummary = summarize(rows.filter((row) => row.arm === 'control'));
  const treatmentSummary = summarize(rows.filter((row) => row.arm === 'treatment'));
  const qualityGate = evaluateBenchmarkQualityGate(
    controlSummary.score,
    treatmentSummary.score,
    0.02,
    {
      controlSuccessfulRuns: controlSummary.successfulRuns,
      treatmentSuccessfulRuns: treatmentSummary.successfulRuns,
      treatmentFailedRuns: treatmentSummary.failedRuns,
    },
  );
  const summary = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    manifest: manifestPath,
    name: manifest.name,
    corpusHash: manifest.corpusHash,
    subset,
    subsetCases: benchmarkCases.length,
    repetitions,
    declaredTreatmentVariables: manifest.declaredTreatmentVariables,
    control: {
      name: manifest.control.name,
      configuration: manifest.control.configuration,
      ...controlSummary,
    },
    treatment: {
      name: manifest.treatment.name,
      configuration: manifest.treatment.configuration,
      ...treatmentSummary,
    },
    qualityGate,
  };
  writeFileSync(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${join(outputDir, 'summary.json')} and ${casesPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
