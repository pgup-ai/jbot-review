import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_CONFIG_TIMEOUT_MS = 5_000;

/** Runs `git <args>` and returns stdout (empty string on a read miss). */
export type GitConfigCommand = (args: string[]) => Promise<string>;

/**
 * Marks `workspace` a safe git directory so git commands (including the ones
 * opencode runs itself inside bash) don't refuse with "dubious ownership" when
 * the checkout is owned by a different uid than the runner — the case in the
 * Docker action where `/github/workspace` is bind-mounted.
 *
 * The entry must be global because we can't inject `-c safe.directory` into the
 * git invocations opencode makes internally. To keep a long-lived (app-mode)
 * runner from appending a duplicate entry on every review, skip the write when
 * the path is already marked safe. Best-effort: a failure is logged, not
 * thrown, so a missing/locked git config never fails the run.
 */
export async function ensureGitSafeDirectory(
  workspace: string,
  log: (msg: string) => void,
  runGitConfig: GitConfigCommand = runGitConfigCommand,
): Promise<void> {
  const directory = workspace.trim();
  if (!directory) return;

  try {
    const existing = await runGitConfig(['config', '--global', '--get-all', 'safe.directory']);
    if (existing.split('\n').some((line) => line.trim() === directory)) return;

    await runGitConfig(['config', '--global', '--add', 'safe.directory', directory]);
    log(`Configured git safe.directory for ${directory}.`);
  } catch (error) {
    log(
      `Could not configure git safe.directory for ${directory}; git commands may fail: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function runGitConfigCommand(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: GIT_CONFIG_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return stdout;
  } catch (error) {
    // `git config --get-all` exits 1 when the key is unset — treat that read
    // miss as "no entries" so we fall through to the add. A failing `--add`
    // (or a genuinely broken git) still propagates to the caller's catch.
    if (args.includes('--get-all')) return '';
    throw error;
  }
}
