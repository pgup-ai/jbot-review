import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildChangesSinceContextBlock } from './prompt.ts';

const execFileAsync = promisify(execFile);

export async function collectChangesSinceContext(
  workspace: string,
  fromSha: string,
  toSha: string,
  embedDiff: boolean,
): Promise<string | undefined> {
  const options = { cwd: workspace, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 };
  const range = `${fromSha}..${toSha}`;
  const { stdout } = await execFileAsync(
    'git',
    ['log', '--no-merges', '--format=%h %s', range],
    options,
  );
  const subjects = stdout.split('\n').filter(Boolean);
  if (subjects.length === 0) return undefined;
  const diff = embedDiff
    ? (
        await execFileAsync(
          'git',
          ['diff', '--no-color', '--no-ext-diff', '--no-textconv', range, '--'],
          options,
        )
      ).stdout
    : undefined;
  return buildChangesSinceContextBlock(fromSha, toSha, subjects, diff);
}
