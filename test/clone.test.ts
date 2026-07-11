import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

    run(source, ['switch', '-qc', 'feature']);
    for (let i = 0; i < 51; i++) {
      writeFileSync(join(source, 'head.txt'), `${i}\n`);
      run(source, ['add', '.']);
      run(source, ['-c', 'commit.gpgsign=false', 'commit', '-qm', `head ${i}`]);
    }
    const headSha = run(source, ['rev-parse', 'HEAD']);

    run(source, ['switch', '-q', 'main']);
    for (let i = 0; i < 51; i++) {
      writeFileSync(join(source, 'base.txt'), `${i}\n`);
      run(source, ['add', '.']);
      run(source, ['-c', 'commit.gpgsign=false', 'commit', '-qm', `base ${i}`]);
    }
    const baseSha = run(source, ['rev-parse', 'HEAD']);
    const mergeBase = run(source, ['merge-base', 'main', 'feature']);

    run(root, ['clone', '-q', '--bare', source, headRemote]);
    run(headRemote, ['update-ref', '-d', 'refs/heads/main']);
    run(root, ['clone', '-q', '--bare', source, baseRemote]);
    run(baseRemote, ['update-ref', '-d', 'refs/heads/feature']);

    const headUrl = pathToFileURL(headRemote).href;
    const baseUrl = pathToFileURL(baseRemote).href;
    const cloned = clonePr(headUrl, 'feature', baseUrl, 'main', 'unused');
    cleanup = cloned.cleanup;

    assert.equal(run(cloned.dir, ['merge-base', baseSha, headSha]), mergeBase);
    assert.equal(run(cloned.dir, ['remote', 'get-url', 'origin']), headUrl);
    assert.equal(run(cloned.dir, ['remote']), 'origin');
  } finally {
    cleanup?.();
    rmSync(root, { recursive: true, force: true });
  }
});
