import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { collectChangesSinceContext } from '../src/shared/changes-since.ts';

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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
