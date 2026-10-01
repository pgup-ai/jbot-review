import assert from 'node:assert/strict';
import {
  closeSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse } from 'node:path';
import { describe, it } from 'node:test';

import {
  openedFileWithinWorkspace,
  readFileWithinWorkspace,
  resolveWithinWorkspace,
} from '../src/shared/workspace-path.ts';

describe('resolveWithinWorkspace', () => {
  // Security boundary for reads served outside a sandbox; follows symlinks, so
  // it runs against a real filesystem.
  it('confines to the real workspace and refuses symlink + lexical escapes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'out-')));
    writeFileSync(join(root, 'inside.txt'), 'x');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'evil')); // escapes the repo
    symlinkSync(join(root, 'inside.txt'), join(root, 'alias')); // stays inside
    const sibling = `${root}-sib`; // shares the root's prefix but not its directory
    writeFileSync(sibling, 'x');
    try {
      assert.equal(resolveWithinWorkspace(root, '.'), root); // callers check the root first
      assert.equal(resolveWithinWorkspace(root, 'alias'), join(root, 'inside.txt'));
      assert.equal(resolveWithinWorkspace(root, sibling), undefined);
      // A filesystem-root workspace already ends in a separator and keeps its children.
      assert.equal(resolveWithinWorkspace(parse(root).root, outside), outside);
      assert.equal(resolveWithinWorkspace(root, 'inside.txt'), join(root, 'inside.txt'));
      assert.equal(resolveWithinWorkspace(root, 'evil'), undefined); // P0: symlink escape
      assert.equal(resolveWithinWorkspace(root, '/etc/hosts'), undefined); // absolute
      // `..` into a sibling that exists whatever the TMPDIR depth.
      assert.equal(
        resolveWithinWorkspace(root, join('..', basename(outside), 'secret.txt')),
        undefined,
      );
      assert.equal(resolveWithinWorkspace(root, 'missing.txt'), undefined); // non-existent
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(sibling, { force: true });
    }
  });

  it('reads only the validated file when a path component is swapped after the check', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'out-')));
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'f.txt'), 'inside');
    writeFileSync(join(root, 'g.txt'), 'inside');
    writeFileSync(join(outside, 'f.txt'), 'SECRET');
    writeFileSync(join(outside, 'g.txt'), 'SECRET');
    try {
      const nested = resolveWithinWorkspace(root, 'dir/f.txt')!;
      const leaf = resolveWithinWorkspace(root, 'g.txt')!;
      assert.equal(readFileWithinWorkspace(root, nested), 'inside');
      assert.equal(readFileWithinWorkspace(root, join(root, 'dir')), undefined); // not a file
      // The validated file itself becomes a symlink out: O_NOFOLLOW refuses it.
      rmSync(leaf);
      symlinkSync(join(outside, 'g.txt'), leaf);
      assert.equal(readFileWithinWorkspace(root, leaf), undefined);
      // A parent directory becomes a symlink out: the open follows it, the recheck rejects it.
      renameSync(join(root, 'dir'), join(root, 'dir-old'));
      symlinkSync(outside, join(root, 'dir'));
      assert.equal(readFileWithinWorkspace(root, nested), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a descriptor once its path names a different file', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const target = join(root, 'f.txt');
    writeFileSync(target, 'first');
    const fd = openSync(target, 'r');
    try {
      assert.equal(openedFileWithinWorkspace(root, target, fd), true);
      // Same canonical path, new inode: only the dev/ino comparison can tell.
      rmSync(target);
      writeFileSync(target, 'second');
      assert.equal(openedFileWithinWorkspace(root, target, fd), false);
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
