import { posix } from 'node:path';
import { extractChangedExportedSymbols } from './blast-radius.ts';
import { numberNewSideLines, PATH_PATTERNS } from './diff-context.ts';
import {
  changedEvidenceLines,
  JS_SOURCE,
  resolveEvidenceImport,
  type DeclarationKind,
  type PathAlias,
  type RichSourceIndex,
} from './evidence.ts';
import type { PrFile } from './github.ts';
import { newSideLines } from './patch.ts';
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
const MAX_DIRECTORIES = 16;
const MAX_DIRECTORY_NAMES = 40;
const ENCLOSING = new Set<DeclarationKind>([
  'function',
  'method',
  'constructor',
  'property',
  'type',
]);
const MAX_REEXPORT_HOPS = 3;
const FUNCTION_LIKE = new Set<DeclarationKind>(['function', 'method', 'constructor']);
const MAX_CHANGED_SYMBOLS = 20;
const CALLERS_PER_SYMBOL = 3;
const CALLER_CONTEXT_LINES = 4;
const MAX_REFERENCES = 50;

export interface PackSource {
  lines: string[];
  index: RichSourceIndex;
}

/**
 * Bounded, tracked-only head reads for one page; any rejection counts as an uncollected item.
 * `load` rejects at the deadline or the page's file, byte or read cap; an unusable file gives undefined.
 */
export interface PackSourceProvider {
  tracked: Set<string>;
  aliases: PathAlias[];
  load(path: string): Promise<PackSource | undefined>;
  /** Word matches as path and 1-based line; `paths` limits the search to those files. */
  references(symbol: string, paths?: string[]): Promise<{ path: string; line: number }[]>;
}

export interface ContextPack {
  text: string;
  supplied: SuppliedContext;
  /** Partial when a changed JS/TS file could not be read or indexed; reads refused at the pack's limits count as uncollected. */
  state: 'complete' | 'partial';
  omitted: number;
  uncollected: number;
  slices: Partial<Record<ContextPackSlice, { items: number; bytes: number }>>;
}

type Lines = Map<string, Set<number>>;
type Declaration = RichSourceIndex['declarations'][number];
type Located = { path: string; symbol: string; owner?: string };

class PackReader {
  readonly sources = new Map<string, PackSource | undefined>();
  private readonly matches = new Map<string, Promise<{ path: string; line: number }[]>>();
  readonly refused = new Set<string>();
  readonly unsearched = new Set<string>();
  failures = 0;

  constructor(readonly provider: PackSourceProvider) {}

  async load(path: string): Promise<PackSource | undefined> {
    if (!this.sources.has(path)) {
      const source = await this.provider.load(path).catch(() => {
        this.failures++;
        this.refused.add(path);
        return undefined;
      });
      this.sources.set(path, source);
    }
    return this.sources.get(path);
  }

  references(symbol: string, paths?: string[]): Promise<{ path: string; line: number }[]> {
    const key = [symbol, ...(paths ?? [])].join('\0');
    if (!this.matches.has(key))
      this.matches.set(
        key,
        this.provider.references(symbol, paths).catch(() => {
          this.failures++;
          this.unsearched.add(symbol);
          return [];
        }),
      );
    return this.matches.get(key)!;
  }

  resolve(path: string, specifier: string): string | undefined {
    return resolveEvidenceImport(path, specifier, this.provider.tracked, this.provider.aliases);
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
const packageOf = (path: string) => path.split('/').slice(0, 2).join('/');
/** A blank or comment line, which changes nothing about the declaration around it. */
const trivia = (source: PackSource, line: number) =>
  /^(?:\/[/*]|\*|$)/.test(source.lines[line - 1]?.trim() ?? '');

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
  kind: NonNullable<ContextPackEntry['list']>['kind'],
  subject: string,
  entries: string[],
): ContextPackEntry {
  const slice = kind === 'directory' ? 'directories' : 'callers';
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
    const enclosing = declarations.filter((d) => ENCLOSING.has(d.kind));
    const containers = declarations.filter(
      (d) =>
        (d.kind === 'variable' || d.kind === 'class') &&
        changed.some((line) => within(d, line)) &&
        !local(source.index, d),
    );
    const ranges: { start: number; end: number; label: string }[] = [];
    for (const line of changed) {
      const named =
        innermost(enclosing, line) ??
        (trivia(source, line) ? undefined : innermost(containers, line));
      const outer = named ?? innermost(callbacks, line);
      if (!outer) continue;
      const label = named ? qualified(named) : '';
      if (outer.end - outer.start < WHOLE_DEFINITION_LINES)
        ranges.push({ start: outer.start, end: outer.end, label });
      else {
        const first = signatureLine(source, outer);
        ranges.push(
          { start: first, end: first, label },
          {
            start: Math.max(outer.start, line - WINDOW_LINES),
            end: Math.min(outer.end, line + WINDOW_LINES),
            label,
          },
        );
      }
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
      else if (
        member.kind === 'property' &&
        member.end - signatureLine(source, member) < FIELD_LINES
      )
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

function signatureLine(source: PackSource, d: { start: number; end: number }): number {
  let depth = 0;
  for (let line = d.start; line <= d.end; line++) {
    const text = source.lines[line - 1];
    if (!depth && !text.trim().startsWith('@')) return line;
    depth += text.split('(').length - text.split(')').length;
  }
  return d.start;
}

function local(index: RichSourceIndex, d: Declaration): boolean {
  const contains = (o: { start: number; end: number }) => o.start <= d.start && d.end <= o.end;
  // An equal span is the declaration's own value, such as `const x = wrap(() => {})`.
  const strictly = (o: { start: number; end: number }) =>
    contains(o) && (o.start < d.start || d.end < o.end);
  return (
    index.declarations.some(
      (o) => o !== d && (FUNCTION_LIKE.has(o.kind) ? contains(o) : strictly(o)),
    ) || index.callbacks.some(strictly)
  );
}

function topLevel(index: RichSourceIndex, symbol: string): Declaration | undefined {
  return index.declarations.find((d) => !d.owner && d.symbol === symbol && !local(index, d));
}

/** Follows re-exports from `path` to the module that declares `symbol`. */
async function exported(
  reader: PackReader,
  path: string,
  symbol: string,
  hops = 0,
): Promise<Located | undefined> {
  const source = await reader.load(path);
  if (!source) return undefined;
  if (topLevel(source.index, symbol)) return { path, symbol };
  if (hops >= MAX_REEXPORT_HOPS) return undefined;
  const { reexports } = source.index;
  // `export * as ns` binds a namespace, never `symbol` itself.
  for (const next of [
    ...reexports.filter((r) => r.exported === symbol && r.imported !== '*'),
    ...reexports.filter((r) => r.exported === '*'),
  ]) {
    const target = reader.resolve(path, next.from);
    const found =
      target &&
      (await exported(reader, target, next.exported === '*' ? symbol : next.imported, hops + 1));
    if (found) return found;
  }
  return undefined;
}

async function declaredFrom(
  reader: PackReader,
  path: string,
  source: PackSource,
  symbol: string,
): Promise<Located | undefined> {
  if (topLevel(source.index, symbol)) return { path, symbol };
  const binding = source.index.imports.find((i) => i.local === symbol);
  if (!binding || binding.imported === '*' || binding.imported === 'default') return undefined;
  const target = reader.resolve(path, binding.from);
  return target ? exported(reader, target, binding.imported) : undefined;
}

function definitionLines(source: PackSource, d: Declaration): number[] {
  if (d.kind === 'class') {
    const header =
      source.lines.findIndex(
        (text, i) => i >= d.start - 1 && i < d.end && text.includes(`class ${d.symbol}`),
      ) + 1;
    // A wrapped `extends` or `implements` runs on to the opening brace.
    let open = Math.max(d.start, header);
    const last = Math.min(open + 4, d.end);
    while (open < last && !source.lines[open - 1].includes('{')) open++;
    return [
      ...range(d.start, open),
      ...source.index.declarations
        .filter((m) => m.owner === d.symbol)
        .slice(0, 40)
        .map((m) => signatureLine(source, m)),
    ];
  }
  if (d.kind === 'type') return range(d.start, Math.min(d.end, d.start + 59));
  if (d.kind === 'variable' || d.kind === 'property')
    return range(d.start, Math.min(d.end, d.start + 9));
  return range(d.start, d.end - d.start < 40 ? d.end : d.start + 19);
}

async function definitionEntries(
  files: PrFile[],
  reader: PackReader,
  diff: Lines,
  shown: Lines,
): Promise<ContextPackEntry[]> {
  const wanted = new Map<string, Located & { from: string; uses: number }>();
  const want = (found: Located | undefined, from: string) => {
    if (!found) return;
    const key = `${found.path}\0${qualified(found)}`;
    wanted.set(key, { ...found, from, uses: (wanted.get(key)?.uses ?? 0) + 1 });
  };
  const resolved = new Map<string, Promise<Located | undefined>>();
  const declared = (path: string, source: PackSource, symbol: string) => {
    const key = `${path}\0${symbol}`;
    if (!resolved.has(key)) resolved.set(key, declaredFrom(reader, path, source, symbol));
    return resolved.get(key)!;
  };
  for (const file of files) {
    const source = reader.sources.get(file.filename);
    if (!source || !file.patch) continue;
    const changed = new Set(changedEvidenceLines(file.patch));
    const { declarations, uses, memberCalls, injected } = source.index;
    const functions = declarations.filter((d) => FUNCTION_LIKE.has(d.kind));
    const classes = declarations.filter((d) => d.kind === 'class');
    const bySymbol = new Map<string, Declaration[]>();
    for (const d of declarations) {
      const same = bySymbol.get(d.symbol);
      if (same) same.push(d);
      else bySymbol.set(d.symbol, [d]);
    }
    for (const use of uses) {
      if (!changed.has(use.line)) continue;
      const scope = innermost(functions, use.line);
      // Locals of the enclosing function are already in the surrounding code.
      if (
        scope &&
        bySymbol.get(use.symbol)?.some((d) => scope.start < d.start && d.end <= scope.end)
      )
        continue;
      want(await declared(file.filename, source, use.symbol), file.filename);
    }
    for (const call of memberCalls) {
      if (!changed.has(call.line)) continue;
      if (!call.target) {
        const owner = innermost(classes, call.line)?.symbol;
        if (owner && bySymbol.get(call.member)?.some((d) => d.owner === owner))
          want({ path: file.filename, symbol: call.member, owner }, file.filename);
        continue;
      }
      const type = injected.find((i) => i.name === call.target)?.type;
      const found = type ? await declared(file.filename, source, type) : undefined;
      const target = found && (await reader.load(found.path));
      if (
        found &&
        target?.index.declarations.some((d) => d.owner === found.symbol && d.symbol === call.member)
      )
        want({ path: found.path, symbol: call.member, owner: found.symbol }, file.filename);
    }
  }
  const ranked = [...wanted.values()].sort(
    (a, b) =>
      b.uses - a.uses ||
      Number(packageOf(b.path) === packageOf(b.from)) -
        Number(packageOf(a.path) === packageOf(a.from)) ||
      a.path.localeCompare(b.path),
  );
  const entries: ContextPackEntry[] = [];
  for (const found of ranked) {
    const source = await reader.load(found.path);
    if (!source) continue;
    // Overloads and accessors declare a member more than once; the widest is the implementation.
    const declaration = found.owner
      ? source.index.declarations
          .filter((d) => d.symbol === found.symbol && d.owner === found.owner)
          .sort((a, b) => b.end - b.start - (a.end - a.start))[0]
      : topLevel(source.index, found.symbol);
    if (!declaration) continue;
    const hidden = shown.get(found.path);
    const item = entry(
      'definitions',
      found.path,
      source,
      definitionLines(source, declaration).filter((line) => !hidden?.has(line)),
      qualified(declaration),
      { end: declaration.end, inDiff: diff.get(found.path) },
    );
    if (!item) continue;
    entries.push(item);
    markShown(shown, item);
  }
  return entries;
}

/** Declarations the page changes that other code can call, heaviest change first. */
function changedSymbols(files: PrFile[], reader: PackReader): (Located & { span?: Declaration })[] {
  const found = new Map<string, Located & { span?: Declaration; weight: number }>();
  for (const file of files) {
    const source = reader.sources.get(file.filename);
    if (!source || !file.patch) continue;
    const changed = changedEvidenceLines(file.patch);
    const { declarations } = source.index;
    for (const d of declarations) {
      const inside = changed.filter((line) => within(d, line));
      if (!inside.length || d.kind === 'constructor' || (!d.owner && local(source.index, d)))
        continue;
      // A class counts only when code outside its members changes, such as its header.
      if (
        d.kind === 'class' &&
        inside.every(
          (line) =>
            trivia(source, line) ||
            declarations.some((m) => m.owner === d.symbol && within(m, line)),
        )
      )
        continue;
      found.set(`${file.filename}\0${qualified(d)}`, {
        path: file.filename,
        symbol: d.symbol,
        owner: d.owner,
        span: d,
        weight: inside.length,
      });
    }
  }
  for (const symbol of extractChangedExportedSymbols(files))
    if (![...found.values()].some((s) => !s.owner && s.symbol === symbol))
      found.set(`\0${symbol}`, { path: '', symbol, weight: 0 });
  return [...found.values()].sort((a, b) => b.weight - a.weight);
}

/** Whether `path` imports the target, or for a member its class, from the declaring module. */
async function linked(
  reader: PackReader,
  path: string,
  source: PackSource,
  target: Located,
): Promise<boolean> {
  if (path === target.path) return true;
  const name = target.owner ?? target.symbol;
  for (const binding of source.index.imports) {
    if (binding.imported !== name) continue;
    const resolved = reader.resolve(path, binding.from);
    // A removed or re-exported name has no declaring module here, so any in-repo import counts.
    if (
      target.path
        ? resolved && (await exported(reader, resolved, name))?.path === target.path
        : resolved || binding.from.startsWith('.')
    )
      return true;
  }
  return false;
}

async function callerEntries(
  targets: (Located & { span?: Declaration })[],
  reader: PackReader,
  diff: Lines,
  shown: Lines,
): Promise<ContextPackEntry[]> {
  const entries: ContextPackEntry[] = [];
  for (const target of targets) {
    const pkg = packageOf(target.path);
    // Member names collide often, so only files that name the class are searched.
    const paths = target.owner
      ? [...new Set([target.path, ...(await reader.references(target.owner)).map((h) => h.path)])]
      : undefined;
    const found = await reader.references(target.symbol, paths);
    // Rank before capping, so the most useful hits are kept and load first.
    const hits = found
      .map((hit) => ({
        hit,
        test: PATH_PATTERNS.tests.test(hit.path),
        near: packageOf(hit.path) === pkg,
      }))
      .sort(
        (a, b) =>
          Number(a.test) - Number(b.test) ||
          Number(b.near) - Number(a.near) ||
          a.hit.path.localeCompare(b.hit.path) ||
          a.hit.line - b.hit.line,
      )
      .slice(0, MAX_REFERENCES)
      .map(({ hit }) => hit);
    const callers: { path: string; line: number }[] = [];
    const unverified: string[] = [];
    const imports = new Set<{ path: string; line: number }>();
    for (const hit of hits) {
      if (
        (hit.path === target.path && target.span && within(target.span, hit.line)) ||
        shown.get(hit.path)?.has(hit.line)
      )
        continue;
      const source = await reader.load(hit.path);
      // A refused read already counts as uncollected; hits in unusable files stay unverified.
      if (reader.refused.has(hit.path)) continue;
      if (source?.index.imports.some((i) => i.line === hit.line)) imports.add(hit);
      else if (source && (await linked(reader, hit.path, source, target))) callers.push(hit);
      else unverified.push(`${hit.path}:${hit.line}`);
    }
    const subject = qualified(target);
    const rest: string[] = [];
    let excerpts = 0;
    for (const hit of callers) {
      const hidden = shown.get(hit.path);
      // An earlier excerpt may already show this call.
      if (hidden?.has(hit.line)) continue;
      if (excerpts >= CALLERS_PER_SYMBOL) {
        rest.push(`${hit.path}:${hit.line}`);
        continue;
      }
      const source = reader.sources.get(hit.path)!;
      const caller = innermost(
        source.index.declarations.filter((d) => FUNCTION_LIKE.has(d.kind)),
        hit.line,
      );
      const lines = [
        ...(caller ? [signatureLine(source, caller)] : []),
        ...range(hit.line - CALLER_CONTEXT_LINES, hit.line + CALLER_CONTEXT_LINES),
      ].filter((line) => !hidden?.has(line));
      const item = entry('callers', hit.path, source, lines, caller ? qualified(caller) : '', {
        calls: subject,
        inDiff: diff.get(hit.path),
      });
      if (!item) continue;
      entries.push(item);
      markShown(shown, item);
      excerpts++;
    }
    const seen = (hit: { path: string; line: number }) => shown.get(hit.path)?.has(hit.line);
    if (rest.length) entries.push(listEntry('other-callers', subject, rest));
    if (unverified.length) entries.push(listEntry('unverified', subject, unverified));
    else if (
      !target.owner &&
      !reader.unsearched.has(target.symbol) &&
      found.length <= MAX_REFERENCES &&
      // An import calls nothing, but a file matched only at its import may call through an alias.
      hits.every(
        (hit) =>
          seen(hit) || (imports.has(hit) && hits.some((h) => h.path === hit.path && seen(h))),
      ) &&
      // A default or renamed export reaches callers under names a word search cannot see.
      !hits.some(
        (hit) =>
          hit.path === target.path &&
          /\b(?:default|as|exports)\b/.test(reader.sources.get(hit.path)!.lines[hit.line - 1]),
      )
    )
      entries.push(listEntry('all-shown', subject, []));
  }
  return entries;
}

/** Other pages' diffs of files this page imports or takes a definition from. */
function changeEntries(
  files: PrFile[],
  prFiles: PrFile[],
  reader: PackReader,
  definitions: ContextPackEntry[],
): ContextPackEntry[] {
  const page = new Set(files.map((file) => file.filename));
  const linked = new Set(definitions.map((item) => item.path));
  for (const file of files)
    for (const binding of reader.sources.get(file.filename)?.index.imports ?? []) {
      const target = reader.resolve(file.filename, binding.from);
      if (target) linked.add(target);
    }
  return prFiles
    .filter((file) => file.patch && !page.has(file.filename) && linked.has(file.filename))
    .map((file) => ({
      slice: 'changes',
      path: file.filename,
      label: '',
      rows: [],
      diff: numberNewSideLines(file.patch!),
    }));
}

function directoryEntries(
  files: PrFile[],
  changed: Map<string, Set<number>>,
  tracked: Set<string>,
): ContextPackEntry[] {
  const directories = new Set(files.map((file) => posix.dirname(file.filename)));
  // A Set also visits entries added while iterating, so ancestors follow closest-first.
  for (const directory of directories)
    if (directory !== '.') directories.add(posix.dirname(directory));
  return [...directories].slice(0, MAX_DIRECTORIES).map((directory) => {
    const prefix = directory === '.' ? '' : `${directory}/`;
    const names = new Set<string>();
    for (const path of tracked) {
      if (!path.startsWith(prefix)) continue;
      const [name, ...rest] = path.slice(prefix.length).split('/');
      names.add(rest.length ? `${name}/` : changed.has(path) ? `${name}*` : name);
    }
    const sorted = [...names].sort();
    const more = sorted.length - MAX_DIRECTORY_NAMES;
    return listEntry('directory', directory, [
      ...sorted.slice(0, MAX_DIRECTORY_NAMES),
      ...(more > 0 ? [`+${more} more`] : []),
    ]);
  });
}

export async function buildContextPack(
  files: PrFile[],
  /** Every PR file, this page's and other pages'. */
  prFiles: PrFile[],
  provider: PackSourceProvider,
  budgetBytes: number,
): Promise<ContextPack> {
  const reader = new PackReader(provider);
  for (const file of files) await reader.load(file.filename);
  const diff: Lines = new Map(
    files.map((file) => [
      file.filename,
      // A trailing newline would read as one more context line.
      new Set(Array.from(newSideLines((file.patch ?? '').replace(/\n$/, '')), (l) => l.line)),
    ]),
  );
  // A changed JS/TS file the provider could not read or index leaves the page without its own code;
  // one refused at the pack's limits, such as a file past the read cap, only goes uncollected.
  const missing = [...diff.entries()].filter(
    ([path, lines]) =>
      lines.size && JS_SOURCE.test(path) && !reader.sources.get(path) && !reader.refused.has(path),
  );
  reader.failures += missing.length;
  const shown: Lines = new Map([...diff].map(([path, lines]) => [path, new Set(lines)]));
  const changed: Lines = new Map(
    prFiles.map((file) => [file.filename, new Set(changedEvidenceLines(file.patch ?? ''))]),
  );
  const surrounding = surroundingEntries(files, reader, diff, shown);
  const definitions = await definitionEntries(files, reader, diff, shown);
  const symbols = changedSymbols(files, reader);
  const callers = await callerEntries(symbols.slice(0, MAX_CHANGED_SYMBOLS), reader, diff, shown);
  const ordered = [
    ...surrounding,
    ...definitions,
    ...callers.filter((e) => !e.list),
    ...callers.filter((e) => e.list),
    ...changeEntries(files, prFiles, reader, definitions),
    ...directoryEntries(files, changed, provider.tracked),
  ];
  // Excerpts of files another page changes would otherwise read as unchanged code.
  for (const item of ordered) {
    if (!item.rows.length) continue;
    const last = Math.max(item.rows.at(-1)![0], item.end ?? 0);
    const own = diff.get(item.path);
    const lines = [...(changed.get(item.path) ?? [])]
      .filter((line) => item.rows[0][0] <= line && line <= last && !own?.has(line))
      .sort((a, b) => a - b);
    if (lines.length) item.otherPages = lines;
  }
  const kept: ContextPackEntry[] = [];
  // Symbols past the cap get no caller search, so Omitted names them.
  const omitted = symbols
    .slice(MAX_CHANGED_SYMBOLS)
    .map((symbol) => listEntry('other-callers', qualified(symbol), []));
  const render = () =>
    kept.length ? formatContextPack({ items: kept, omitted, uncollected: reader.failures }) : '';
  let used = Buffer.byteLength(
    formatContextPack({ items: [], omitted: [], uncollected: reader.failures }),
  );
  for (const item of ordered) {
    // An all-shown claim counts every excerpt before it as shown.
    if (item.list?.kind === 'all-shown' && omitted.some((o) => !o.list)) continue;
    const bytes = Buffer.byteLength(formatContextPackItem(item)) + 2;
    if (used + bytes <= budgetBytes) {
      kept.push(item);
      used += bytes;
    } else omitted.push(item);
  }
  // The estimate leaves out section titles and the Omitted list,
  // so trim until the rendered pack fits.
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
  // The page's diff counts too, so a re-read of it registers like a re-read of the pack.
  const visible: Lines = new Map(
    [...diff]
      .filter(([path, lines]) => lines.size && reader.sources.get(path))
      .map(([path, lines]) => [path, new Set(lines)]),
  );
  const slices: ContextPack['slices'] = {};
  for (const item of kept) {
    const stat = (slices[item.slice] ??= { items: 0, bytes: 0 });
    stat.items++;
    stat.bytes += Buffer.byteLength(formatContextPackItem(item));
    if (item.list?.kind === 'directory') supplied.directories.add(item.list.subject);
    else if (item.list) supplied.symbols.add(item.list.subject.split('.').pop()!);
    if (item.slice === 'definitions') supplied.symbols.add(item.label.split('.').pop()!);
    if (item.calls) supplied.symbols.add(item.calls.split('.').pop()!);
    if (item.rows.length) markShown(visible, item);
  }
  for (const [path, lines] of visible) {
    const ranges: [number, number][] = [];
    for (const line of [...lines].sort((a, b) => a - b)) {
      const last = ranges.at(-1);
      if (last && line === last[1] + 1) last[1] = line;
      else ranges.push([line, line]);
    }
    supplied.ranges.set(path, ranges);
    supplied.lines.set(path, reader.sources.get(path)!.lines.length);
  }
  return {
    text,
    supplied,
    state: missing.length ? 'partial' : 'complete',
    omitted: omitted.length,
    uncollected: reader.failures,
    slices,
  };
}
