import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { it } from 'node:test';

import { arenaArtifactName, type ComparisonManifestV1 } from '../src/local/arena-contract.ts';

const ROOT = resolve(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const LOCAL_ENTRY = join(ROOT, 'src/local/index.ts');
const ARENA_MODEL = 'openai/gpt-5.4-nano';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('JBOT_') ||
      key.startsWith('GIT_') ||
      key === 'MODEL' ||
      key === 'PROVIDER'
    ) {
      delete env[key];
    }
  }
  return env;
}

function arenaManifest(baseSha: string, headSha: string): ComparisonManifestV1 {
  return {
    schemaVersion: 1,
    comparisonId: 'pgup-ai/jbot-arena:pr-1:comment-99',
    arena: {
      repository: 'pgup-ai/jbot-arena',
      prNumber: 1,
      commandCommentId: 99,
      workflowRunId: 123,
      runAttempt: 1,
    },
    target: {
      url: 'https://github.com/acme/widget/pull/7',
      owner: 'acme',
      repository: 'widget',
      prNumber: 7,
      title: 'Frozen target title',
      body: 'Frozen target body',
      base: {
        repository: 'acme/widget',
        cloneUrl: 'https://github.com/acme/widget.git',
        ref: 'main',
        sha: baseSha,
      },
      head: {
        repository: 'contributor/widget',
        cloneUrl: 'https://github.com/contributor/widget.git',
        ref: 'feature',
        sha: headSha,
      },
    },
    jbot: {
      commitSha: '3'.repeat(40),
      imageRef: `ghcr.io/pgup-ai/jbot-review:${'3'.repeat(40)}`,
      imageDigest: `sha256:${'4'.repeat(64)}`,
    },
    reviewConfig: {
      enhancedContext: true,
      dryRun: true,
      autoApprove: false,
      maxFindings: 0,
      minSeverity: 'nit',
      includePriorComments: false,
      context7Mode: 'auto',
      guidelinePass: true,
      shardCache: false,
      scrubSessionEnv: true,
      auxModelMode: 'same-as-main',
      sdkEngine: 'auto',
      reviewPasses: 1,
      verifyFindings: true,
      timeBudgetMinutes: 30,
      reviewShards: 0,
      dynamicFanout: true,
      modelOptions: null,
      promptCache: true,
      skipDocOnly: true,
      maxConcurrentSessions: 3,
      reviewTelemetry: true,
      evidenceQuotes: true,
      contextTrim: false,
      embeddedFirstPrompt: true,
      guidelineWiden: 'auto',
      verifierSlimContext: false,
      verifyOverlapGrace: false,
    },
    models: [
      {
        index: 0,
        model: ARENA_MODEL,
        provider: 'openai',
        artifactName: arenaArtifactName(0, ARENA_MODEL),
      },
    ],
  };
}

function writeArenaManifest(path: string, manifest: ComparisonManifestV1): void {
  writeFileSync(path, `${JSON.stringify(manifest)}\n`);
}

it('previews a distinct local workspace with launcher-owned config and artifacts', () => {
  const root = mkdtempSync(join(tmpdir(), 'jbot-local-workspace-'));
  const launcher = join(root, 'launcher');
  const target = join(root, 'target');
  try {
    mkdirSync(launcher);
    git(root, ['init', '-q', '-b', 'main', target]);
    git(target, ['config', 'user.email', 'test@jbot.local']);
    git(target, ['config', 'user.name', 'jbot test']);
    mkdirSync(join(target, 'src'));
    writeFileSync(join(target, 'AGENTS.md'), '# Target rules\n');
    writeFileSync(join(target, 'REVIEW.md'), '# More target rules\n');
    writeFileSync(join(target, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(target, 'src/b.ts'), 'export const b = 1;\n');
    git(target, ['add', '.']);
    git(target, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    git(target, ['switch', '-qc', 'feature']);
    writeFileSync(join(target, 'src/a.ts'), 'export const a = 2;\n');
    writeFileSync(join(target, 'src/b.ts'), 'export const b = 2;\n');
    const targetRoot = git(join(target, 'src'), ['rev-parse', '--show-toplevel']);

    writeFileSync(
      join(launcher, '.env'),
      ['MODEL=openai/gpt-5.4-nano', 'JBOT_REVIEW_SHARDS=2', 'JBOT_LOCAL_BASE=missing'].join('\n'),
    );
    writeFileSync(join(target, '.env'), 'JBOT_BENCHMARK_OUTPUT=target-poison.json\n');

    const before = git(target, ['status', '--porcelain=v1', '--untracked-files=all']);
    const workspace = relative(launcher, join(target, 'src'));
    const output = execFileSync(
      TSX,
      [LOCAL_ENTRY, '--workspace', workspace, '--base', 'main', '--preview'],
      { cwd: launcher, env: isolatedEnv(), encoding: 'utf8', stdio: 'pipe' },
    );

    assert.ok(output.includes(`Workspace: ${targetRoot}`));
    assert.match(output, /Diff base: main/);
    assert.match(output, /Shards: 2/);
    assert.match(output, /src\/a\.ts/);
    assert.match(output, /src\/b\.ts/);
    assert.match(output, /Guidelines: 2 doc\(s\)/);

    const failure = spawnSync(TSX, [LOCAL_ENTRY, '--workspace', workspace, '--base', 'missing'], {
      cwd: launcher,
      env: isolatedEnv(),
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /Base ref "missing" not found locally/);
    assert.doesNotMatch(failure.stderr, /credential|API key/i);

    const missingWorkspace = spawnSync(
      TSX,
      [LOCAL_ENTRY, '--workspace', '../missing', '--preview'],
      { cwd: launcher, env: isolatedEnv(), encoding: 'utf8', stdio: 'pipe' },
    );
    assert.equal(missingWorkspace.status, 1);
    assert.match(missingWorkspace.stderr, /is not an existing Git worktree/);
    assert.equal(git(target, ['status', '--porcelain=v1', '--untracked-files=all']), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps the launch checkout as the workspace when --workspace is omitted', () => {
  const launcher = mkdtempSync(join(tmpdir(), 'jbot-local-default-'));
  try {
    git(launcher, ['init', '-q', '-b', 'main']);
    git(launcher, ['config', 'user.email', 'test@jbot.local']);
    git(launcher, ['config', 'user.name', 'jbot test']);
    writeFileSync(join(launcher, 'local.ts'), 'export const value = 1;\n');
    git(launcher, ['add', 'local.ts']);
    git(launcher, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    git(launcher, ['switch', '-qc', 'feature']);
    writeFileSync(join(launcher, 'local.ts'), 'export const value = 2;\n');
    writeFileSync(
      join(launcher, '.env'),
      ['MODEL=openai/gpt-5.4-nano', 'JBOT_LOCAL_BASE=main'].join('\n'),
    );

    const output = execFileSync(TSX, [LOCAL_ENTRY, '--preview'], {
      cwd: launcher,
      env: isolatedEnv(),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    assert.match(output, /Diff base: main/);
    assert.match(output, /local\.ts/);
    assert.doesNotMatch(output, /Workspace:/);
  } finally {
    rmSync(launcher, { recursive: true, force: true });
  }
});

it('writes a credential-free skipped arena result for the frozen clean doc-only diff', () => {
  const root = mkdtempSync(join(tmpdir(), 'jbot-local-arena-skip-'));
  const target = join(root, 'target');
  const run = join(root, 'run');
  const output = join(root, 'output');
  const home = join(root, 'home');
  try {
    mkdirSync(run);
    mkdirSync(output);
    mkdirSync(home);
    git(root, ['init', '-q', '-b', 'main', target]);
    git(target, ['config', 'user.email', 'test@jbot.local']);
    git(target, ['config', 'user.name', 'jbot test']);
    writeFileSync(join(target, 'README.md'), '# Base\n');
    writeFileSync(join(target, '.env'), 'PROVIDER=bogus\nJBOT_SKIP_DOC_ONLY=false\n');
    git(target, ['add', '.']);
    git(target, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    const baseSha = git(target, ['rev-parse', 'HEAD']);
    git(target, ['switch', '-qc', 'feature']);
    writeFileSync(join(target, 'README.md'), '# Feature\n');
    git(target, ['add', 'README.md']);
    git(target, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'docs']);
    const headSha = git(target, ['rev-parse', 'HEAD']);
    const contextPath = join(run, 'comparison.json');
    const outputPath = join(output, 'jbot-output.json');
    writeArenaManifest(contextPath, arenaManifest(baseSha, headSha));
    const result = spawnSync(
      TSX,
      [LOCAL_ENTRY, '--pr-context', contextPath, '--output', outputPath],
      {
        cwd: target,
        env: {
          ...isolatedEnv(),
          MODEL: ARENA_MODEL,
          HOME: home,
          GIT_TEST_ASSUME_DIFFERENT_OWNER: '1',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Configured git safe\.directory/);
    assert.match(result.stdout, /Doc-only PR/);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), {
      schemaVersion: 1,
      status: 'skipped',
      backend: null,
      sdkEngine: null,
      resolvedModelOptions: null,
      reviewMs: null,
      usage: {
        sessions: 0,
        inputTokens: { value: null, reportingSessions: 0 },
        outputTokens: { value: null, reportingSessions: 0 },
        reasoningTokens: { value: null, reportingSessions: 0 },
        cacheReadTokens: { value: null, reportingSessions: 0 },
        cost: { usd: null, source: 'unavailable', reportingSessions: 0 },
      },
      review: null,
      failure: null,
    });
    assert.equal(git(target, ['status', '--porcelain=v1', '--untracked-files=all']), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('writes bounded arena failures for mismatched HEAD and a dirty checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'jbot-local-arena-failure-'));
  const target = join(root, 'target');
  const run = join(root, 'run');
  const output = join(root, 'output');
  const home = join(root, 'home');
  try {
    mkdirSync(run);
    mkdirSync(output);
    mkdirSync(home);
    git(root, ['init', '-q', '-b', 'main', target]);
    git(target, ['config', 'user.email', 'test@jbot.local']);
    git(target, ['config', 'user.name', 'jbot test']);
    writeFileSync(join(target, 'code.ts'), 'export const value = 1;\n');
    git(target, ['add', '.']);
    git(target, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    const sha = git(target, ['rev-parse', 'HEAD']);
    const arenaEnv = { ...isolatedEnv(), MODEL: ARENA_MODEL, HOME: home };

    const mismatchContext = join(run, 'mismatch.json');
    const mismatchOutput = join(output, 'mismatch.json');
    writeArenaManifest(mismatchContext, arenaManifest(sha, '9'.repeat(40)));
    const mismatch = spawnSync(
      TSX,
      [LOCAL_ENTRY, '--pr-context', mismatchContext, '--output', mismatchOutput],
      {
        cwd: target,
        env: arenaEnv,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /does not match frozen head/);
    const mismatchEnvelope = JSON.parse(readFileSync(mismatchOutput, 'utf8')) as {
      status: string;
      failure: { class: string; message: string };
    };
    assert.equal(mismatchEnvelope.status, 'failed');
    assert.equal(mismatchEnvelope.failure.class, 'unknown');
    assert.doesNotMatch(mismatchEnvelope.failure.message, /[\r\n]/);

    for (const gatewayEnv of [
      'JBOT_ACP_GATEWAY_URL',
      'JBOT_ACP_GATEWAY_REPO',
      'JBOT_ACP_GATEWAY_REF',
    ]) {
      const gatewayOutput = join(output, `${gatewayEnv}.json`);
      const gateway = spawnSync(
        TSX,
        [LOCAL_ENTRY, '--pr-context', mismatchContext, '--output', gatewayOutput],
        {
          cwd: target,
          env: { ...arenaEnv, [gatewayEnv]: 'forbidden' },
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
      assert.equal(gateway.status, 1);
      assert.match(gateway.stderr, /does not accept ACP gateway routing/);
      assert.equal(JSON.parse(readFileSync(gatewayOutput, 'utf8')).status, 'failed');
    }

    writeFileSync(join(target, 'code.ts'), 'export const value = 2;\n');
    const dirtyContext = join(run, 'dirty.json');
    const dirtyOutput = join(output, 'dirty.json');
    writeArenaManifest(dirtyContext, arenaManifest(sha, sha));
    const dirty = spawnSync(
      TSX,
      [LOCAL_ENTRY, '--pr-context', dirtyContext, '--output', dirtyOutput],
      {
        cwd: target,
        env: arenaEnv,
        encoding: 'utf8',
        stdio: 'pipe',
      },
    );
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /must be clean/);
    assert.equal(JSON.parse(readFileSync(dirtyOutput, 'utf8')).status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
