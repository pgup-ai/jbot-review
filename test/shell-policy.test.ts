import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASH_PERMISSIONS } from '../src/shared/shell-policy.ts';

// opencode's documented wildcard semantics: `*` matches zero+ chars, `?` exactly one.
const matches = (pattern: string, command: string): boolean =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  ).test(command);

const isDenied = (command: string): boolean =>
  Object.entries(BASH_PERMISSIONS).some(([p, a]) => a === 'deny' && matches(p, command));

describe('BASH_PERMISSIONS', () => {
  it('never yields "ask" — an interactive prompt would hang a headless run', () => {
    assert.equal(
      BASH_PERMISSIONS['*'],
      'allow',
      'a catch-all allow must exist: unmatched commands default to ask',
    );
    assert.ok(!Object.values(BASH_PERMISSIONS).includes('ask' as never));
  });

  it('denies the mutating commands an honest model might reach for', () => {
    for (const command of [
      'git commit -m x',
      'git push origin main',
      'git checkout .',
      'git switch main',
      'git reset --hard HEAD',
      'git clean -fd',
      'git stash push',
      'git restore .',
      'git rm -r src',
      'git mv a b',
      'git rebase main',
      'git merge origin/main',
      'git merge',
      'git cherry-pick abc123',
      'git revert HEAD',
      'git apply patch.diff',
      'git am patch.mbox',
      'rm -rf src',
    ]) {
      assert.ok(isDenied(command), `expected deny for: ${command}`);
    }
  });

  it('leaves git reads untouched, including read-dominant subcommands', () => {
    for (const command of [
      'git diff --stat base...head',
      'git log --oneline -20',
      'git grep -n TODO',
      'git show HEAD:src/index.ts',
      'git status --short',
      'git rev-parse HEAD',
      'git blame src/index.ts',
      'git ls-files',
      // Read-only siblings an over-broad `git merge*`/`git cherry*` would swallow.
      'git merge-base main HEAD',
      'git merge-tree main HEAD',
      'git cherry main',
      'git branch',
      'git tag',
      'git worktree list',
      'git submodule status',
      'grep -rn foo src',
    ]) {
      assert.ok(!isDenied(command), `must not deny: ${command}`);
    }
  });
});
