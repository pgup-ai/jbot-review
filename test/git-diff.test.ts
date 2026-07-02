import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { GIT_DIFF_ARGS, parseGitDiff } from '../src/local/git-diff.ts';
import { parseAddedLines } from '../src/shared/patch.ts';

describe('parseGitDiff', () => {
  it('returns an empty list for empty input', () => {
    assert.deepEqual(parseGitDiff(''), []);
  });

  it('splits multi-file diffs and strips file headers down to GitHub-shaped hunks', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' one',
      '+two',
      ' three',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 3333333..4444444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -5,2 +5,2 @@',
      '-x',
      '+y',
      ' z',
      '',
    ].join('\n');
    assert.deepEqual(parseGitDiff(diff), [
      { filename: 'src/a.ts', patch: '@@ -1,2 +1,3 @@\n one\n+two\n three' },
      { filename: 'src/b.ts', patch: '@@ -5,2 +5,2 @@\n-x\n+y\n z' },
    ]);
  });

  it('uses the new path for renames with edits', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '',
    ].join('\n');
    assert.deepEqual(parseGitDiff(diff), [
      { filename: 'src/new.ts', patch: '@@ -1 +1 @@\n-a\n+b' },
    ]);
  });

  it('yields a patchless entry for a pure rename (no hunks)', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '',
    ].join('\n');
    assert.deepEqual(parseGitDiff(diff), [{ filename: 'src/new.ts' }]);
  });

  it('keeps the old path for deletions, matching GitHub', () => {
    const diff = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      '',
    ].join('\n');
    assert.deepEqual(parseGitDiff(diff), [
      { filename: 'src/gone.ts', patch: '@@ -1,2 +0,0 @@\n-a\n-b' },
    ]);
  });

  it('handles new files', () => {
    const diff = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+a',
      '+b',
      '',
    ].join('\n');
    assert.deepEqual(parseGitDiff(diff), [
      { filename: 'src/new.ts', patch: '@@ -0,0 +1,2 @@\n+a\n+b' },
    ]);
  });

  it('yields patchless entries for binary files (name from the diff --git line)', () => {
    const diff = [
      'diff --git a/img/logo.png b/img/logo.png',
      'new file mode 100644',
      'index 0000000..1111111',
      'Binary files /dev/null and b/img/logo.png differ',
      '',
    ].join('\n');
    assert.deepEqual(parseGitDiff(diff), [{ filename: 'img/logo.png' }]);
  });

  it('yields patchless entries for mode-only changes', () => {
    const diff = ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join(
      '\n',
    );
    assert.deepEqual(parseGitDiff(diff), [{ filename: 'run.sh' }]);
  });

  it('keeps raw UTF-8 paths (core.quotePath=false)', () => {
    const diff = [
      'diff --git a/docs/说明.md b/docs/说明.md',
      'index 1111111..2222222 100644',
      '--- a/docs/说明.md',
      '+++ b/docs/说明.md',
      '@@ -1 +1 @@',
      '-旧',
      '+新',
      '',
    ].join('\n');
    assert.equal(parseGitDiff(diff)[0].filename, 'docs/说明.md');
  });

  it('keeps no-newline markers verbatim inside the patch', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,2 @@',
      ' context',
      '-old',
      '\\ No newline at end of file',
      '+old2',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const [file] = parseGitDiff(diff);
    assert.ok(file.patch?.includes('\\ No newline at end of file'));
    // Round-trip: the produced patch anchors exactly like a GitHub patch.
    assert.deepEqual(parseAddedLines(file.patch), new Set([2]));
  });

  it('does not split on added content lines that contain diff headers', () => {
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      'index 1111111..2222222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1 +1,2 @@',
      ' keep',
      '+diff --git a/x b/y',
      '',
    ].join('\n');
    const files = parseGitDiff(diff);
    assert.equal(files.length, 1);
    assert.ok(files[0].patch?.endsWith('+diff --git a/x b/y'));
  });

  it('anchors added lines identically to GitHub patches (parseAddedLines round-trip)', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' a',
      '+b',
      ' c',
      ' d',
      '@@ -10,2 +11,3 @@',
      ' x',
      '+y',
      '+z',
      '',
    ].join('\n');
    assert.deepEqual(parseAddedLines(parseGitDiff(diff)[0].patch), new Set([2, 12, 13]));
  });
});

// Config-drift canary: run REAL git with the driver's exact args in a repo
// whose config rewrites the diff output shape. If a git version or a new
// config key ever escapes the GIT_DIFF_ARGS pins, this is what catches it.
describe('GIT_DIFF_ARGS vs hostile gitconfig (real git)', () => {
  it('keeps a/ b/ prefixes under noprefix/mnemonicPrefix/srcPrefix overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jbot-gitdiff-'));
    try {
      const run = (args: string[]) => execFileSync('git', args, { cwd: dir });
      run(['init', '-q', '-b', 'main']);
      run(['config', 'user.email', 't@t.local']);
      run(['config', 'user.name', 't']);
      // Hostile output-shape config the pins must neutralize. srcPrefix and
      // dstPrefix are git >=2.45; older gits leave them unused, which only
      // makes the test less adversarial, never wrong.
      run(['config', 'diff.noprefix', 'true']);
      run(['config', 'diff.mnemonicPrefix', 'true']);
      run(['config', 'diff.srcPrefix', 'x/']);
      run(['config', 'diff.dstPrefix', 'y/']);
      writeFileSync(join(dir, 'f.txt'), 'a\n');
      run(['add', '.']);
      run(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'c1']);
      writeFileSync(join(dir, 'f.txt'), 'b\n');
      const out = execFileSync('git', [...GIT_DIFF_ARGS, 'HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.deepEqual(parseGitDiff(out), [{ filename: 'f.txt', patch: '@@ -1 +1 @@\n-a\n+b' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
