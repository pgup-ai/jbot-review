import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function clonePr(
  cloneUrl: string,
  headRef: string,
  baseRef: string,
  token: string,
): { dir: string; cleanup: () => void } {
  const authUrl = cloneUrl.replace('https://', `https://x-access-token:${token}@`);
  const dir = mkdtempSync(join(tmpdir(), 'jbot-'));

  // Use spawnSync with an argv array (not a shell command) to avoid any
  // interpretation of the user-supplied branch names.
  const cloneRes = spawnSync('git', ['clone', '--depth=50', authUrl, '--branch', headRef, dir], {
    stdio: 'pipe',
  });
  if (cloneRes.status !== 0) {
    safeRm(dir);
    throw new Error(
      `Failed to clone PR branch: ${cloneRes.stderr?.toString().trim() ?? 'unknown error'}`,
    );
  }

  // base ref may not be fetchable; non-fatal.
  spawnSync('git', ['fetch', 'origin', `${baseRef}:${baseRef}`, '--depth=50'], {
    cwd: dir,
    stdio: 'pipe',
  });

  return { dir, cleanup: () => safeRm(dir) };
}

function safeRm(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
