import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveWithinWorkspace } from './pi.ts';
import { formatFindingSources, type FindingSource } from './prompt.ts';
import type { Finding } from './types.ts';

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SOURCE_LOCATIONS = 20;

export function findingSourceLocations(findings: Pick<Finding, 'path' | 'line' | 'body'>[]) {
  const locations = new Map<string, { path: string; line: number }>();
  for (const finding of findings) {
    const refs = [
      ...finding.body
        .slice(0, 8192)
        .matchAll(/`([^`\r\n]+):([1-9]\d*)`|(?:^|[\s(])([\p{L}\p{N}_./@-]+):([1-9]\d*)\b/gu),
    ]
      .slice(0, 2)
      .map((match) => ({ path: match[1] ?? match[3], line: Number(match[2] ?? match[4]) }));
    for (const ref of [{ path: finding.path, line: finding.line }, ...refs]) {
      if (
        !Number.isSafeInteger(ref.line) ||
        ref.line < 1 ||
        !ref.path ||
        ref.path.length > 512 ||
        isAbsolute(ref.path) ||
        /[\p{Cc}\\]/u.test(ref.path) ||
        ref.path.split('/').some((part) => part === '..' || part === '.git')
      )
        continue;
      locations.set(`${ref.path}:${ref.line}`, ref);
    }
  }
  return [...locations.values()];
}

export async function buildFindingSourceContext(
  workspace: string,
  findings: Finding[],
): Promise<string> {
  const locations = findingSourceLocations(findings);
  const root = resolveWithinWorkspace(workspace, '.');
  const files = new Map<string, Promise<string | undefined>>();
  const signal = AbortSignal.timeout(1500);

  async function readSource(path: string): Promise<string | undefined> {
    if (!root) return undefined;
    const target = resolveWithinWorkspace(root, path);
    // Tracked source only: never follow a cited symlink into runtime credentials.
    if (!target || target !== resolve(root, path)) return undefined;
    try {
      await execFileAsync(
        'git',
        ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', path],
        {
          cwd: root,
          signal,
          maxBuffer: 2048,
        },
      );
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return undefined;
        const buffer = Buffer.alloc(MAX_SOURCE_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (buffer.subarray(0, bytesRead).includes(0)) return undefined;
        const text = buffer.toString('utf8', 0, bytesRead);
        return stat.size > bytesRead ? text.slice(0, Math.max(0, text.lastIndexOf('\n'))) : text;
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }

  const sources: FindingSource[] = await Promise.all(
    locations.slice(0, MAX_SOURCE_LOCATIONS).map(async (ref) => {
      let file = files.get(ref.path);
      if (!file) {
        file = readSource(ref.path);
        files.set(ref.path, file);
      }
      const text = await file;
      if (!text) return { ...ref };
      const lines = text.split(/\r?\n/);
      if (ref.line > lines.length) return { ...ref };
      const startLine = Math.max(1, ref.line - 20);
      return { ...ref, startLine, lines: lines.slice(startLine - 1, ref.line + 20) };
    }),
  );
  return formatFindingSources(sources, locations.slice(MAX_SOURCE_LOCATIONS));
}
