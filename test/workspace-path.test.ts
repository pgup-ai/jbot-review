import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveWithinWorkspace } from '../src/shared/workspace-path.ts';

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
});
