import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_CONFIG_TIMEOUT_MS = 5_000;

export type GitConfigCommand = (args: string[]) => Promise<void>;

export async function ensureGitSafeDirectory(
  workspace: string,
  log: (msg: string) => void,
  runGitConfig: GitConfigCommand = runGitConfigCommand,
): Promise<void> {
  const directory = workspace.trim();
  if (!directory) return;

  try {
    await runGitConfig(['config', '--global', '--add', 'safe.directory', directory]);
    log(`Configured git safe.directory for ${directory}.`);
  } catch (error) {
    log(
      `Could not configure git safe.directory for ${directory}; git commands may fail: ${formatUnknownError(
        error,
      )}`,
    );
  }
}

async function runGitConfigCommand(args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    timeout: GIT_CONFIG_TIMEOUT_MS,
    maxBuffer: 256 * 1024,
  });
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
