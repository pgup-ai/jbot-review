import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { collectChangesSinceContext } from '../src/shared/changes-since.ts';
import { CHANGES_SINCE_DIFF_BUDGET } from '../src/shared/prompt.ts';

/** A throwaway repo on `main` with hooks off and a committer set. */
function testRepo(prefix: string) {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  return { workspace, git };
}

it('embeds only the committed re-review delta when subjects contain no details', async (t) => {
  const { workspace, git } = testRepo('jbot-summary-');
  try {
    writeFileSync(join(workspace, 'old.ts'), 'const unrelated = true;\n');
    git('add', '.');
    git('commit', '-m', 'update');
    const from = git('rev-parse', 'HEAD');
    writeFileSync(join(workspace, 'new.ts'), 'export const retryLimit = 3;\n');
    git('add', '.');
    git('commit', '-m', 'update');
    const to = git('rev-parse', 'HEAD');
    writeFileSync(join(workspace, 'new.ts'), 'export const retryLimit = 99;\n');

    const embedded = await collectChangesSinceContext(workspace, from, to, true);
    assert.ok(embedded);
    assert.match(embedded, /\+export const retryLimit = 3;/);
    assert.doesNotMatch(embedded, /unrelated|retryLimit = 99/);
    const spawn = childProcess.spawn;
    const statFailure = t.mock.method(childProcess, 'spawn', ((
      ...args: Parameters<typeof spawn>
    ) =>
      args[1]?.includes('--stat=120')
        ? spawn(process.execPath, ['-e', 'process.exit(1)'], args[2])
        : spawn(...args)) as typeof spawn);
    syncBuiltinESMExports();
    try {
      const withoutStat = await collectChangesSinceContext(workspace, from, to, true);
      assert.ok(withoutStat);
      assert.match(withoutStat, /unavailable/);
      assert.match(withoutStat, /update/);
      assert.match(withoutStat, /\+export const retryLimit = 3;/);
    } finally {
      statFailure.mock.restore();
      syncBuiltinESMExports();
    }
    const agentic = await collectChangesSinceContext(workspace, from, to, false);
    assert.ok(agentic);
    assert.match(agentic, /update/);
    assert.doesNotMatch(agentic, /retryLimit|Delta diff/);
    assert.equal(await collectChangesSinceContext(workspace, to, to, true), undefined);
    await assert.rejects(collectChangesSinceContext(workspace, 'missing-ref', to, true));

    git('commit', '--allow-empty', '-m', 'trigger CI');
    const empty = git('rev-parse', 'HEAD');
    const noChanges = await collectChangesSinceContext(workspace, to, empty, true);
    assert.ok(noChanges);
    assert.match(noChanges, /trigger CI/);
    assert.match(noChanges, /\(No file changes\.\)/);

    writeFileSync(join(workspace, 'a-first.ts'), 'const padding = true;\n'.repeat(8000));
    writeFileSync(join(workspace, 'z-last.ts'), 'export const lastFileChange = true;\n');
    git('add', '.');
    git('commit', '-m', 'update');
    const broad = await collectChangesSinceContext(
      workspace,
      empty,
      git('rev-parse', 'HEAD'),
      true,
    );
    assert.ok(broad);
    assert.match(broad, /\+export const lastFileChange = true/);
    assert.match(broad, /Delta file overview/);
    assert.doesNotMatch(broad, /truncated|omitted/);
    git('rm', 'a-first.ts', 'z-last.ts');
    git('commit', '-m', 'update');

    for (let i = 0; i < 512; i++)
      writeFileSync(join(workspace, `${i}-${'long-name'.repeat(8)}.txt`), 'hello');
    git('add', '.');
    git('commit', '-m', 'wide delta');
    const wide = await collectChangesSinceContext(workspace, empty, git('rev-parse', 'HEAD'), true);
    const overview = wide!.split('### Delta file overview\n')[1].split('### Delta diff')[0];
    assert.match(overview, /Delta file overview truncated.*omitted/);
    assert.ok(Buffer.byteLength(overview) < 33 * 1024);

    let large = empty;
    for (const [index, content] of [
      Buffer.from('変更\n'.repeat(1_500_000)),
      Buffer.alloc(3000, 0xff),
      Buffer.alloc(10_000, 0x80),
      Buffer.from([0x61, 0xe2, 0x82]),
    ].entries()) {
      writeFileSync(join(workspace, 'large.txt'), content);
      git('add', 'large.txt');
      git('commit', '-m', 'update');
      large = git('rev-parse', 'HEAD');
      const rawDiff = execFileSync('git', ['diff', '--no-color', empty, large, '--'], {
        cwd: workspace,
        maxBuffer: 16 * 1024 * 1024,
      });
      if (index === 0) assert.ok(rawDiff.length > 8 * 1024 * 1024);
      const decodedDiff = Buffer.from(rawDiff.toString('utf8'));
      const bounded = await collectChangesSinceContext(workspace, empty, large, true);
      assert.ok(bounded);
      const evidence = bounded.split('### Delta diff\n')[1];
      if (decodedDiff.length <= CHANGES_SINCE_DIFF_BUDGET) {
        assert.equal(evidence, decodedDiff.toString('utf8'));
        continue;
      }
      const match = evidence.match(
        /^([\s\S]*)\n\n\[Changes-since summary diff \(UTF-8 text\) truncated to (\d+) bytes; omitted (\d+) bytes\.\]$/,
      );
      assert.ok(match);
      const [, prefix, kept, omitted] = match;
      assert.equal(Buffer.byteLength(prefix), Number(kept));
      assert.ok(Number(kept) <= CHANGES_SINCE_DIFF_BUDGET);
      assert.ok(Number(kept) >= CHANGES_SINCE_DIFF_BUDGET - 3);
      assert.equal(prefix, decodedDiff.subarray(0, Number(kept)).toString('utf8'));
      assert.equal(Number(omitted), decodedDiff.length - Number(kept));
    }

    const blob = git('rev-parse', 'HEAD:large.txt');
    rmSync(join(workspace, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    await assert.rejects(
      collectChangesSinceContext(workspace, empty, large, true),
      /git output failed/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('leaves base-branch commits merged into the PR out of the delta, but not its conflict resolutions', async () => {
  const { workspace, git } = testRepo('jbot-summary-merge-');
  const commitAll = (message: string) => {
    git('add', '.');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    writeFileSync(join(workspace, 'app.ts'), 'export const a = 1;\n');
    commitAll('root');
    git('checkout', '-b', 'pr');
    writeFileSync(join(workspace, 'feature.ts'), 'export const feature = 1;\n');
    const reviewed = commitAll('add feature');
    writeFileSync(join(workspace, 'app.ts'), 'export const a = 3;\n');
    const edited = commitAll('pr edits a');
    git('checkout', 'main');
    writeFileSync(join(workspace, 'other-pr.ts'), 'export const otherPr = true;\n');
    writeFileSync(join(workspace, 'app.ts'), 'export const a = 2;\n');
    const base = commitAll('other PR landed');
    git('checkout', 'pr');
    assert.throws(() => git('merge', '--no-edit', 'main'));
    writeFileSync(join(workspace, 'app.ts'), 'export const a = 4;\n');
    const resolved = commitAll('resolve main');
    writeFileSync(join(workspace, 'feature.ts'), 'export const feature = 2;\n');
    const head = commitAll('tune feature');

    const merged = await collectChangesSinceContext(workspace, reviewed, head, true, base);
    assert.ok(merged);
    assert.match(merged, /tune feature/);
    assert.match(merged, /\+export const feature = 2;/);
    assert.match(merged, /\+\+export const a = 4;/);
    assert.match(merged, new RegExp(`git log --cc ${reviewed}\\.\\.${head} \\^${base}`));
    assert.doesNotMatch(merged, /other PR landed|otherPr|other-pr\.ts/);
    const resolutionOnly = await collectChangesSinceContext(
      workspace,
      edited,
      resolved,
      true,
      base,
    );
    assert.match(resolutionOnly ?? '', /\+\+export const a = 4;/);
    assert.match(resolutionOnly ?? '', /Conflict resolutions in merge commits: app\.ts/);
    assert.doesNotMatch(resolutionOnly ?? '', /other-pr\.ts/);

    git('checkout', 'main');
    writeFileSync(join(workspace, 'z.ts'), 'export const z = 1;\n');
    const cleanBase = commitAll('third PR');
    git('checkout', 'pr');
    git('merge', '--no-edit', 'main');
    const cleanHead = git('rev-parse', 'HEAD');
    assert.equal(
      await collectChangesSinceContext(workspace, head, cleanHead, true, cleanBase),
      undefined,
    );

    // The base advances by a merge commit alone, carrying its own change.
    writeFileSync(join(workspace, 'evil.ts'), 'export const evil = 1;\n');
    git('add', 'evil.ts');
    const evilBase = git(
      'commit-tree',
      git('write-tree'),
      '-p',
      cleanBase,
      '-p',
      cleanHead,
      '-m',
      'evil',
    );
    git('reset', '-q', '--hard');
    git('merge', '--no-edit', evilBase);
    writeFileSync(join(workspace, 'feature.ts'), 'export const feature = 3;\n');
    const evilHead = commitAll('tune again');
    const afterEvil = await collectChangesSinceContext(
      workspace,
      cleanHead,
      evilHead,
      true,
      evilBase,
    );
    assert.match(afterEvil ?? '', /tune again/);
    assert.doesNotMatch(afterEvil ?? '', /evil/);

    // Both sides edit separate hunks of one file: a clean merge, nothing resolved.
    writeFileSync(join(workspace, 'm.ts'), 'a\n1\n2\n3\n4\n5\n6\n7\n8\nz\n');
    const shared = commitAll('add m');
    git('checkout', 'main');
    git('merge', '--no-edit', shared);
    writeFileSync(join(workspace, 'm.ts'), 'a\n1\n2\n3\n4\n5\n6\n7\n8\nZ\n');
    const sameFileBase = commitAll('base edits m');
    git('checkout', 'pr');
    writeFileSync(join(workspace, 'm.ts'), 'A\n1\n2\n3\n4\n5\n6\n7\n8\nz\n');
    const beforeMerge = commitAll('pr edits m');
    git('merge', '--no-edit', 'main');
    assert.equal(
      await collectChangesSinceContext(
        workspace,
        beforeMerge,
        git('rev-parse', 'HEAD'),
        true,
        sameFileBase,
      ),
      undefined,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
