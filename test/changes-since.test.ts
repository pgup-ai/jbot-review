import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { collectChangesSinceContext } from '../src/shared/changes-since.ts';
import { CHANGES_SINCE_DIFF_BUDGET } from '../src/shared/prompt.ts';

it('embeds only the committed re-review delta when subjects contain no details', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'jbot-summary-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: workspace,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
  try {
    git('init');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'commit.gpgsign', 'false');
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

    writeFileSync(join(workspace, 'large.txt'), '変更\n'.repeat(1_500_000));
    git('add', 'large.txt');
    git('commit', '-m', 'update');
    const large = git('rev-parse', 'HEAD');
    const rawDiff = execFileSync('git', ['diff', '--no-color', empty, large, '--'], {
      cwd: workspace,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.ok(rawDiff.length > 8 * 1024 * 1024);
    const bounded = await collectChangesSinceContext(workspace, empty, large, true);
    assert.ok(bounded);
    const match = bounded.match(
      /### Delta diff\n([\s\S]*)\n\n\[Delta diff truncated to (\d+) bytes; omitted (\d+) bytes\.\]/,
    );
    assert.ok(match);
    const [, prefix, kept, omitted] = match;
    assert.equal(Buffer.byteLength(prefix), Number(kept));
    assert.ok(Number(kept) <= CHANGES_SINCE_DIFF_BUDGET);
    assert.ok(Number(kept) >= CHANGES_SINCE_DIFF_BUDGET - 3);
    assert.equal(prefix, rawDiff.subarray(0, Number(kept)).toString('utf8'));
    assert.doesNotMatch(prefix, /\uFFFD/);
    assert.equal(Number(omitted), rawDiff.length - Number(kept));

    const blob = git('rev-parse', 'HEAD:large.txt');
    rmSync(join(workspace, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    await assert.rejects(
      collectChangesSinceContext(workspace, empty, large, true),
      /git diff failed/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
