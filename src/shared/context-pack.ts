import { posix } from 'node:path';
import {
  changedEvidenceLines,
  type DeclarationKind,
  type PathAlias,
  type RichSourceIndex,
} from './evidence.ts';
import type { PrFile } from './github.ts';
import {
  formatContextPack,
  formatContextPackItem,
  type ContextPackEntry,
  type ContextPackSlice,
} from './prompt.ts';
import type { SuppliedContext } from './review-read-locations.ts';

/** Per-page ceiling; the room left on the page usually decides. */
export const CONTEXT_PACK_MAX_BYTES = 64 * 1024;
const WHOLE_DEFINITION_LINES = 150;
const WINDOW_LINES = 20;
const CONSTRUCTOR_LINES = 60;
const FIELD_LINES = 3;
const MAX_DIRECTORIES = 10;
const MAX_DIRECTORY_NAMES = 40;
const ENCLOSING = new Set<DeclarationKind>([
  'function',
  'method',
  'constructor',
  'property',
  'type',
]);

export interface PackSource {
  lines: string[];
  index: RichSourceIndex;
}

/** Bounded, tracked-only head reads for one page. A rejection counts as an uncollected item. */
export interface PackSourceProvider {
  tracked: Set<string>;
  aliases: PathAlias[];
  load(path: string): Promise<PackSource | undefined>;
  /** Word matches as path and 1-based line. */
  references(symbol: string): Promise<{ path: string; line: number }[]>;
}

export interface ContextPack {
  text: string;
  supplied: SuppliedContext;
  state: 'complete' | 'partial';
  omitted: number;
  slices: Partial<Record<ContextPackSlice, { items: number; bytes: number }>>;
}

type Lines = Map<string, Set<number>>;

class PackReader {
  readonly sources = new Map<string, PackSource | undefined>();
  failures = 0;

  constructor(readonly provider: PackSourceProvider) {}

  async load(path: string): Promise<PackSource | undefined> {
    if (!this.sources.has(path)) {
      const source = await this.provider.load(path).catch(() => {
        this.failures++;
        return undefined;
      });
      this.sources.set(path, source);
    }
    return this.sources.get(path);
  }
}

const within = (span: { start: number; end: number }, line: number) =>
  span.start <= line && line <= span.end;
const innermost = <T extends { start: number; end: number }>(spans: T[], line: number) =>
  spans.filter((span) => within(span, line)).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
const range = (start: number, end: number) =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i);
const qualified = (d: { symbol: string; owner?: string }) =>
  d.owner ? `${d.owner}.${d.symbol}` : d.symbol;

/** New-side lines the page's hunks already show. */
function diffLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let line = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) line = Number(hunk[1]);
    else if (row.startsWith('+') || row.startsWith(' ')) lines.add(line++);
  }
  return lines;
}

function entry(
  slice: ContextPackSlice,
  path: string,
  source: PackSource,
  lines: number[],
  label: string,
  extra: Partial<ContextPackEntry> = {},
): ContextPackEntry | undefined {
  const rows = [...new Set(lines)]
    .filter((line) => line >= 1 && line <= source.lines.length)
    .sort((a, b) => a - b)
    .map((line): [number, string] => [line, source.lines[line - 1]]);
  return rows.length ? { slice, path, label, rows, ...extra } : undefined;
}

function listEntry(
  slice: ContextPackSlice,
  kind: NonNullable<ContextPackEntry['list']>['kind'],
  subject: string,
  entries: string[],
): ContextPackEntry {
  return { slice, path: '', label: '', rows: [], list: { kind, subject, entries } };
}

function markShown(shown: Lines, item: ContextPackEntry): void {
  const lines = shown.get(item.path) ?? new Set<number>();
  for (const [line] of item.rows) lines.add(line);
  shown.set(item.path, lines);
}

function mergeRanges(ranges: { start: number; end: number; label: string }[]) {
  const merged: { start: number; end: number; labels: string[] }[] = [];
  for (const next of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1);
    if (last && next.start <= last.end + 1) {
      last.end = Math.max(last.end, next.end);
      if (next.label && !last.labels.includes(next.label)) last.labels.push(next.label);
    } else
      merged.push({ start: next.start, end: next.end, labels: next.label ? [next.label] : [] });
  }
  return merged.map(({ start, end, labels }) => ({
    start,
    end,
    label: labels.slice(0, 3).join(', '),
  }));
}

/** Each changed line's enclosing definition, plus changed classes' constructors and fields. */
function surroundingEntries(
  files: PrFile[],
  reader: PackReader,
  diff: Lines,
  shown: Lines,
): ContextPackEntry[] {
  const entries: ContextPackEntry[] = [];
  for (const file of files) {
    const source = reader.sources.get(file.filename);
    if (!source || !file.patch) continue;
    const changed = changedEvidenceLines(file.patch);
    const { declarations, callbacks } = source.index;
    const ranges: { start: number; end: number; label: string }[] = [];
    for (const line of changed) {
      const named = innermost(
        declarations.filter((d) => ENCLOSING.has(d.kind)),
        line,
      );
      const outer = named ?? innermost(callbacks, line);
      if (!outer) continue;
      const label = named ? qualified(named) : '';
      if (outer.end - outer.start < WHOLE_DEFINITION_LINES)
        ranges.push({ start: outer.start, end: outer.end, label });
      else
        ranges.push(
          { start: outer.start, end: outer.start, label },
          {
            start: Math.max(outer.start, line - WINDOW_LINES),
            end: Math.min(outer.end, line + WINDOW_LINES),
            label,
          },
        );
    }
    const classes = declarations.filter(
      (d) => d.kind === 'class' && changed.some((line) => within(d, line)),
    );
    for (const member of declarations) {
      if (!classes.some((c) => c.symbol === member.owner)) continue;
      if (member.kind === 'constructor')
        ranges.push({
          start: member.start,
          end: Math.min(member.end, member.start + CONSTRUCTOR_LINES - 1),
          label: qualified(member),
        });
      else if (member.kind === 'property' && member.end - member.start < FIELD_LINES)
        ranges.push({ start: member.start, end: member.end, label: '' });
    }
    const visible = diff.get(file.filename) ?? new Set<number>();
    for (const merged of mergeRanges(ranges)) {
      const item = entry(
        'surrounding',
        file.filename,
        source,
        range(merged.start, merged.end).filter((line) => !visible.has(line)),
        merged.label,
        { end: merged.end, inDiff: visible },
      );
      if (!item) continue;
      entries.push(item);
      markShown(shown, item);
    }
  }
  return entries;
}

/** Each changed file's directory: its tracked files and immediate subdirectories. */
function directoryEntries(
  files: PrFile[],
  changed: Set<string>,
  tracked: Set<string>,
): ContextPackEntry[] {
  return [...new Set(files.map((file) => posix.dirname(file.filename)))]
    .slice(0, MAX_DIRECTORIES)
    .map((directory) => {
      const prefix = directory === '.' ? '' : `${directory}/`;
      const names = new Set<string>();
      for (const path of tracked) {
        if (!path.startsWith(prefix)) continue;
        const [name, ...rest] = path.slice(prefix.length).split('/');
        names.add(rest.length ? `${name}/` : changed.has(path) ? `${name}*` : name);
      }
      return listEntry(
        'directories',
        'directory',
        directory,
        [...names].sort().slice(0, MAX_DIRECTORY_NAMES),
      );
    });
}

export async function buildContextPack(
  files: PrFile[],
  changed: Set<string>,
  provider: PackSourceProvider,
  budgetBytes: number,
): Promise<ContextPack> {
  const reader = new PackReader(provider);
  for (const file of files) await reader.load(file.filename);
  const diff: Lines = new Map(files.map((file) => [file.filename, diffLines(file.patch ?? '')]));
  const shown: Lines = new Map([...diff].map(([path, lines]) => [path, new Set(lines)]));
  const surrounding = surroundingEntries(files, reader, diff, shown);
  const ordered = [...surrounding, ...directoryEntries(files, changed, provider.tracked)];
  const kept: ContextPackEntry[] = [];
  const omitted: ContextPackEntry[] = [];
  const render = () =>
    kept.length ? formatContextPack({ items: kept, omitted, uncollected: reader.failures }) : '';
  let used = Buffer.byteLength(
    formatContextPack({ items: [], omitted: [], uncollected: reader.failures }),
  );
  for (const item of ordered) {
    const bytes = Buffer.byteLength(formatContextPackItem(item)) + 2;
    if (used + bytes <= budgetBytes) {
      kept.push(item);
      used += bytes;
    } else omitted.push(item);
  }
  // The estimate leaves out section titles, so trim until the rendered pack fits.
  let text = render();
  while (kept.length && Buffer.byteLength(text) > budgetBytes) {
    omitted.unshift(kept.pop()!);
    text = render();
  }
  const supplied: SuppliedContext = {
    ranges: new Map(),
    lines: new Map(),
    symbols: new Set(),
    directories: new Set(),
  };
  const slices: ContextPack['slices'] = {};
  for (const item of kept) {
    const stat = (slices[item.slice] ??= { items: 0, bytes: 0 });
    stat.items++;
    stat.bytes += Buffer.byteLength(formatContextPackItem(item));
    if (item.list?.kind === 'directory') supplied.directories.add(item.list.subject);
    else if (item.list) supplied.symbols.add(item.list.subject.split('.').pop()!);
    if (item.slice === 'definitions') supplied.symbols.add(item.label.split('.').pop()!);
    if (item.calls) supplied.symbols.add(item.calls.split('.').pop()!);
    const ranges = supplied.ranges.get(item.path) ?? [];
    for (const [line] of item.rows) {
      const last = ranges.at(-1);
      if (last && line === last[1] + 1) last[1] = line;
      else ranges.push([line, line]);
    }
    if (ranges.length) {
      supplied.ranges.set(item.path, ranges);
      supplied.lines.set(item.path, reader.sources.get(item.path)!.lines.length);
    }
  }
  return {
    text,
    supplied,
    state: reader.failures ? 'partial' : 'complete',
    omitted: omitted.length,
    slices,
  };
}
