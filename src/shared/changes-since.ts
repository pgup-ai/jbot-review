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
  const log = async (...args: string[]) =>
    (await execFileAsync('git', ['log', '--no-merges', '--format=%h %s', ...args], options)).stdout
      .split('\n')
      .filter(Boolean);
  // A merge from the base branch brings its commits into the range; they are not this PR's changes.
  const subjects = await log(range, ...(baseSha ? [`^${baseSha}`] : []));
  if (subjects.length === 0) return undefined;
  const baseMerged = baseSha && (await log(range)).length > subjects.length ? baseSha : undefined;
  // A range diff would carry the merged base changes too; the PR commits' own patches do not.
  const delta = baseMerged
    ? (...args: string[]) => [
        'log',
        '--no-merges',
        '--format=commit %h %s',
        ...args,
        range,
        `^${baseMerged}`,
      ]
    : (...args: string[]) => ['diff', ...args, range, '--'];
  const diff = embedDiff
    ? await collectGitOutput(
        workspace,
        delta('-p', '--no-color', '--no-ext-diff', '--no-textconv'),
        CHANGES_SINCE_DIFF_BUDGET,
      )
    : undefined;
  let stat: { text: string; totalBytes: number } | null | undefined;
  if (embedDiff) {
    try {
      stat = await collectGitOutput(
        workspace,
        delta('--stat=120', '--no-ext-diff', '--no-textconv'),
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
