import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const LOCAL_ENTRY = join(ROOT, 'src/local/index.ts');

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
    assert.match(output, /no sessions started/i);
    assert.equal(git(target, ['status', '--porcelain=v1', '--untracked-files=all']), before);
    assert.equal(existsSync(join(target, '.jbot-review')), false);

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

    const before = git(launcher, ['status', '--porcelain=v1', '--untracked-files=all']);
    const output = execFileSync(TSX, [LOCAL_ENTRY, '--preview'], {
      cwd: launcher,
      env: isolatedEnv(),
      encoding: 'utf8',
      stdio: 'pipe',
    });

    assert.match(output, /Diff base: main/);
    assert.match(output, /local\.ts/);
    assert.doesNotMatch(output, /Workspace:/);
    assert.equal(git(launcher, ['status', '--porcelain=v1', '--untracked-files=all']), before);
  } finally {
    rmSync(launcher, { recursive: true, force: true });
  }
});
