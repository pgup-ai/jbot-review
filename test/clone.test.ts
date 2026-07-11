import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { clonePr } from '../src/app/clone.ts';

it('clones complete fork head and upstream base histories', () => {
  const root = mkdtempSync(join(tmpdir(), 'jbot-clone-test-'));
  const source = join(root, 'source');
  const headRemote = join(root, 'head.git');
  const baseRemote = join(root, 'base.git');
  const run = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

  let cleanup: (() => void) | undefined;
  try {
    run(root, ['init', '-q', '-b', 'main', source]);
    run(source, ['config', 'user.email', 't@t.local']);
    run(source, ['config', 'user.name', 't']);
    writeFileSync(join(source, 'shared.txt'), 'root\n');
    run(source, ['add', '.']);
    run(source, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'root']);

    const rootCommit = run(source, ['rev-parse', 'HEAD']);
    const tree = run(source, ['rev-parse', 'HEAD^{tree}']);
    const commitChain = (prefix: string) => {
      let parent = rootCommit;
      for (let i = 0; i < 300; i++) {
        parent = run(source, ['commit-tree', tree, '-p', parent, '-m', `${prefix} ${i}`]);
      }
      return parent;
    };
    const headSha = commitChain('head');
    const headTip = run(source, ['commit-tree', tree, '-p', headSha, '-m', 'newer head']);
    const baseSha = commitChain('base');
    run(source, ['update-ref', 'refs/heads/feature', headTip]);
    run(source, ['update-ref', 'refs/heads/main', baseSha]);
    const mergeBase = run(source, ['merge-base', 'main', 'feature']);

    run(root, ['clone', '-q', '--bare', source, headRemote]);
    run(headRemote, ['update-ref', '-d', 'refs/heads/main']);
    run(root, ['clone', '-q', '--bare', source, baseRemote]);
    run(baseRemote, ['update-ref', '-d', 'refs/heads/feature']);

    const headUrl = pathToFileURL(headRemote).href;
    const baseUrl = pathToFileURL(baseRemote).href;
    const cloned = clonePr({
      headCloneUrl: headUrl,
      headRef: 'feature',
      headSha,
      baseCloneUrl: baseUrl,
      baseSha,
      token: 'unused',
    });
    cleanup = cloned.cleanup;

    assert.equal(run(cloned.dir, ['rev-parse', 'HEAD']), headSha);
    assert.throws(() => run(cloned.dir, ['merge-base', baseSha, headSha]));
    cloned.prepareDiff();
    assert.equal(run(cloned.dir, ['merge-base', baseSha, headSha]), mergeBase);
    assert.equal(run(cloned.dir, ['remote', 'get-url', 'origin']), headUrl);
    assert.equal(run(cloned.dir, ['remote']), 'origin');
    assert.deepEqual(readdirSync(dirname(cloned.dir)), ['repo']);
  } finally {
    cleanup?.();
    rmSync(root, { recursive: true, force: true });
  }
});
