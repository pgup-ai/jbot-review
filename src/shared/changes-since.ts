import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { buildChangesSinceContextBlock, CHANGES_SINCE_DIFF_BUDGET } from './prompt.ts';

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
    ? await new Promise<{ text: string; totalBytes: number }>((resolve, reject) => {
        const child = spawn(
          'git',
          ['diff', '--no-color', '--no-ext-diff', '--no-textconv', range, '--'],
          {
            cwd: workspace,
            timeout: 15_000,
            killSignal: 'SIGKILL',
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        );
        const prefix = Buffer.alloc(CHANGES_SINCE_DIFF_BUDGET);
        let keptBytes = 0;
        let totalBytes = 0;
        child.stdout.on('data', (chunk: Buffer) => {
          keptBytes += chunk.copy(prefix, keptBytes);
          totalBytes += chunk.length;
        });
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (code !== 0) {
            reject(new Error(`git diff failed (${signal ?? code})`));
            return;
          }
          resolve({
            // Do not flush a partial UTF-8 character at the byte cap.
            text: new StringDecoder('utf8').write(prefix.subarray(0, keptBytes)),
            totalBytes,
          });
        });
      })
    : undefined;
  return buildChangesSinceContextBlock(fromSha, toSha, subjects, diff);
}
