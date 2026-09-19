import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDiffRecoveryBlock } from '../src/shared/prompt.ts';

test('recovery batches bound estimated output and prompt bytes without hiding unplanned paths', () => {
  const scope = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
  const files = Array.from({ length: 300 }, (_, i) => ({
    filename: `src/${i}.ts`,
    patch: 'x'.repeat(1000),
  }));
  files.push(
    { filename: 'large.ts', patch: 'x'.repeat(9000) },
    { filename: 'unknown.ts', patch: '' },
  );
  const paths = files.map((f) => f.filename);
  const block = buildDiffRecoveryBlock(files, paths, scope);
  assert.ok(Buffer.byteLength(block) <= 4096);
  assert.match(block, /omitted from this plan/);
  assert.match(block, /Read those remaining diffs separately/);
  const commands = block.split('\n').filter((l) => l.startsWith('    git'));
  let delivered = 0;
  for (const line of commands) {
    const names = [...line.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    delivered += names.length;
    assert.ok(names.length <= 8);
    assert.ok(names.reduce((n, name) => n + 1512 + Buffer.byteLength(name) * 4, 0) <= 8192);
    assert.ok(!names.includes('large.ts') && !names.includes('unknown.ts'));
  }
  assert.ok(delivered > 0 && delivered < files.length);
  assert.ok(block.includes(`${files.length - delivered} omitted`));
  assert.equal(buildDiffRecoveryBlock(files, [], scope), '');
  assert.equal(buildDiffRecoveryBlock(files, paths, { baseRef: 'main' }), '');
});

test('recovery commands preserve literal hostile filenames, PR scope and uncommitted local scope', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'diff-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  const names = ['a[1].ts', ':(glob)*.ts', "a'$(echo INJECTED).ts", 'other.ts'];
  for (const name of names) writeFileSync(join(root, name), 'old\n');
  git('add', '.');
  git(
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'base',
  );
  const baseSha = git('rev-parse', 'HEAD');
  for (const name of names) writeFileSync(join(root, name), 'committed\n');
  git('add', '.');
  git(
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'head',
  );
  const headSha = git('rev-parse', 'HEAD');
  for (const name of names) writeFileSync(join(root, name), 'uncommitted\n');
  const files = names.map((filename) => ({ filename, patch: '@@ -1 +1 @@\n-old\n+committed' }));
  for (const worktree of [false, true]) {
    const block = buildDiffRecoveryBlock(files, names.slice(0, 3), { baseSha, headSha, worktree });
    const commands = block.split('\n').filter((l) => l.startsWith('    git'));
    assert.equal(commands.length, 1);
    const output = execFileSync('/bin/sh', ['-c', commands[0]], { cwd: root, encoding: 'utf8' });
    assert.equal((output.match(/^diff --git /gm) ?? []).length, 3);
    assert.doesNotMatch(output, /other.ts/);
    assert.match(output, worktree ? /\+uncommitted/ : /\+committed/);
    assert.doesNotMatch(output, worktree ? /\+committed/ : /\+uncommitted/);
    assert.ok(output.includes("a'$(echo INJECTED).ts"));
  }
});
