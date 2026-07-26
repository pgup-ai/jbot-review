import { spawnSync } from 'node:child_process';

/**
 * Workspace checkout for a relayed session. Kept out of index.ts so the depth
 * decision is reachable from a test without dialling the gateway, and imports
 * nothing beyond node builtins so the companion stays extractable.
 */

// Depth 1 left the agent unable to run git log/diff against the PR base.
const INITIAL_DEPTH = 50;
const DEEPEN_STEPS = [200, 1_000];
const MAX_DEPTH = INITIAL_DEPTH + DEEPEN_STEPS.reduce((a, b) => a + b);

/**
 * Walks the deepen steps until the base is reachable. The caller supplies the
 * git effects, so the stop-or-fail decision stands on its own — a shallow
 * clone that cannot reach the base makes the merge-base diff the prompt
 * advertises impossible, and the agent has no way to recover the difference.
 */
export function deepenUntilBase(
  hasBase: () => boolean,
  deepen: (depth: number) => string | undefined,
): string | undefined {
  if (hasBase()) return undefined;
  for (const depth of DEEPEN_STEPS) {
    const failure = deepen(depth);
    if (failure) return failure;
    if (hasBase()) return undefined;
  }
  return `PR base is more than ${MAX_DEPTH} commits behind the reviewed ref.`;
}

/** argv-only git (the ref is remote-controlled input); best-effort — a fetch
 * failure refuses the session rather than running the agent on nothing. */
export function fetchWorkspace(
  workspace: string,
  repo: string,
  ref?: string,
  base?: string,
): string | undefined {
  const run = (args: string[]): string | undefined => {
    const result = spawnSync('git', args, { encoding: 'utf8', timeout: 120_000 });
    return result.status === 0
      ? undefined
      : `git ${args[0]} failed: ${(result.stderr || result.stdout || '').slice(0, 300)}`;
  };
  const depth = String(INITIAL_DEPTH);
  // `--` so a repo/ref starting with `-` can never become a git flag.
  const clone = run(['clone', '--depth', depth, '--no-tags', '--', repo, workspace]);
  if (clone) return clone;
  if (!ref) return undefined;
  const checkout =
    run(['-C', workspace, 'fetch', '--depth', depth, 'origin', '--', ref]) ??
    run(['-C', workspace, 'checkout', '--detach', 'FETCH_HEAD']);
  if (checkout || !base) return checkout;

  // merge-base needs both sides present, so the base is fetched too — the clone
  // itself only carries the default branch plus `ref`.
  const baseFetch = run(['-C', workspace, 'fetch', '--depth', depth, 'origin', '--', base]);
  if (baseFetch) return baseFetch;

  return deepenUntilBase(
    () =>
      spawnSync('git', ['-C', workspace, 'merge-base', base, 'HEAD'], { timeout: 120_000 })
        .status === 0,
    (step) =>
      run(['-C', workspace, 'fetch', `--deepen=${step}`, 'origin', '--', ref]) ??
      run(['-C', workspace, 'fetch', `--deepen=${step}`, 'origin', '--', base]),
  );
}
