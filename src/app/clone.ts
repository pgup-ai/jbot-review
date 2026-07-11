import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INITIAL_HISTORY_DEPTH = 50;
const HISTORY_DEEPEN_STEPS = [200, 1_000];
const MAX_HISTORY_DEPTH = INITIAL_HISTORY_DEPTH + HISTORY_DEEPEN_STEPS.reduce((a, b) => a + b);
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
  baseRef,
  baseSha,
  token,
}: {
  headCloneUrl: string;
  headRef: string;
  headSha: string;
  baseCloneUrl: string;
  baseRef: string;
  baseSha: string;
  token: string;
}): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'jbot-'));
  const dir = join(root, 'repo');
  const askpass = join(root, 'askpass.sh');
  writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
  const gitEnv = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    JBOT_GIT_TOKEN: token,
  };
  const runGit = (args: string[], cwd?: string) =>
    spawnSync('git', ['-c', 'credential.helper=', ...args], {
      cwd,
      env: gitEnv,
      stdio: 'pipe',
    });
  const fail = (action: string, stderr?: string): never => {
    safeRm(root);
    throw new Error(stderr?.trim() ? `${action}: ${stderr.trim()}` : action);
  };

  // Use argv arrays throughout so branch names never pass through a shell.
  const cloneRes = runGit([
    'clone',
    '--no-tags',
    '--single-branch',
    `--depth=${INITIAL_HISTORY_DEPTH}`,
    '--branch',
    headRef,
    headCloneUrl,
    dir,
  ]);
  if (cloneRes.status !== 0) fail('Failed to clone PR branch', cloneRes.stderr?.toString());

  const baseRefspec = `refs/heads/${baseRef}:refs/remotes/base/${baseRef}`;
  const fetchBase = (depthArg: string) =>
    runGit(['fetch', '--no-tags', depthArg, baseCloneUrl, baseRefspec], dir);
  const initialBaseRes = fetchBase(`--depth=${INITIAL_HISTORY_DEPTH}`);
  if (initialBaseRes.status !== 0)
    fail('Failed to fetch PR base branch', initialBaseRes.stderr?.toString());

  const hasMergeBase = () => runGit(['merge-base', baseSha, headSha], dir).status === 0;
  for (const deepen of HISTORY_DEEPEN_STEPS) {
    if (hasMergeBase()) break;
    const deepenHeadRes = runGit(
      ['fetch', '--no-tags', `--deepen=${deepen}`, 'origin', `refs/heads/${headRef}`],
      dir,
    );
    if (deepenHeadRes.status !== 0)
      fail('Failed to deepen PR head history', deepenHeadRes.stderr?.toString());
    const deepenBaseRes = fetchBase(`--deepen=${deepen}`);
    if (deepenBaseRes.status !== 0)
      fail('Failed to deepen PR base history', deepenBaseRes.stderr?.toString());
  }
  if (!hasMergeBase()) {
    fail(`PR merge base exceeds the ${MAX_HISTORY_DEPTH}-commit history limit`);
  }

  rmSync(askpass, { force: true });
  return { dir, cleanup: () => safeRm(root) };
}

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
