/**
 * Runs jbot-review against pinned golden PR snapshots and writes
 * actual-findings.json files for npm run eval.
 *
 * The golden labels describe bugs that often existed before the final merged
 * PR head. Each case therefore has snapshot.json with one or more review heads
 * captured from the original review comments. This script checks out those
 * exact heads, computes base...head diffs locally, runs the read-only opencode
 * reviewer, and stores the model's findings beside the expected labels.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { dedupeFindings } from '../src/shared/filter.ts';
import { parseModelName } from '../src/shared/model.ts';
import { runPrReview } from '../src/shared/runner.ts';
import { PROVIDERS } from '../src/shared/config.ts';
import type { Octokit, PrFile } from '../src/shared/github.ts';
import type { ReviewCommit } from '../src/shared/review-context.ts';
import type { Finding } from '../src/shared/types.ts';

interface GoldenExpected {
  provenance: {
    repo: string;
    pr: number;
    url: string;
    baseSha: string;
    headSha: string;
    mergeSha?: string;
  };
  findings: unknown[];
}

interface GoldenSnapshot {
  repo: string;
  pr: number;
  baseSha: string;
  finalHeadSha: string;
  mergeSha?: string;
  heads: Array<{
    sha: string;
    reason: string;
    sourceCommentIds?: number[];
    sourceUrls?: string[];
  }>;
}

interface BenchArgs {
  goldenRoot: string;
  cases: string[];
  model: string;
  apiKey: string;
  repoRoots: Map<string, string>;
  all: boolean;
  score: boolean;
  modelOptions: Record<string, unknown>;
  reviewPasses: number;
  verifyFindings: boolean;
  timeBudgetMinutes: number;
  reviewShards: number;
  maxConcurrentSessions: number;
}

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = {
    goldenRoot: 'fixtures/golden',
    cases: [],
    model: '',
    apiKey: '',
    repoRoots: new Map(),
    all: false,
    score: true,
    modelOptions: { reasoningEffort: 'medium' },
    reviewPasses: 1,
    verifyFindings: true,
    timeBudgetMinutes: 10,
    reviewShards: 0,
    maxConcurrentSessions: 0,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--all') args.all = true;
    else if (arg === '--no-score') args.score = false;
    else if (arg === '--no-verify-findings') args.verifyFindings = false;
    else if (arg === '--case') args.cases.push(next());
    else if (arg === '--golden-root') args.goldenRoot = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--api-key') args.apiKey = next();
    else if (arg === '--model-options') args.modelOptions = parseJsonObject(next(), arg);
    else if (arg === '--review-passes') args.reviewPasses = parsePositiveInteger(next(), arg);
    else if (arg === '--time-budget-minutes')
      args.timeBudgetMinutes = parseNonNegativeInteger(next(), arg);
    else if (arg === '--review-shards') args.reviewShards = parseNonNegativeInteger(next(), arg);
    else if (arg === '--max-concurrent-sessions')
      args.maxConcurrentSessions = parseNonNegativeInteger(next(), arg);
    else if (arg === '--repo-root') {
      const value = next();
      const eq = value.indexOf('=');
      if (eq <= 0) throw new Error('--repo-root expects owner/name=/absolute/path');
      args.repoRoots.set(value.slice(0, eq), resolve(value.slice(eq + 1)));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.model) throw new Error('Missing --model provider/model');
  if (!args.all && args.cases.length === 0) {
    throw new Error('Pass --all or at least one --case <case-directory-name>');
  }
  const provider = parseModelName(args.model).providerID;
  const providerConfig = PROVIDERS[provider];
  const envApiKey = providerConfig ? (process.env[providerConfig.keyEnv] ?? '') : '';
  args.apiKey = isPlaceholderValue(args.apiKey) ? '' : args.apiKey;
  args.apiKey ||= isPlaceholderValue(envApiKey) ? '' : envApiKey;
  if (!args.apiKey) {
    const envHint =
      providerConfig?.keyEnv ?? `${provider.toUpperCase().replaceAll('-', '_')}_API_KEY`;
    throw new Error(`Missing API key for ${provider}. Set ${envHint} or pass --api-key.`);
  }
  return args;
}

function isPlaceholderValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized.startsWith('your_') || normalized.startsWith('<');
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function main(): Promise<void> {
  loadDefaultEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const caseDirs = await selectCases(args);

  for (const caseDir of caseDirs) {
    const expected = await readJson<GoldenExpected>(join(caseDir, 'expected-findings.json'));
    const snapshot = await readSnapshot(caseDir, expected);
    const workspace = ensureRepo(snapshot.repo, snapshot.pr, args.repoRoots);
    const caseName = basename(caseDir);
    const actuals: Finding[] = [];

    console.log(`\n=== ${caseName} (${snapshot.repo}#${snapshot.pr}) ===`);
    for (const head of snapshot.heads) {
      console.log(`Snapshot ${head.sha.slice(0, 12)} (${head.reason})`);
      ensureCommit(workspace, snapshot.repo, snapshot.pr, head.sha);
      const baseSha = resolveBaseSha(workspace, snapshot.baseSha, head.sha);
      git(workspace, ['checkout', '--detach', head.sha]);

      const files = getChangedFiles(workspace, baseSha, head.sha);
      if (files.length === 0) {
        console.log('No reviewable files in snapshot.');
        continue;
      }

      const commits = getCommits(workspace, baseSha, head.sha);
      const octokit = buildSnapshotOctokit(files, commits);
      let resultFindings: Finding[] | undefined;

      await runPrReview({
        octokit,
        owner: snapshot.repo.split('/')[0],
        repo: snapshot.repo.split('/')[1],
        pullNumber: snapshot.pr,
        pullTitle: `${snapshot.repo}#${snapshot.pr} golden benchmark snapshot`,
        pullBody: `Golden benchmark case ${caseName}. Review pinned snapshot ${head.sha}.`,
        workspace,
        model: args.model,
        apiKey: args.apiKey,
        headSha: head.sha,
        baseSha,
        options: {
          enhancedContext: true,
          dryRun: true,
          minSeverity: 'nit',
          includePriorComments: false,
          context7Mode: 'off',
          guidelinePass: true,
          reviewPasses: args.reviewPasses,
          verifyFindings: args.verifyFindings,
          timeBudgetMinutes: args.timeBudgetMinutes,
          reviewShards: args.reviewShards,
          modelOptions: args.modelOptions,
          maxConcurrentSessions: args.maxConcurrentSessions,
          onReviewResult: (result) => {
            resultFindings = result.findings;
          },
        },
        log: (msg) => console.log(`[${caseName} ${head.sha.slice(0, 7)}] ${msg}`),
      });
      const findings = resultFindings ?? [];
      console.log(`Findings: ${findings.length}`);
      actuals.push(...findings);
    }

    const dedupedActuals = dedupeFindings(actuals);
    const actualFindings = dedupedActuals.map((finding) => ({
      path: finding.path,
      line: finding.line,
      severity: finding.severity,
      title: finding.title,
      body: finding.body,
    }));
    await writeFile(
      join(caseDir, 'actual-findings.json'),
      `${JSON.stringify(actualFindings, null, 2)}\n`,
    );
    console.log(`Wrote ${actualFindings.length} actual finding(s).`);
  }

  if (args.score) {
    const score = spawnSync('npm', ['run', 'eval', '--', args.goldenRoot], {
      cwd: process.cwd(),
      stdio: 'inherit',
    });
    process.exitCode = score.status ?? 1;
  }
}

function loadDefaultEnvFile(): void {
  if (!existsSync('.env')) return;
  loadEnvFile('.env');
}

function buildSnapshotOctokit(files: PrFile[], commits: ReviewCommit[]): Octokit {
  const rest = {
    pulls: {
      listFiles: async () => undefined,
      listReviews: async () => undefined,
      listCommits: async () => undefined,
    },
    checks: {
      listForRef: async () => undefined,
    },
  };
  const fake = {
    rest,
    paginate: async (endpoint: unknown) => {
      if (endpoint === rest.pulls.listFiles) {
        return files.map((file) => ({ filename: file.filename, patch: file.patch }));
      }
      if (endpoint === rest.pulls.listCommits) {
        return commits.map((commit) => ({
          sha: commit.sha,
          author: commit.author ? { login: commit.author } : undefined,
          commit: {
            message: commit.message,
            author: commit.author ? { name: commit.author } : undefined,
          },
        }));
      }
      if (endpoint === rest.pulls.listReviews || endpoint === rest.checks.listForRef) return [];
      throw new Error('Unexpected benchmark Octokit pagination endpoint');
    },
  };
  return fake as unknown as Octokit;
}

async function selectCases(args: BenchArgs): Promise<string[]> {
  const entries = await readdir(args.goldenRoot, { withFileTypes: true });
  const allCases = entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'candidates')
    .map((entry) => join(args.goldenRoot, entry.name))
    .sort();
  if (args.all) return allCases;

  const wanted = new Set(args.cases);
  const selected = allCases.filter((dir) => wanted.has(basename(dir)));
  const found = new Set(selected.map((dir) => basename(dir)));
  const missing = [...wanted].filter((name) => !found.has(name));
  if (missing.length > 0) throw new Error(`Unknown case(s): ${missing.join(', ')}`);
  return selected;
}

async function readSnapshot(caseDir: string, expected: GoldenExpected): Promise<GoldenSnapshot> {
  const snapshotPath = join(caseDir, 'snapshot.json');
  if (existsSync(snapshotPath)) return readJson<GoldenSnapshot>(snapshotPath);
  return {
    repo: expected.provenance.repo,
    pr: expected.provenance.pr,
    baseSha: expected.provenance.baseSha,
    finalHeadSha: expected.provenance.headSha,
    mergeSha: expected.provenance.mergeSha,
    heads: [{ sha: expected.provenance.headSha, reason: 'legacy-final-head' }],
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function ensureRepo(repo: string, pr: number, overrides: ReadonlyMap<string, string>): string {
  const override = overrides.get(repo);
  if (override) return override;

  const target = join('.tmp', 'golden-repos', repo);
  if (!existsSync(join(target, '.git'))) {
    mkdirSync(dirname(target), { recursive: true });
    execFileSync('git', ['clone', '--no-checkout', `https://github.com/${repo}.git`, target], {
      stdio: 'inherit',
    });
  }
  fetchRepo(target, repo, pr);
  return target;
}

function ensureCommit(workspace: string, repo: string, pr: number, sha: string): void {
  try {
    git(workspace, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    fetchRepo(workspace, repo, pr);
    git(workspace, ['cat-file', '-e', `${sha}^{commit}`]);
  }
}

function resolveBaseSha(workspace: string, snapshotBaseSha: string, headSha: string): string {
  if (hasCommit(workspace, snapshotBaseSha)) return snapshotBaseSha;
  const fallback = git(workspace, ['merge-base', headSha, 'origin/main']).trim();
  console.log(
    `Stored base ${snapshotBaseSha.slice(0, 12)} is unavailable; using merge-base ${fallback.slice(0, 12)}.`,
  );
  return fallback;
}

function hasCommit(workspace: string, sha: string): boolean {
  try {
    git(workspace, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function fetchRepo(workspace: string, repo: string, pr: number): void {
  git(workspace, ['fetch', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  try {
    git(workspace, [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/pull/${pr}/head:refs/remotes/golden/pr-${pr}`,
    ]);
  } catch {
    // Merged PR refs can disappear; branch fetch above is enough when commits
    // are still reachable from the target repo.
  }
}

function getChangedFiles(workspace: string, baseSha: string, headSha: string): PrFile[] {
  const names = git(workspace, ['diff', '--name-only', `${baseSha}...${headSha}`])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return names.map((filename) => ({
    filename,
    patch: git(workspace, [
      'diff',
      '--unified=80',
      '--find-renames',
      `${baseSha}...${headSha}`,
      '--',
      filename,
    ]),
  }));
}

function getCommits(workspace: string, baseSha: string, headSha: string): ReviewCommit[] {
  const out = git(workspace, ['log', '--format=%H%x00%s%x00%an', `${baseSha}..${headSha}`]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, message, author] = line.split('\0');
      return { sha, message, author };
    });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 80 });
}

await main();
