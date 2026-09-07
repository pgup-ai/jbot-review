import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  buildFindingSourceContext,
  findingSourceLocations,
} from '../src/shared/finding-context.ts';
import { formatFindingSources, MAX_FINDING_SOURCE_CONTEXT_BYTES } from '../src/shared/prompt.ts';
import type { Finding } from '../src/shared/types.ts';

const execFileAsync = promisify(execFile);

test('source locations preserve cited dependencies and reject path escapes without guessing symbols', () => {
  const base = { path: 'src/caller.ts', line: 12, body: '' };
  assert.deepEqual(
    findingSourceLocations([
      {
        ...base,
        body: 'Check `src/helper.ts:42` and (rules/quality.md:7); then src/helper.ts:42.',
      },
      { ...base, body: 'A missing helperName alone is not a source location.' },
      { ...base, path: '../secret', body: '`../secret:1` and `/tmp/private:2`' },
      { ...base, path: '.git/config', body: 'https://private.example/file.ts:3' },
      { ...base, body: 'See `app/(auth)/[id]/page.tsx:8` and `src/用户 设置.ts:2`.' },
    ]),
    [
      { path: 'src/caller.ts', line: 12 },
      { path: 'src/helper.ts', line: 42 },
      { path: 'rules/quality.md', line: 7 },
      { path: 'app/(auth)/[id]/page.tsx', line: 8 },
      { path: 'src/用户 设置.ts', line: 2 },
    ],
  );
});

test('source context reads tracked worktree helpers but excludes untracked files and symlinks', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'jbot-finding-context-'));
  try {
    await execFileAsync('git', ['init', '-q', workspace]);
    await mkdir(join(workspace, 'src'));
    await writeFile(join(workspace, 'src/helper.ts'), 'export function validate() {}\n');
    await writeFile(join(workspace, 'private.key'), 'SECRET_MUST_NOT_APPEAR');
    await symlink('../private.key', join(workspace, 'src/alias.ts'));
    await execFileAsync('git', ['add', 'src/helper.ts', 'src/alias.ts'], { cwd: workspace });
    await writeFile(
      join(workspace, 'src/helper.ts'),
      'export function validate() {\n  markFailed();\n}\n',
    );
    const finding: Finding = {
      path: 'src/helper.ts',
      line: 1,
      severity: 'P2',
      title: 'Missing failure transition',
      body: 'See `src/helper.ts:2` and `private.key:1`.',
    };
    const block = await buildFindingSourceContext(workspace, [
      finding,
      {
        ...finding,
        path: 'src/alias.ts',
        body: 'See `src/missing.ts:3`.',
      },
    ]);
    assert.match(block, /2:   markFailed\(\);/);
    assert.doesNotMatch(block, /SECRET_MUST_NOT_APPEAR/);
    assert.match(
      block,
      /Unavailable or omitted locations.*private.key:1.*src\/alias.ts:1.*src\/missing.ts:3/,
    );
    assert.equal(
      await buildFindingSourceContext(workspace, [{ ...finding, line: 0, body: '' }]),
      '',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('source context stays within its byte budget and names omitted evidence', () => {
  const sources = Array.from({ length: 20 }, (_, i) => ({
    path: `src/${i}.ts`,
    line: 21,
    startLine: 1,
    lines: Array(41).fill('🔍'.repeat(800)),
  }));
  const block = formatFindingSources(sources, [{ path: 'src/extra.ts', line: 100 }]);
  assert.ok(Buffer.byteLength(block) <= MAX_FINDING_SOURCE_CONTEXT_BYTES);
  assert.match(block, /21: 🔍/);
  assert.doesNotMatch(block, /\n1: 🔍/);
  assert.match(block, /Source excerpt truncated/);
  assert.match(block, /Surrounding lines omitted/);
  assert.match(block, /Unavailable or omitted locations.*src\/extra.ts:100/);
  assert.match(block, /not whole files/);
});
