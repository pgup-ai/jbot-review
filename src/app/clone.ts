import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { onFatalSignal } from '../shared/signal-cleanup.ts';

const INITIAL_HISTORY_DEPTH = 50;
const HISTORY_DEEPEN_STEPS = [200, 1_000];
const MAX_HISTORY_DEPTH = INITIAL_HISTORY_DEPTH + HISTORY_DEEPEN_STEPS.reduce((a, b) => a + b);
const GIT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_COMMAND_MAX_BUFFER = 8 * 1024 * 1024;
const ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' x-access-token ;;
  *) printf '%s\\n' "$JBOT_GIT_TOKEN" ;;
esac
`;

export function clonePr({
  headCloneUrl,
  headRef,
  headSha,
  baseCloneUrl,
  baseSha,
  token,
}: {
  headCloneUrl: string;
  headRef: string;
  headSha: string;
  baseCloneUrl: string;
  baseSha: string;
  token: string;
}): { dir: string; prepareDiff: () => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'jbot-'));
  const dir = join(root, 'repo');
  const askpass = join(root, 'askpass.sh');
  // Guarded before the clone runs, not after it returns: cloning is the slowest
  // part of a run and leaves the largest thing behind if a signal cuts it short.
  const unregister = onFatalSignal(() => safeRm(root));
  const fail = (action: string, stderr?: string): never => {
    unregister();
    safeRm(root);
    throw new Error(stderr?.trim() ? `${action}: ${stderr.trim()}` : action);
  };
  const runGit = (args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env) => {
    const result = spawnSync('git', ['-c', 'credential.helper=', ...args], {
      cwd,
      env,
      stdio: 'pipe',
      timeout: GIT_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: GIT_COMMAND_MAX_BUFFER,
    });
    if (result.error) fail('Git command failed', result.error.message);
    if (result.signal) fail(`Git command terminated by ${result.signal}`);
    return result;
  };
  const withAuth = <T>(fn: (env: NodeJS.ProcessEnv) => T): T => {
    // Through fail() so a filesystem error unregisters and removes the root
    // like every other setup failure, instead of escaping with both live.
    try {
      writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
    } catch (error) {
      fail('Failed to write the git askpass helper', String(error));
    }
    try {
      return fn({
        ...process.env,
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: '0',
        JBOT_GIT_TOKEN: token,
      });
    } finally {
      rmSync(askpass, { force: true });
    }
  };
  // Head and base fetches alternate into one shallow repo and each rewrites
  // .git/shallow, so git can reject the next fetch as racing itself. The retry
  // re-reads the settled file; a real failure fails again the same way.
  const fetchCommit = (url: string, sha: string, depth: string, env: NodeJS.ProcessEnv) => {
    const result = runGit(['fetch', '--no-tags', depth, url, sha], dir, env);
    if (result.status === 0 || !/shallow file has changed/i.test(String(result.stderr ?? ''))) {
      return result;
    }
    return runGit(['fetch', '--no-tags', depth, url, sha], dir, env);
  };

  // Use argv arrays throughout so branch names never pass through a shell.
  withAuth((env) => {
    const cloneRes = runGit(
      [
        'clone',
        '--no-tags',
        '--single-branch',
        `--depth=${INITIAL_HISTORY_DEPTH}`,
        '--branch',
        headRef,
        headCloneUrl,
        dir,
      ],
      undefined,
      env,
    );
    if (cloneRes.status !== 0) fail('Failed to clone PR branch', cloneRes.stderr?.toString());

    const headRes = fetchCommit(headCloneUrl, headSha, `--depth=${INITIAL_HISTORY_DEPTH}`, env);
    if (headRes.status !== 0) fail('Failed to fetch PR head commit', headRes.stderr?.toString());
    const baseRes = fetchCommit(baseCloneUrl, baseSha, `--depth=${INITIAL_HISTORY_DEPTH}`, env);
    if (baseRes.status !== 0) fail('Failed to fetch PR base commit', baseRes.stderr?.toString());
  });

  const checkoutRes = runGit(['checkout', '--detach', headSha], dir);
  if (checkoutRes.status !== 0)
    fail('Failed to check out PR head commit', checkoutRes.stderr?.toString());

  const hasMergeBase = () => runGit(['merge-base', baseSha, headSha], dir).status === 0;
  const prepareDiff = () => {
    if (hasMergeBase()) return;
    withAuth((env) => {
      for (const deepen of HISTORY_DEEPEN_STEPS) {
        const headRes = fetchCommit(headCloneUrl, headSha, `--deepen=${deepen}`, env);
        if (headRes.status !== 0)
          fail('Failed to deepen PR head history', headRes.stderr?.toString());
        const baseRes = fetchCommit(baseCloneUrl, baseSha, `--deepen=${deepen}`, env);
        if (baseRes.status !== 0)
          fail('Failed to deepen PR base history', baseRes.stderr?.toString());
        if (hasMergeBase()) return;
      }
    });
    if (!hasMergeBase()) {
      fail(`PR merge base exceeds the ${MAX_HISTORY_DEPTH}-commit history limit`);
    }
  };

  return {
    dir,
    prepareDiff,
    cleanup: () => {
      unregister();
      safeRm(root);
    },
  };
}

function safeRm(path: string): void {
  try {
    // One pass leaked a whole clone per review: rmdir reports ENOTEMPTY on a
    // root that is already empty by the time anything looks, with no git
    // process left holding it. Retrying settles it.
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (error) {
    // Best effort, but not silent: swallowing this is what hid a leaked clone
    // per review, and the errno is the only way to tell a losable race from a
    // permanent failure.
    console.warn(`[jbot-review] could not remove ${path}: ${String(error)}`);
  }
}
