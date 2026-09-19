import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../src/local/util.ts';
import { parseBenchmarkTelemetry } from '../src/shared/benchmark-runner.ts';
import type { ReviewResult } from '../src/shared/types.ts';

type Case = {
  id: string;
  workspace: string;
  base: string;
  head: string;
  pr?: string;
  findings?: string;
};
type Arm = 'off' | 'deterministic' | 'on';
type Plan = {
  seed: string;
  model: string;
  cases: Case[];
  repetitions?: number;
  evidence?: boolean;
  docs?: string;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const planPath = process.argv[2];
if (!planPath) throw new Error('Usage: tsx scripts/jev-prefetch-experiment.ts <plan.json>');
const plan: Plan = JSON.parse(readFileSync(planPath, 'utf8'));
if (!plan.seed || !plan.model || !plan.cases.length) throw new Error('Expected a seeded plan');
const out = resolve(dirname(planPath), 'runs');
if (existsSync(out))
  throw new Error('Run directory already exists; preserve it and use a fresh plan directory');
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const git = (workspace: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
function checkCase(c: Case) {
  if (
    !/^[a-z0-9-]+$/.test(c.id) ||
    !/^[a-f0-9]{40}$/.test(c.base) ||
    !/^[a-f0-9]{40}$/.test(c.head)
  )
    throw new Error('Cases need safe ids and immutable base/head SHAs');
  if (git(c.workspace, 'rev-parse', 'HEAD') !== c.head || git(c.workspace, 'status', '--porcelain'))
    throw new Error(`Case changed: ${c.id}`);
  if (git(c.workspace, 'merge-base', c.base, c.head) !== c.base)
    throw new Error(`Base is not the merge base: ${c.id}`);
}
plan.cases.forEach(checkCase);
const driverHead = git(root, 'rev-parse', 'HEAD');
const runtimeHash = () =>
  hash(
    execFileSync('git', ['diff', 'HEAD', '--', 'src', 'scripts', 'package-lock.json'], {
      cwd: root,
    }),
  );
const initialRuntimeHash = runtimeHash();
const inputHashes = () =>
  Object.fromEntries(
    [
      ...(plan.docs ? [plan.docs] : []),
      ...plan.cases.flatMap((c) => (c.findings ? [c.findings] : [])),
    ].map((path) => [path, hash(readFileSync(path))]),
  );
const frozenInputs = JSON.stringify(inputHashes());
const config = {
  PROVIDER: 'opencode',
  MODEL: plan.model,
  JBOT_SDK_ENGINE: 'opencode',
  JBOT_MODEL_OPTIONS: '{"reasoningEffort":"medium"}',
  JBOT_RUN_STATS: '1',
  JBOT_REVIEW_TELEMETRY: 'true',
  JBOT_REVIEW_SHARDS: '1',
  JBOT_REVIEW_PASSES: '1',
  JBOT_VERIFY_FINDINGS: 'true',
  JBOT_TIME_BUDGET_MINUTES: '10',
  JBOT_MAX_CONCURRENT_SESSIONS: '3',
  JBOT_OBSERVER_URL: '',
  JBOT_ACP_GATEWAY_URL: '',
  JBOT_LOCAL_REPORT: 'true',
  JBOT_BENCHMARK_DRY_RUN: 'true',
  CONTEXT7_API_KEY: '',
};
const arms: Arm[] = ['off', 'deterministic', 'on'];
const schedule = Array.from({ length: plan.repetitions ?? 5 }, (_, repetition) =>
  plan.cases
    .flatMap((c) => arms.map((arm) => ({ caseId: c.id, arm, repetition: repetition + 1 })))
    .sort((a, b) =>
      hash(plan.seed + JSON.stringify(a)).localeCompare(hash(plan.seed + JSON.stringify(b))),
    ),
)
  .flat()
  .map((run, i) => ({ ...run, id: String(i + 1).padStart(2, '0') }));
mkdirSync(out, { recursive: true });
writeFileSync(
  resolve(out, 'manifest.json'),
  JSON.stringify(
    {
      ...plan,
      driverHead,
      runtimeHash: initialRuntimeHash,
      inputHashes: JSON.parse(frozenInputs),
      config,
      schedule,
      cacheState: 'uncontrolled',
      credentialPolicy: 'first-configured-opencode-key',
      concurrency: 1,
      retries: 0,
    },
    null,
    2,
  ) + '\n',
);
loadDotEnv(resolve(root, '.env'));
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (
    key.startsWith('JBOT_') ||
    (key.startsWith('OPENCODE_') && key !== 'OPENCODE_API_KEY') ||
    ['PROVIDER', 'MODEL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].includes(
      key,
    )
  )
    delete env[key];
}
if (env.OPENCODE_API_KEY) env.OPENCODE_API_KEY = env.OPENCODE_API_KEY.split(',')[0].trim();
if (!env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required for the on arm');
const results: unknown[] = [];
for (const run of schedule) {
  if (
    git(root, 'rev-parse', 'HEAD') !== driverHead ||
    runtimeHash() !== initialRuntimeHash ||
    JSON.stringify(inputHashes()) !== frozenInputs
  )
    throw new Error('Driver changed during the experiment');
  const c = plan.cases.find((c) => c.id === run.caseId)!;
  checkCase(c);
  const dir = resolve(out, run.id);
  mkdirSync(dir);
  const output = resolve(dir, 'review.json');
  const stream = createWriteStream(resolve(dir, 'review.log'));
  const started = Date.now();
  console.log(
    `Starting ${run.id}/${schedule.length} ${run.caseId} ${run.arm} repetition ${run.repetition}`,
  );
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(import.meta.resolve('tsx')),
      ...(c.findings
        ? [resolve(root, 'scripts/jev-verification-trial.ts'), c.workspace, c.base, c.findings]
        : [resolve(root, 'src/local/index.ts'), '--workspace', c.workspace, '--base', c.base]),
    ],
    {
      cwd: dir,
      env: {
        ...env,
        ...config,
        JBOT_JEV_PREFETCH: plan.evidence ? 'off' : run.arm,
        JBOT_EXPLORATION_EVIDENCE: plan.evidence ? run.arm : 'off',
        JBOT_VERIFICATION_EVIDENCE: plan.evidence ? run.arm : 'off',
        JBOT_EVIDENCE_DOCS: plan.docs ?? '',
        JBOT_BENCHMARK_OUTPUT: output,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.pipe(stream, { end: false });
  child.stderr.pipe(stream, { end: false });
  const code = await new Promise<number | null>((done, reject) => {
    child.on('error', reject);
    child.on('close', done);
  });
  await new Promise<void>((done) => stream.end(done));
  checkCase(c);
  const review:
    (ReviewResult & { telemetry?: string; verdicts?: unknown[]; elapsedMs?: number }) | undefined =
    existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : undefined;
  const telemetryPath = resolve(dir, '.jbot-review/telemetry.jsonl');
  const telemetry =
    review?.telemetry ?? (existsSync(telemetryPath) ? readFileSync(telemetryPath, 'utf8') : '');
  const rows: Record<string, unknown>[] = telemetry
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const header = rows.find((r) => r.kind === 'run');
  const usage = parseBenchmarkTelemetry(telemetry);
  const sessions = rows.filter((r) => r.kind === 'session');
  const prefetch = rows.filter((r) => r.kind === 'jev-prefetch');
  const knownCost =
    sessions.length > 0 &&
    sessions.every((r) => typeof r.costUsd === 'number') &&
    prefetch.every((r) => !r.apiMs || typeof r.estimatedCostUsd === 'number');
  const result = {
    ...run,
    code,
    startedAt: new Date(started).toISOString(),
    processMs: Date.now() - started,
    terminalState:
      header?.terminalState ?? (review?.verdicts ? 'verification-output' : 'missing-output'),
    runMs: header?.elapsedMs ?? review?.elapsedMs ?? null,
    verdicts: review?.verdicts,
    retainedFindings: review?.findings.length ?? null,
    usage,
    costAvailable: knownCost,
    totalEstimatedCostUsd: knownCost
      ? usage.costUsd + prefetch.reduce((sum, r) => sum + Number(r.estimatedCostUsd ?? 0), 0)
      : null,
    prefetch,
    phases: rows.filter((r) => r.kind === 'phase' && r.scope === 'run'),
    exploration: rows.filter((r) => r.kind === 'exploration'),
    policy: header?.policy,
    execution: header?.execution,
  };
  results.push(result);
  writeFileSync(resolve(out, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(
    JSON.stringify({
      id: run.id,
      case: run.caseId,
      arm: run.arm,
      code,
      status: result.terminalState,
      ms: result.runMs,
      findings: result.retainedFindings,
    }),
  );
}
