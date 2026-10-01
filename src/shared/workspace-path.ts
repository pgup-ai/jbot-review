import { realpathSync } from 'node:fs';
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
  // The trailing sep stops a sibling like `/repo-x` matching the `/repo` root.
  return target === root || target.startsWith(root + sep) ? target : undefined;
}

function tryRealpath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}
