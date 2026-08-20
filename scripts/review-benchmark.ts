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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { onFatalSignal } from '@symma/protocol';

import {
  BENCHMARK_SCHEMA_VERSION,
  benchmarkCanonicalJson,
  characterizeBenchmarkVariance,
  evaluateBenchmarkQualityGate,
  scoreBenchmark,
  type BenchmarkCaseRun,
  type BenchmarkCacheState,
  type BenchmarkDiffSize,
  type BenchmarkRiskTier,
} from '../src/shared/benchmark-score.ts';
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
  type BenchmarkFailureClass,
  type BenchmarkProgramMetrics,
  type BenchmarkRunnerOutput,
} from '../src/shared/benchmark-runner.ts';
import { benchmarkArgument } from './benchmark-args.ts';

const execFileAsync = promisify(execFile);

interface CaseRow extends BenchmarkCaseRun {
  schemaVersion: number;
  arm: 'control' | 'treatment';
  armName: string;
  repetition: number;
  base: string;
  head: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  failureClass: BenchmarkFailureClass | null;
  program: BenchmarkProgramMetrics;
}

function usage(): never {
  console.error(
    'usage: review-benchmark.ts --manifest <manifest.json> --output <directory> [--repetitions <n>] [--subset <smoke|core|full>]',
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
      const files = materializeBenchmarkFixture(
        JSON.parse(readFileSync(source, 'utf8')),
        benchmarkCase.id,
      );
      for (const file of files) writeFixtureFile(workspace, file.path, file.base);
      await execFileAsync('git', ['-C', workspace, 'init', '--quiet']);
      await commitFixture(workspace, 'base');
      const base = (
        await execFileAsync('git', ['-C', workspace, 'rev-parse', 'HEAD'])
      ).stdout.trim();
      for (const file of files) writeFixtureFile(workspace, file.path, file.head);
      await commitFixture(workspace, 'head');
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

function writeFixtureFile(workspace: string, path: string, content: string): void {
  const destination = join(workspace, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

async function commitFixture(workspace: string, message: string): Promise<void> {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  };
  await execFileAsync('git', ['-C', workspace, 'add', '--all'], { env });
  await execFileAsync(
    'git',
    [
      '-C',
      workspace,
      '-c',
      'user.name=J-Bot Benchmark',
      '-c',
      'user.email=benchmark@invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--quiet',
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
): Promise<CaseRow> {
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
    let failureClass: CaseRow['failureClass'] = null;
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
    const row: CaseRow = {
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

function sumProgram(rows: CaseRow[]): BenchmarkProgramMetrics {
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

function summarize(rows: CaseRow[]) {
  const successful = rows.filter((row) => row.failureClass === null);
  const score = (subset: CaseRow[]) => scoreBenchmark(subset);
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
  const rows: CaseRow[] = [];

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

  const controlSummary = summarize(rows.filter((row) => row.arm === 'control'));
  const treatmentSummary = summarize(rows.filter((row) => row.arm === 'treatment'));
  const qualityGate = evaluateBenchmarkQualityGate(controlSummary.score, treatmentSummary.score);
  if (
    treatmentSummary.failedRuns > 0 ||
    treatmentSummary.successfulRuns !== controlSummary.successfulRuns
  ) {
    qualityGate.passed = false;
    qualityGate.reasons.push('treatment did not complete the control run population');
  }
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
