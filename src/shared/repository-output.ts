import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { formatRepositoryPage, REPOSITORY_PAGE_BYTES } from './prompt.ts';

export async function readRepositoryPage(
  source: Readable,
  options: { offset?: unknown; line?: unknown } = {},
) {
  try {
    const requestedOffset = options.offset ?? 0;
    const requestedLine = options.offset === undefined ? (options.line ?? 1) : 1;
    if (!Number.isSafeInteger(requestedOffset) || (requestedOffset as number) < 0)
      throw new Error('offset must be a nonnegative integer');
    if (!Number.isSafeInteger(requestedLine) || (requestedLine as number) < 1)
      throw new Error('line must be a positive integer');
    const page = Buffer.alloc(REPOSITORY_PAGE_BYTES - 256);
    let kept = 0;
    let totalBytes = 0;
    let line = 1;
    let offset: number | undefined;
    // Exact totals require draining the stream; continuation requests scan it again.
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      if (offset === undefined) {
        let start = 0;
        if (options.offset !== undefined) {
          start = Math.min(bytes.length, (requestedOffset as number) - totalBytes);
          for (let i = 0; i < start; i++) if (bytes[i] === 10) line++;
        } else {
          while (line < (requestedLine as number) && start < bytes.length) {
            if (bytes[start++] === 10) line++;
          }
        }
        if (start < bytes.length) {
          if ((bytes[start] & 0xc0) === 0x80)
            throw new Error('offset must be on a UTF-8 character boundary');
          offset = totalBytes + start;
        }
      }
      if (offset !== undefined) kept += bytes.copy(page, kept, Math.max(0, offset - totalBytes));
      totalBytes += bytes.length;
    }
    if ((requestedOffset as number) > totalBytes)
      throw new Error('offset must be within the output');
    const text = new StringDecoder('utf8').write(page.subarray(0, kept));
    return {
      ...formatRepositoryPage({ text, offset: offset ?? totalBytes, line, totalBytes }),
      totalBytes,
    };
  } finally {
    source.destroy();
  }
}

export async function gitRepositoryPage(
  workspace: string,
  args: string[],
  options: { offset?: unknown } = {},
) {
  const child = spawn('git', args, {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (timedOut) reject(new Error('git output timed out after 30s'));
      else if (code === 0 || (code === 1 && args.includes('grep'))) resolve();
      else reject(new Error(`git output failed (${signal ?? code})`));
    });
  });
  child.stdout.setEncoding('utf8');
  try {
    const [page] = await Promise.all([readRepositoryPage(child.stdout, options), closed]);
    return page;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed.catch(() => undefined);
  }
}
