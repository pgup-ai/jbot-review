import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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

import {
  BENCHMARK_SCHEMA_VERSION,
  assertBenchmarkComparable,
  scoreBenchmark,
  type BenchmarkCaseRun,
  type BenchmarkCacheState,
  type BenchmarkConfiguration,
  type BenchmarkDiffSize,
  type BenchmarkExpectedFinding,
  type BenchmarkObservedFinding,
  type BenchmarkRiskTier,
} from '../src/shared/benchmark-score.ts';
import { VALID_SEVERITIES } from '../src/shared/types.ts';

const execFileAsync = promisify(execFile);
const GITHUB_TOKEN_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'JBOT_GITHUB_TOKEN',
  'INPUT_GITHUB_TOKEN',
]);

interface BenchmarkRunner {
  command: string[];
  cwd: 'project' | 'workspace';
}

interface BenchmarkArm {
  name: string;
  configuration: BenchmarkConfiguration;
  env?: Record<string, string>;
}

interface BenchmarkCase {
  id: string;
  riskTier: BenchmarkRiskTier;
  cacheState: BenchmarkCacheState;
  diffSize: BenchmarkDiffSize;
  expectedClean: boolean;
  expectedFindings: BenchmarkExpectedFinding[];
  fixturePath?: string;
  repository?: string;
  base: string;
  head: string;
  tags?: string[];
}

interface BenchmarkManifest {
  schemaVersion: number;
  name: string;
  repetitions: number;
  timeoutMs: number;
  corpusHash: string;
  runner: BenchmarkRunner;
  declaredTreatmentVariables: string[];
  control: BenchmarkArm;
  treatment: BenchmarkArm;
  cases: BenchmarkCase[];
}

interface RunnerOutput {
  findings?: BenchmarkObservedFinding[];
  telemetry?: string;
  costUsd?: number;
}

interface ProgramMetrics {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  sessions: number;
}

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
  failureClass: 'timeout' | 'runner-exit' | 'spawn' | 'invalid-output' | 'missing-output' | null;
  program: ProgramMetrics;
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

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function readManifest(path: string): BenchmarkManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as BenchmarkManifest;
  if (parsed.schemaVersion !== BENCHMARK_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported benchmark manifest schema ${parsed.schemaVersion}; expected ${BENCHMARK_SCHEMA_VERSION}.`,
    );
  }
  if (!parsed.name?.trim() || !parsed.corpusHash?.startsWith('sha256:')) {
    throw new Error('Manifest requires a name and sha256 corpusHash.');
  }
  parsed.repetitions = requirePositiveInteger(parsed.repetitions, 'repetitions');
  parsed.timeoutMs = requirePositiveInteger(parsed.timeoutMs, 'timeoutMs');
  if (!Array.isArray(parsed.runner?.command) || parsed.runner.command.length === 0) {
    throw new Error('Manifest runner.command must be a non-empty argv array.');
  }
  if (!['project', 'workspace'].includes(parsed.runner.cwd)) {
    throw new Error('Manifest runner.cwd must be project or workspace.');
  }
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error('Manifest must contain at least one case.');
  }
  const ids = new Set<string>();
  for (const benchmarkCase of parsed.cases) {
    if (!benchmarkCase.id?.trim() || ids.has(benchmarkCase.id)) {
      throw new Error(`Benchmark case ids must be non-empty and unique: ${benchmarkCase.id}.`);
    }
    ids.add(benchmarkCase.id);
    if (Boolean(benchmarkCase.fixturePath) === Boolean(benchmarkCase.repository)) {
      throw new Error(`Case ${benchmarkCase.id} requires exactly one fixturePath or repository.`);
    }
    if (!benchmarkCase.base?.trim() || !benchmarkCase.head?.trim()) {
      throw new Error(`Case ${benchmarkCase.id} requires base and head identifiers.`);
    }
    if (
      benchmarkCase.repository &&
      (!/^[a-f0-9]{40}$/i.test(benchmarkCase.base) || !/^[a-f0-9]{40}$/i.test(benchmarkCase.head))
    ) {
      throw new Error(`Repository case ${benchmarkCase.id} requires immutable base/head SHAs.`);
    }
    if (!['low', 'medium', 'high', 'critical'].includes(benchmarkCase.riskTier)) {
      throw new Error(`Case ${benchmarkCase.id} has an invalid riskTier.`);
    }
    if (!['uncached', 'cached-same-head', 'cached-cross-run'].includes(benchmarkCase.cacheState)) {
      throw new Error(`Case ${benchmarkCase.id} has an invalid cacheState.`);
    }
    if (!['small', 'medium', 'large', 'very-large'].includes(benchmarkCase.diffSize)) {
      throw new Error(`Case ${benchmarkCase.id} has an invalid diffSize.`);
    }
    if (!Array.isArray(benchmarkCase.expectedFindings)) {
      throw new Error(`Case ${benchmarkCase.id} requires expectedFindings.`);
    }
    if (benchmarkCase.expectedClean && benchmarkCase.expectedFindings.length > 0) {
      throw new Error(`Clean case ${benchmarkCase.id} cannot declare expected findings.`);
    }
    const expectedIds = new Set<string>();
    for (const finding of benchmarkCase.expectedFindings) {
      if (
        !finding.id?.trim() ||
        expectedIds.has(finding.id) ||
        !VALID_SEVERITIES.has(finding.severity) ||
        !Array.isArray(finding.anchors) ||
        finding.anchors.length === 0 ||
        finding.anchors.some(
          (anchor) => !anchor.path?.trim() || !Number.isInteger(anchor.line) || anchor.line < 0,
        )
      ) {
        throw new Error(`Case ${benchmarkCase.id} has an invalid expected finding.`);
      }
      expectedIds.add(finding.id);
    }
  }
  for (const arm of [parsed.control, parsed.treatment]) {
    for (const key of Object.keys(arm.env ?? {})) {
      if (GITHUB_TOKEN_KEYS.has(key.toUpperCase())) {
        throw new Error(`Benchmark arm ${arm.name} may not set GitHub credential ${key}.`);
      }
    }
  }
  assertBenchmarkComparable(
    parsed.control.configuration,
    parsed.treatment.configuration,
    parsed.declaredTreatmentVariables,
  );
  if (
    parsed.control.configuration.corpusHash !== parsed.corpusHash ||
    parsed.treatment.configuration.corpusHash !== parsed.corpusHash
  ) {
    throw new Error('Both benchmark arms must use the manifest corpusHash.');
  }
  return parsed;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeCorpusHash(manifest: BenchmarkManifest, manifestDir: string): string {
  const hash = createHash('sha256');
  hash.update(stable(manifest.cases));
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

function parseTelemetry(telemetry: string | undefined): ProgramMetrics {
  const metrics: ProgramMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    sessions: 0,
  };
  if (!telemetry) return metrics;
  for (const line of telemetry.split('\n').filter(Boolean)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.kind !== 'session') continue;
    metrics.sessions += 1;
    for (const key of [
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cacheReadTokens',
    ] as const) {
      if (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0) {
        metrics[key] += row[key];
      }
    }
    const cost =
      typeof row.costUsd === 'number'
        ? row.costUsd
        : typeof row.estimatedCostUsd === 'number'
          ? row.estimatedCostUsd
          : 0;
    if (Number.isFinite(cost) && cost >= 0) metrics.costUsd += cost;
  }
  return metrics;
}

function validRunnerOutput(value: unknown): value is RunnerOutput {
  if (!value || typeof value !== 'object') return false;
  const output = value as RunnerOutput;
  if (output.telemetry !== undefined && typeof output.telemetry !== 'string') return false;
  if (output.costUsd !== undefined && (!Number.isFinite(output.costUsd) || output.costUsd < 0)) {
    return false;
  }
  return (
    output.findings === undefined ||
    (Array.isArray(output.findings) &&
      output.findings.every(
        (finding) =>
          typeof finding.path === 'string' &&
          Number.isInteger(finding.line) &&
          finding.line >= 0 &&
          VALID_SEVERITIES.has(finding.severity) &&
          typeof finding.title === 'string' &&
          (finding.fingerprint === undefined || typeof finding.fingerprint === 'string') &&
          (finding.expectedFindingId === undefined ||
            typeof finding.expectedFindingId === 'string') &&
          (finding.retained === undefined || typeof finding.retained === 'boolean') &&
          (finding.anchored === undefined || typeof finding.anchored === 'boolean'),
      ))
  );
}

async function prepareWorkspace(
  benchmarkCase: BenchmarkCase,
  manifestDir: string,
  root: string,
): Promise<{ workspace: string; fixture: string; cleanup: () => Promise<void> }> {
  const workspace = join(root, 'workspace');
  if (benchmarkCase.repository) {
    const repository = resolve(manifestDir, benchmarkCase.repository);
    const cleanup = async () => {
      try {
        await execFileAsync('git', ['-C', repository, 'worktree', 'remove', '--force', workspace]);
      } catch {}
    };
    try {
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
    } catch (error) {
      await cleanup();
      throw error;
    }
    return { workspace, fixture: '', cleanup };
  }

  mkdirSync(workspace, { recursive: true });
  const source = resolve(manifestDir, benchmarkCase.fixturePath!);
  const fixture = join(workspace, 'fixture.json');
  cpSync(source, fixture, { recursive: true });
  return { workspace, fixture, cleanup: async () => undefined };
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
  mkdirSync(home, { recursive: true });
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const checkout = await prepareWorkspace(benchmarkCase, manifestDir, root);
    cleanup = checkout.cleanup;
    const paths = { projectRoot, workspace: checkout.workspace, output, fixture: checkout.fixture };
    const command = manifest.runner.command.map((value) => expand(value, paths));
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of GITHUB_TOKEN_KEYS) delete env[key];
    Object.assign(env, arm.env ?? {}, {
      HOME: home,
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      JBOT_BENCHMARK_DRY_RUN: 'true',
      JBOT_BENCHMARK_OUTPUT: output,
      JBOT_BENCHMARK_ARM: side,
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
      const failure = error as NodeJS.ErrnoException & {
        code?: string | number;
        signal?: string;
        killed?: boolean;
      };
      exitCode = typeof failure.code === 'number' ? failure.code : null;
      signal = failure.signal ?? null;
      timedOut = Boolean(failure.killed && signal === 'SIGTERM');
      failureClass = timedOut
        ? 'timeout'
        : typeof failure.code === 'number'
          ? 'runner-exit'
          : 'spawn';
    }
    const latencyMs = performance.now() - started;

    let result: RunnerOutput = {};
    if (existsSync(output)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(output, 'utf8'));
        if (!validRunnerOutput(parsed)) throw new Error('invalid benchmark runner output');
        result = parsed;
      } catch {
        exitCode = exitCode || 1;
        failureClass = 'invalid-output';
      }
    } else if (exitCode === 0) {
      exitCode = 1;
      failureClass = 'missing-output';
    }

    const program = parseTelemetry(result.telemetry);
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
      findings: Array.isArray(result.findings) ? result.findings : [],
      latencyMs,
      costUsd: result.costUsd ?? program.costUsd,
      exitCode,
      signal,
      timedOut,
      failureClass,
      program,
    };
    return row;
  } finally {
    await cleanup?.();
    rmSync(root, { recursive: true, force: true });
  }
}

function sumProgram(rows: CaseRow[]): ProgramMetrics {
  return rows.reduce<ProgramMetrics>(
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
  const score = (subset: CaseRow[]) => scoreBenchmark(subset);
  return {
    runs: rows.length,
    successfulRuns: rows.filter((row) => row.exitCode === 0).length,
    timedOutRuns: rows.filter((row) => row.timedOut).length,
    program: sumProgram(rows),
    score: score(rows),
    byRiskTier: Object.fromEntries(
      (['low', 'medium', 'high', 'critical'] as BenchmarkRiskTier[]).map((tier) => [
        tier,
        score(rows.filter((row) => row.riskTier === tier)),
      ]),
    ),
    byCacheState: Object.fromEntries(
      (['uncached', 'cached-same-head', 'cached-cross-run'] as BenchmarkCacheState[]).map(
        (state) => [state, score(rows.filter((row) => row.cacheState === state))],
      ),
    ),
    byDiffSize: Object.fromEntries(
      (['small', 'medium', 'large', 'very-large'] as BenchmarkDiffSize[]).map((size) => [
        size,
        score(rows.filter((row) => row.diffSize === size)),
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
    ? requirePositiveInteger(repetitionsArg, '--repetitions')
    : manifest.repetitions;
  if (existsSync(join(outputDir, 'summary.json')) || existsSync(join(outputDir, 'cases.jsonl'))) {
    throw new Error(`Output directory already contains benchmark results: ${outputDir}.`);
  }
  mkdirSync(outputDir, { recursive: true });
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
        console.log(
          `${side.padEnd(9)} ${benchmarkCase.id} #${repetition}: exit=${row.exitCode ?? row.signal} ${Math.round(row.latencyMs)}ms`,
        );
      }
    }
  }

  writeFileSync(
    join(outputDir, 'cases.jsonl'),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
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
  console.log(`Wrote ${join(outputDir, 'summary.json')} and ${join(outputDir, 'cases.jsonl')}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
