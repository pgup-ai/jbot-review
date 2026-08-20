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
  scoreBenchmark,
  type BenchmarkCaseRun,
  type BenchmarkCacheState,
  type BenchmarkDiffSize,
  type BenchmarkRiskTier,
} from '../src/shared/benchmark-score.ts';
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
    'usage: review-benchmark.ts --manifest <manifest.json> --output <directory> [--repetitions <n>]',
  );
  process.exit(2);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  return process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
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
): Promise<{ workspace: string; fixture: string; cleanup: () => void }> {
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
    const source = resolve(manifestDir, benchmarkCase.fixturePath!);
    const fixture = join(workspace, 'fixture.json');
    cpSync(source, fixture, { recursive: true });
    return { workspace, fixture, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
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
      checkout = await prepareWorkspace(benchmarkCase, manifestDir, root);
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
      JBOT_LOCAL_BASE: benchmarkCase.base,
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
  const manifestArg = argument('manifest');
  const outputArg = argument('output');
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
  const repetitionsArg = argument('repetitions');
  const repetitions = repetitionsArg
    ? parseBenchmarkPositiveInteger(repetitionsArg, '--repetitions')
    : manifest.repetitions;
  if (existsSync(join(outputDir, 'summary.json')) || existsSync(join(outputDir, 'cases.jsonl'))) {
    throw new Error(`Output directory already contains benchmark results: ${outputDir}.`);
  }
  mkdirSync(outputDir, { recursive: true });
  const casesPath = join(outputDir, 'cases.jsonl');
  writeFileSync(casesPath, '');
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const rows: CaseRow[] = [];

  for (const benchmarkCase of manifest.cases) {
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

  const summary = {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    manifest: manifestPath,
    name: manifest.name,
    corpusHash: manifest.corpusHash,
    repetitions,
    declaredTreatmentVariables: manifest.declaredTreatmentVariables,
    control: {
      name: manifest.control.name,
      configuration: manifest.control.configuration,
      ...summarize(rows.filter((row) => row.arm === 'control')),
    },
    treatment: {
      name: manifest.treatment.name,
      configuration: manifest.treatment.configuration,
      ...summarize(rows.filter((row) => row.arm === 'treatment')),
    },
  };
  writeFileSync(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Wrote ${join(outputDir, 'summary.json')} and ${casesPath}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
