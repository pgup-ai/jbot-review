import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function clonePr(
  headCloneUrl: string,
  headRef: string,
  baseCloneUrl: string,
  baseRef: string,
  token: string,
): { dir: string; cleanup: () => void } {
  const authHeadUrl = authenticateUrl(headCloneUrl, token);
  const authBaseUrl = authenticateUrl(baseCloneUrl, token);
  const dir = mkdtempSync(join(tmpdir(), 'jbot-'));

  // Use spawnSync with an argv array (not a shell command) to avoid any
  // interpretation of the user-supplied branch names.
  const cloneRes = spawnSync(
    'git',
    ['clone', '--no-tags', '--single-branch', '--branch', headRef, authHeadUrl, dir],
    { stdio: 'pipe' },
  );
  if (cloneRes.status !== 0) {
    safeRm(dir);
    throw new Error(`Failed to clone PR branch: ${scrubCredential(cloneRes.stderr?.toString())}`);
  }

  const fetchBaseRes = spawnSync(
    'git',
    ['fetch', '--no-tags', authBaseUrl, `refs/heads/${baseRef}:refs/remotes/base/${baseRef}`],
    { cwd: dir, stdio: 'pipe' },
  );
  if (fetchBaseRes.status !== 0) {
    safeRm(dir);
    throw new Error(
      `Failed to fetch PR base branch: ${scrubCredential(fetchBaseRes.stderr?.toString())}`,
    );
  }

  // Model sessions need the histories, never the installation credential.
  const sanitizeRes = spawnSync('git', ['remote', 'set-url', 'origin', headCloneUrl], {
    cwd: dir,
    stdio: 'pipe',
  });
  if (sanitizeRes.status !== 0) {
    safeRm(dir);
    throw new Error('Failed to remove credentials from the origin remote');
  }

  return { dir, cleanup: () => safeRm(dir) };
}

function authenticateUrl(url: string, token: string): string {
  return url.replace('https://', `https://x-access-token:${token}@`);
}

function scrubCredential(stderr?: string): string {
  return (stderr?.trim() || 'unknown error').replace(
    /x-access-token:[^@]+@/g,
    'x-access-token:***@',
  );
}

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
