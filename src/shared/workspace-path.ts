import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';

export function resolveWithinWorkspace(
  workspace: string,
  requestedPath: string,
): string | undefined {
  // Canonicalize both sides through realpath: a lexical check alone is bypassed
  // by a symlink inside the checkout that points out (readFileSync follows it).
  // realpath resolves symlinks, `..`, and absolute paths; a missing/unreadable
  // path throws → undefined (nothing to read, no leak).
  const root = tryRealpath(resolve(workspace));
  if (!root) return undefined;
  const target = tryRealpath(resolve(root, requestedPath));
  if (!target) return undefined;
  // The trailing sep stops a sibling like `/repo-x` matching the `/repo` root;
  // a filesystem-root workspace already ends in one.
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
    ? target
    : undefined;
}

function tryRealpath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Whether an open descriptor still holds the in-workspace file `target` names:
 * the path resolves to itself inside the root and names the descriptor's own
 * file (dev/ino). A parent directory swapped for a symlink fails it.
 */
export function openedFileWithinWorkspace(root: string, target: string, fd: number): boolean {
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || resolveWithinWorkspace(root, target) !== target) return false;
    const named = statSync(target);
    return named.dev === opened.dev && named.ino === opened.ino;
  } catch {
    return false;
  }
}

/**
 * Reads a file resolveWithinWorkspace accepted without a check-then-use gap:
 * O_NOFOLLOW guards only the last component, so the descriptor is checked
 * after opening and the read comes from that same descriptor.
 */
export function readFileWithinWorkspace(root: string, target: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    return undefined;
  }
  try {
    return openedFileWithinWorkspace(root, target, fd) ? readFileSync(fd, 'utf8') : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
