import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import {
  buildChangesSinceContextBlock,
  CHANGES_SINCE_DIFF_BUDGET,
  CHANGES_SINCE_STAT_BUDGET,
} from './prompt.ts';

const execFileAsync = promisify(execFile);

export async function collectChangesSinceContext(
  workspace: string,
  fromSha: string,
  toSha: string,
  embedDiff: boolean,
  baseSha?: string,
): Promise<string | undefined> {
  const options = { cwd: workspace, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 };
  const range = `${fromSha}..${toSha}`;
  const git = async (...args: string[]) => (await execFileAsync('git', args, options)).stdout;
  const subjectsOf = async (...args: string[]) =>
    (await git('log', '--format=%h %s', ...args)).split('\n').filter(Boolean);
  // A merge from the base branch brings its commits into the range; they are not this PR's changes.
  const own = baseSha ? [range, `^${baseSha}`] : [range];
  let subjects = await subjectsOf('--no-merges', ...own);
  const baseMerged =
    baseSha && (await subjectsOf('--no-merges', range)).length > subjects.length
      ? baseSha
      : undefined;
  // A conflict resolution in the PR's merge commit is PR work; `--cc` prints only resolutions.
  if (baseMerged && (await git('log', '--merges', '--cc', '--format=', ...own)).trim())
    subjects = await subjectsOf(...own);
  if (subjects.length === 0) return undefined;
  const diff = embedDiff
    ? await collectGitOutput(
        workspace,
        baseMerged
          ? [
              'log',
              '--cc',
              '--format=commit %h %s',
              '--no-color',
              '--no-ext-diff',
              '--no-textconv',
              ...own,
            ]
          : ['diff', '--no-color', '--no-ext-diff', '--no-textconv', range, '--'],
        CHANGES_SINCE_DIFF_BUDGET,
      )
    : undefined;
  let stat: { text: string; totalBytes: number } | null | undefined;
  if (embedDiff) {
    try {
      stat = await collectGitOutput(
        workspace,
        baseMerged
          ? [
              'log',
              '--no-merges',
              '--format=commit %h %s',
              '--stat=120',
              '--no-ext-diff',
              '--no-textconv',
              ...own,
            ]
          : ['diff', '--stat=120', '--no-ext-diff', '--no-textconv', range, '--'],
        CHANGES_SINCE_STAT_BUDGET,
      );
    } catch {
      stat = null;
    }
  }
  return buildChangesSinceContextBlock(fromSha, toSha, subjects, diff, stat, baseMerged);
}

function collectGitOutput(
  workspace: string,
  args: string[],
  budget: number,
): Promise<{ text: string; totalBytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: workspace,
      timeout: 15_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const prefix = Buffer.alloc(budget);
    let keptBytes = 0;
    let totalBytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const bytes = Buffer.from(chunk);
      keptBytes += bytes.copy(prefix, keptBytes);
      totalBytes += bytes.length;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`git output failed (${signal ?? code})`));
        return;
      }
      resolve({ text: new StringDecoder('utf8').write(prefix.subarray(0, keptBytes)), totalBytes });
    });
  });
}
