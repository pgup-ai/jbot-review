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
export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|c|h|cpp|hpp|sql)$/i;

type Source = { text: string; truncated: boolean };
export class SourceCache {
  entries = new Map<string, { signature: string; source: Source }>();
  pending = new Map<string, Promise<Source | undefined>>();
  hits = 0;
  reads = 0;
  sharedRequests = 0;
  bytes = 0;
}

export async function readTrackedSource(
  workspace: string,
  path: string,
  signal: AbortSignal,
  options?: { tracked: Set<string>; cache?: SourceCache },
): Promise<{ text: string; truncated: boolean } | undefined> {
  const root = resolveWithinWorkspace(workspace, '.');
  if (!root) return undefined;
  const target = resolveWithinWorkspace(root, path);
  // Tracked source only: never follow a cited symlink into runtime credentials.
  if (!target || target !== resolve(root, path)) return undefined;
  try {
    if (options && !options.tracked.has(path)) return undefined;
    if (!options)
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
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) return undefined;
      signal.throwIfAborted();
      const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      const cache = options?.cache;
      const cached = cache?.entries.get(path);
      if (cache && cached?.signature === signature) {
        cache.hits++;
        return cached.source;
      }
      const buffer = Buffer.alloc(MAX_SOURCE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (buffer.subarray(0, bytesRead).includes(0)) return undefined;
      const text = buffer.toString('utf8', 0, bytesRead);
      const truncated = stat.size > BigInt(bytesRead);
      const source = {
        text: truncated ? text.slice(0, Math.max(0, text.lastIndexOf('\n'))) : text,
        truncated,
      };
      if (cache) {
        cache.reads++;
        cache.bytes += bytesRead;
        if (cache.entries.size >= 64) cache.entries.delete(cache.entries.keys().next().value!);
        cache.entries.set(path, { signature, source });
      }
      return source;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export function findingSourceLocations(findings: Pick<Finding, 'path' | 'line' | 'body'>[]) {
  const locations = new Map<string, { path: string; line: number }>();
  const omitted = new Map<string, { path: string; line: number }>();
  for (const finding of findings) {
    const refs = [
      ...finding.body.matchAll(
        /`([^`\r\n]+):([1-9]\d*)`|(?:^|[\s(])([\p{L}\p{N}_./@-]+):([1-9]\d*)\b/gu,
      ),
    ].map((match) => ({ path: match[1] ?? match[3], line: Number(match[2] ?? match[4]) }));
    let citations = 0;
    for (const [index, ref] of [
      { path: finding.path, line: finding.line === 0 ? 1 : finding.line },
      ...refs,
    ].entries()) {
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
      const selected = index === 0 || citations++ < 2;
      (selected ? locations : omitted).set(`${ref.path}:${ref.line}`, ref);
    }
  }
  for (const key of locations.keys()) omitted.delete(key);
  return { locations: [...locations.values()], omitted: [...omitted.values()] };
}

export async function findNamedSourceLocations(
  workspace: string,
  findings: Pick<Finding, 'title' | 'body'>[],
): Promise<{
  locations: { path: string; line: number }[];
  omitted: { path: string; line: number }[];
  unsearched: string[];
}> {
  const symbols = [
    ...new Set(
      findings.flatMap((finding) =>
        [
          ...`${finding.title}\n${finding.body}`.matchAll(
            /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)`/g,
          ),
        ]
          .map((match) => match[1].split('.').at(-1)!)
          .filter((symbol) => symbol.length >= 5),
      ),
    ),
  ];
  if (!symbols.length) return { locations: [], omitted: [], unsearched: [] };
  try {
    const { stdout } = await execFileAsync(
      'git',
      [
        'grep',
        '-n',
        '-z',
        '-I',
        '-w',
        '-F',
        ...symbols.slice(0, 8).flatMap((symbol) => ['-e', symbol]),
        '--',
        '*.ts',
        '*.tsx',
        '*.js',
        '*.jsx',
        '*.mts',
        '*.cts',
        '*.mjs',
        '*.cjs',
      ],
      { cwd: workspace, timeout: 1500, maxBuffer: 512 * 1024 },
    );
    const matches = [...stdout.matchAll(/([^\0]+)\0(\d+)\0([^\n]*)(?:\n|$)/g)]
      .flatMap((match) => {
        const index = symbols.findIndex((symbol) =>
          match[3].match(/[A-Za-z_$][\w$]*/g)?.includes(symbol),
        );
        if (index < 0) return [];
        const call = new RegExp(`(?<![\\w$])${symbols[index].replace(/\$/g, '\\$')}\\s*\\(`);
        return [
          {
            path: match[1],
            line: Number(match[2]),
            rank: index * 2 + Number(!call.test(match[3])),
          },
        ];
      })
      .sort((a, b) => a.rank - b.rank);
    // Spread the bounded windows across files so one declaration cannot hide all callers.
    const selected: typeof matches = [];
    for (let perFile = 1; perFile <= 2; perFile++)
      for (const ref of matches)
        if (
          selected.length < 8 &&
          !selected.includes(ref) &&
          selected.filter((row) => row.path === ref.path).length < perFile
        )
          selected.push(ref);
    return {
      locations: selected,
      omitted: matches.filter((ref) => !selected.includes(ref)),
      unsearched: symbols.slice(8),
    };
  } catch {
    return { locations: [], omitted: [], unsearched: symbols };
  }
}

export async function buildFindingSourceContext(
  workspace: string,
  findings: Finding[],
  read: (path: string, signal: AbortSignal) => ReturnType<typeof readTrackedSource> = (
    path,
    signal,
  ) => readTrackedSource(workspace, path, signal),
  related: {
    locations: { path: string; line: number }[];
    omitted?: { path: string; line: number }[];
    unsearched?: string[];
  } = { locations: [] },
): Promise<string> {
  const { locations, omitted } = findingSourceLocations(findings);
  for (const ref of [...related.locations].reverse())
    if (!locations.some((location) => location.path === ref.path && location.line === ref.line))
      locations.unshift(ref);
  const files = new Map<string, ReturnType<typeof readTrackedSource>>();
  const signal = AbortSignal.timeout(1500);

  const sources: FindingSource[] = await Promise.all(
    locations.slice(0, MAX_SOURCE_LOCATIONS).map(async (ref) => {
      let file = files.get(ref.path);
      if (!file) {
        file = read(ref.path, signal);
        files.set(ref.path, file);
      }
      const source = await file;
      if (!source?.text) return { ...ref };
      const lines = source.text.split(/\r?\n/);
      if (ref.line > lines.length) return { ...ref };
      const startLine = Math.max(1, ref.line - 20);
      return { ...ref, startLine, lines: lines.slice(startLine - 1, ref.line + 20) };
    }),
  );
  return formatFindingSources(
    sources,
    [
      ...[...omitted, ...(related.omitted ?? [])].filter(
        (ref) =>
          !locations.some((location) => location.path === ref.path && location.line === ref.line),
      ),
      ...locations.slice(MAX_SOURCE_LOCATIONS),
    ],
    related.unsearched,
  );
}
