import { parse } from '@babel/parser';
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { reviewReadLocations } from './review-read-locations.ts';
import { promisify } from 'node:util';
import {
  readTrackedSource,
  findingSourceLocations,
  buildFindingSourceContext,
  SourceCache,
  SOURCE_FILE,
} from './finding-context.ts';
import { EvidenceDiskCache, evidenceHash } from './evidence-cache.ts';
import {
  buildJevPrefetch,
  symbolPattern,
  type JevPrefetchMode,
  type JevPrefetchStats,
} from './jev-prefetch.ts';
import {
  JEV_MODEL,
  formatSourceExcerpt,
  evidenceTask,
  formatEvidenceCoverage,
  type JevCandidate,
} from './prompt.ts';
import type { PrFile } from './github.ts';
import type { Finding } from './types.ts';

const exec = promisify(execFile);
export const JS_SOURCE = /\.[cm]?[jt]sx?$/i;
type Ast = {
  type: string;
  loc?: { start: { line: number }; end: { line: number } };
  [key: string]: unknown;
};
const ast = (value: unknown) => value as Ast | undefined;
const name = (value: unknown) => {
  const n = ast(value);
  return typeof n?.name === 'string' ? n.name : typeof n?.value === 'string' ? n.value : '';
};
type SourceIndex = {
  definitions: { symbol: string; start: number; end: number }[];
  imports: { local: string; imported: string; from: string }[];
  uses: { symbol: string; line: number }[];
};

export function indexEvidenceSource(path: string, text: string): SourceIndex {
  const result: SourceIndex = { definitions: [], imports: [], uses: [] };
  if (!JS_SOURCE.test(path)) return result;
  const tree = parse(text, {
    sourceType: 'unambiguous',
    plugins: ['typescript', 'jsx'],
    attachComment: false,
  });
  function walk(n: Ast) {
    if (n.type === 'ImportDeclaration') {
      for (const s of n.specifiers as Ast[])
        result.imports.push({
          local: name(s.local),
          imported: name(s.imported) || (s.type === 'ImportDefaultSpecifier' ? 'default' : '*'),
          from: name(n.source),
        });
      return;
    }
    const symbol = name(n.id);
    if (
      symbol &&
      n.loc &&
      ['FunctionDeclaration', 'ClassDeclaration', 'VariableDeclarator'].includes(n.type)
    ) {
      result.definitions.push({ symbol, start: n.loc.start.line, end: n.loc.end.line });
    }
    if (n.type === 'Identifier' && n.loc)
      result.uses.push({ symbol: name(n), line: n.loc.start.line });
    for (const [key, value] of Object.entries(n)) {
      if (
        [
          'loc',
          'comments',
          'leadingComments',
          'trailingComments',
          'innerComments',
          'tokens',
        ].includes(key)
      )
        continue;
      if (Array.isArray(value)) {
        for (const child of value) if (ast(child)?.type) walk(child as Ast);
      } else if (ast(value)?.type) walk(value as Ast);
    }
  }
  walk(tree as unknown as Ast);
  return result;
}

export function changedEvidenceLines(patch: string): number[] {
  const lines: number[] = [];
  let current = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) current = Number(hunk[1]);
    else if (line.startsWith('+')) lines.push(current++);
    else if (line.startsWith('-')) lines.push(current);
    else if (line.startsWith(' ')) current++;
  }
  return [...new Set(lines)];
}

export function resolveEvidenceImport(
  path: string,
  specifier: string,
  paths: Set<string>,
): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(path), specifier));
  const stem = base.replace(/\.[cm]?js$/, '');
  return [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js'].map(
      (ext) => stem + ext,
    ),
  ].find((p) => paths.has(p));
}

export function evidenceMode(value: string | undefined): JevPrefetchMode {
  return value === 'on' || value === 'deterministic' || value === 'shadow' ? value : 'off';
}

export interface EvidenceReuseOptions {
  shared: boolean;
  handoff: boolean;
  prefetch: boolean;
  cacheDir?: string;
}

export interface EvidenceCacheStats {
  kind: 'evidence-cache';
  version: 1;
  shared: boolean;
  handoff: boolean;
  prefetch: boolean;
  persistent: boolean;
  sourceHits: number;
  sourceReads: number;
  sourceBytes: number;
  sharedRequests: number;
  inventoryReads: number;
  searchCalls: number;
  searchSharedRequests: number;
  indexDiskHits: number;
  diskHits: number;
  diskMisses: number;
  diskWrites: number;
  observedLocations: number;
  handoffCandidates: number;
  prefetchedFiles: number;
  reusedPrefetchedFiles: number;
  unusedPrefetchedFiles: number;
  prefetchMs: number;
  prefetchStatus: 'disabled' | 'running' | 'completed' | 'failed';
}

export class EvidenceStore {
  private cache = new Map<
    string,
    { text: string; truncated: boolean; index: SourceIndex; digest: string; parsed: boolean }
  >();
  private sources = new SourceCache();
  private observations = new Map<string, { path: string; line: number }>();
  private inventory?: Promise<Set<string>>;
  private searches = new Map<string, Promise<string[]>>();
  private inventoryReads = 0;
  private searchCalls = 0;
  private searchSharedRequests = 0;
  private indexDiskHits = 0;
  private handoffCandidates = 0;
  private prefetched = new Set<string>();
  private reusedPrefetched = new Set<string>();
  private prefetchMs = 0;
  private prefetchStatus: EvidenceCacheStats['prefetchStatus'] = 'disabled';
  private readonly disk: EvidenceDiskCache;
  constructor(
    private workspace: string,
    private files: PrFile[],
    private docsPath?: string,
    readonly reuse: EvidenceReuseOptions = { shared: false, handoff: false, prefetch: false },
  ) {
    this.disk = new EvidenceDiskCache(workspace, reuse.cacheDir);
  }

  stats(): EvidenceCacheStats {
    return {
      kind: 'evidence-cache',
      version: 1,
      shared: this.reuse.shared,
      handoff: this.reuse.handoff,
      prefetch: this.reuse.prefetch,
      persistent: this.disk.enabled,
      sourceHits: this.sources.hits,
      sourceReads: this.sources.reads,
      sourceBytes: this.sources.bytes,
      sharedRequests: this.sources.sharedRequests,
      inventoryReads: this.inventoryReads,
      searchCalls: this.searchCalls,
      searchSharedRequests: this.searchSharedRequests,
      indexDiskHits: this.indexDiskHits,
      diskHits: this.disk.hits,
      diskMisses: this.disk.misses,
      diskWrites: this.disk.writes,
      observedLocations: this.observations.size,
      handoffCandidates: this.handoffCandidates,
      prefetchedFiles: this.prefetched.size,
      reusedPrefetchedFiles: this.reusedPrefetched.size,
      unusedPrefetchedFiles: this.prefetched.size - this.reusedPrefetched.size,
      prefetchMs: this.prefetchMs,
      prefetchStatus: this.prefetchStatus,
    };
  }

  observe(tool: string, input: Record<string, unknown>) {
    if (!this.reuse.handoff) return;
    for (const ref of reviewReadLocations(this.workspace, tool, input)) {
      if (this.observations.size >= 64) break;
      this.observations.set(`${ref.path}:${ref.line}`, ref);
    }
  }

  private async tracked(signal: AbortSignal): Promise<Set<string>> {
    if (this.reuse.shared && this.inventory) return waitForEvidence(this.inventory, signal);
    this.inventoryReads++;
    const pending = exec('git', ['ls-files', '-z'], {
      cwd: this.workspace,
      signal: this.reuse.shared ? AbortSignal.timeout(4000) : signal,
      maxBuffer: 2 * 1024 * 1024,
    })
      .then(({ stdout }) => new Set(stdout.split('\0').filter(Boolean)))
      .finally(() => {
        if (this.inventory === pending) this.inventory = undefined;
      });
    if (this.reuse.shared) this.inventory = pending;
    return waitForEvidence(pending, signal);
  }

  private async read(path: string, signal: AbortSignal, tracked: Set<string>) {
    if (!this.reuse.shared) return readTrackedSource(this.workspace, path, signal);
    if (!tracked.has(path)) return undefined;
    if (this.prefetched.has(path)) this.reusedPrefetched.add(path);
    const old = this.sources.pending.get(path);
    if (old) {
      this.sources.sharedRequests++;
      return waitForEvidence(old, signal);
    }
    const pending = readTrackedSource(this.workspace, path, AbortSignal.timeout(4000), {
      tracked,
      cache: this.sources,
    }).finally(() => {
      this.sources.pending.delete(path);
    });
    this.sources.pending.set(path, pending);
    return waitForEvidence(pending, signal);
  }

  async sourceContext(findings: Finding[]) {
    try {
      const tracked = await this.tracked(AbortSignal.timeout(1500));
      return await buildFindingSourceContext(this.workspace, findings, (path, signal) =>
        this.read(path, signal, tracked),
      );
    } catch {
      return buildFindingSourceContext(this.workspace, findings);
    }
  }

  async warm(options: { log: (s: string) => void; onStats: (s: JevPrefetchStats) => void }) {
    if (!this.reuse.prefetch || !this.reuse.shared) return;
    const started = Date.now();
    this.prefetchStatus = 'running';
    const existing = new Set(this.cache.keys());
    await this.prepare('exploration', [], 'deterministic', {
      log: () => {},
      timeoutMs: 4000,
      onStats: (row) => {
        const measured = { ...row, speculative: true, injectedBytes: 0, coverageBytes: 0 };
        if (row.status === 'fallback') this.prefetchStatus = 'failed';
        options.onStats(measured);
        options.log(`Evidence preparation: ${JSON.stringify(measured)}`);
      },
    });
    for (const path of this.cache.keys()) if (!existing.has(path)) this.prefetched.add(path);
    this.prefetchMs = Date.now() - started;
    if (this.prefetchStatus === 'running') this.prefetchStatus = 'completed';
  }

  async prepare(
    scope: 'exploration' | 'verification',
    findings: Finding[],
    mode: JevPrefetchMode,
    options: {
      timeoutMs: number;
      apiKey?: string;
      log: (s: string) => void;
      onStats: (s: JevPrefetchStats) => void;
      locations?: { path: string; line: number; endLine?: number }[];
      selectCandidates?: (candidates: JevCandidate[]) => JevCandidate[];
      onSelection?: (selected: JevCandidate[]) => void;
    },
  ): Promise<string> {
    if (mode === 'off') return '';
    const started = Date.now();
    const signal = AbortSignal.timeout(Math.max(0, Math.min(4000, options.timeoutMs)));
    let cacheHits = 0,
      parsedFiles = 0,
      bytes = 0;
    const loaded = new Map<string, NonNullable<Awaited<ReturnType<EvidenceStore['load']>>>>();
    try {
      const tracked = await this.tracked(signal);
      const paths = new Set([...tracked].filter((p) => SOURCE_FILE.test(p)));
      const refs = options.locations ?? findingSourceLocations(findings).locations;
      const seeds =
        scope === 'verification' ? refs.map((r) => r.path) : this.files.map((f) => f.filename);
      const read = async (path: string) => {
        if (loaded.has(path)) return loaded.get(path);
        if (loaded.size >= 64 || bytes >= 2 * 1024 * 1024 || !paths.has(path)) return undefined;
        signal.throwIfAborted();
        const old = this.cache.get(path);
        const source = await this.load(path, signal, tracked, 2 * 1024 * 1024 - bytes);
        if (!source) return undefined;
        if (source === old) cacheHits++;
        else if (source.parsed) parsedFiles++;
        loaded.set(path, source);
        bytes += Buffer.byteLength(source.text);
        return source;
      };
      const focus = new Map<string, number[]>();
      const targets: { path: string; symbol: string; start: number; end: number }[] = [];
      for (const path of [...new Set(seeds)].slice(0, 20)) {
        const source = await read(path);
        if (!source) continue;
        const lines =
          scope === 'verification'
            ? refs.filter((r) => r.path === path).map((r) => r.line)
            : changedEvidenceLines(this.files.find((f) => f.filename === path)?.patch ?? '');
        focus.set(path, lines);
        for (const d of source.index.definitions)
          if (
            options.locations?.some(
              (r) => r.path === path && r.line <= d.end && (r.endLine ?? r.line) >= d.start,
            ) ||
            lines.some((l) => l >= d.start && l <= d.end)
          )
            targets.push({ path, ...d });
      }
      const symbols = [...new Set(targets.map((t) => t.symbol))].slice(0, 20);
      let matches: string[] = [];
      if (symbols.length) {
        try {
          const key = JSON.stringify(symbols);
          let pending = this.reuse.shared ? this.searches.get(key) : undefined;
          if (pending) this.searchSharedRequests++;
          else {
            this.searchCalls++;
            pending = exec(
              'git',
              ['grep', '-l', '-z', '-w', '-F', ...symbols.flatMap((s) => ['-e', s]), '--'],
              {
                cwd: this.workspace,
                signal: this.reuse.shared ? AbortSignal.timeout(4000) : signal,
                maxBuffer: 1024 * 1024,
              },
            )
              .then(({ stdout }) => stdout.split('\0'))
              .finally(() => {
                if (this.searches.get(key) === pending) this.searches.delete(key);
              });
            if (this.reuse.shared) this.searches.set(key, pending);
          }
          matches = (await waitForEvidence(pending, signal)).filter((p) => paths.has(p));
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
        }
      }
      // Imports and citations get a slot before broad symbol matches consume the read budget.
      for (const [path, source] of Array.from(loaded)) {
        const ranges = options.locations?.filter((r) => r.path === path && r.endLine !== undefined);
        for (const imp of source.index.imports) {
          if (
            !source.index.uses.some(
              (u) =>
                u.symbol === imp.local &&
                (ranges?.length
                  ? ranges.some((r) => u.line >= r.line && u.line <= (r.endLine ?? r.line))
                  : (focus.get(path) ?? []).some((l) => Math.abs(l - u.line) <= 20)),
            )
          )
            continue;
          const target = resolveEvidenceImport(path, imp.from, paths);
          if (target) await read(target);
        }
      }
      if (scope === 'verification' && this.reuse.handoff) {
        for (const { path } of this.observations.values()) await read(path);
      }
      for (const path of matches.slice(0, 64)) await read(path);
      const candidates: JevCandidate[] = [];
      const seen = new Set<string>();
      const add = (
        path: string,
        symbol: string,
        line: number,
        kind: string,
        relatedTo?: string,
      ) => {
        const source = loaded.get(path);
        const key = `${path}:${line}`;
        if (!source || seen.has(key) || candidates.length >= 64) return;
        seen.add(key);
        const lines = source.text.split(/\r?\n/);
        if (line < 1 || line > lines.length) return;
        const full = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
        const completeFile = !source.truncated && Buffer.byteLength(full) <= 2048;
        const start = Math.max(0, line - 16);
        candidates.push({
          path,
          symbol,
          line,
          kind,
          ...(relatedTo ? { relatedTo } : {}),
          sourceHash: source.digest,
          completeFile,
          text: completeFile
            ? full
            : formatSourceExcerpt(lines.slice(start, line + 16), start + 1, line, 2048),
        });
      };
      if (scope === 'verification' && this.reuse.handoff) {
        const before = candidates.length;
        for (const ref of this.observations.values())
          add(ref.path, 'review source location', ref.line, 'revalidated review read');
        this.handoffCandidates += candidates.length - before;
      }
      for (const t of targets.slice(0, 20)) {
        add(t.path, t.symbol, t.start, 'definition');
        for (const [path, source] of loaded) {
          if (path === t.path) continue;
          const bindings = source.index.imports.filter(
            (i) => resolveEvidenceImport(path, i.from, paths) === t.path && i.imported === t.symbol,
          );
          for (const binding of bindings) {
            const uses = source.index.uses.filter((u) => u.symbol === binding.local);
            for (const u of uses.slice(0, 2))
              add(
                path,
                t.symbol,
                u.line,
                /(?:test|spec)/.test(path) ? 'import-linked test' : 'import-linked reference',
                t.path,
              );
          }
        }
      }
      for (const ref of refs) add(ref.path, 'cited source', ref.line, 'cited context');
      for (const [path, source] of loaded) {
        for (const imp of source.index.imports) {
          const resolved = resolveEvidenceImport(path, imp.from, paths);
          if (!resolved) continue;
          for (const d of loaded.get(resolved)?.index.definitions ?? []) {
            if (d.symbol === imp.imported)
              add(resolved, d.symbol, d.start, 'imported definition', path);
          }
        }
      }
      for (const [path, source] of loaded) {
        const lines = source.text.split(/\r?\n/);
        for (const symbol of symbols) {
          const pattern = symbolPattern(symbol);
          const line = lines.findIndex((l) => pattern.test(l));
          if (line >= 0) add(path, symbol, line + 1, 'text reference; binding unresolved');
        }
      }
      const docs =
        scope === 'verification' && this.docsPath
          ? await this.documents().catch(() => {
              options.log('Optional documentation unavailable; keeping source evidence.');
              return [];
            })
          : [];
      // Reserve documentation candidates so a large code pool cannot evict all external contracts.
      const pool = [...candidates.slice(0, 2), ...docs, ...candidates.slice(2)];
      const task = evidenceTask(findings);
      const omitted = [
        ...new Set([
          ...seeds,
          ...matches,
          ...Array.from(this.observations.values(), (ref) => ref.path),
        ]),
      ].filter((p) => paths.has(p) && !loaded.has(p));
      const coverage = formatEvidenceCoverage(omitted);
      const packet = await buildJevPrefetch(this.workspace, this.files, [], {
        ...options,
        log: () => {},
        onStats: (row) => {
          const measured = {
            ...row,
            coverageBytes: row.injectedBytes ? Buffer.byteLength(coverage) + 2 : 0,
          };
          options.onStats(measured);
          options.log(`Evidence preparation: ${JSON.stringify(measured)}`);
        },
        mode,
        judgmentCache: this.disk,
        timeoutMs: Math.max(0, options.timeoutMs - (Date.now() - started)),
        prepared: {
          candidates: pool,
          task,
          scope,
          cacheHits,
          parsedFiles,
          omittedFiles: omitted.length,
          elapsedMs: Date.now() - started,
        },
      });
      return packet ? packet + '\n\n' + coverage : '';
    } catch {
      await buildJevPrefetch(this.workspace, [], [], {
        ...options,
        mode: 'deterministic',
        prepared: {
          candidates: [],
          task: '',
          scope,
          cacheHits,
          parsedFiles,
          omittedFiles: 0,
          elapsedMs: Date.now() - started,
        },
        onStats: (row) => {
          const failed: JevPrefetchStats = {
            ...row,
            mode,
            model: mode === 'deterministic' ? null : JEV_MODEL,
            status: 'fallback',
            reason: signal.aborted ? 'timeout' : 'unavailable',
          };
          options.onStats(failed);
          options.log(`Evidence preparation: ${JSON.stringify(failed)}`);
        },
        log: () => {},
      });
      return '';
    }
  }

  private async load(path: string, signal: AbortSignal, tracked: Set<string>, maxBytes: number) {
    const source = await this.read(path, signal, tracked);
    if (!source || Buffer.byteLength(source.text) > maxBytes) return undefined;
    const digest = evidenceHash(source.text);
    const old = this.cache.get(path);
    if (old?.digest === digest && old.truncated === source.truncated) return old;
    const key = JSON.stringify(['index-v1-babel-7.29.9', path, digest, source.truncated]);
    const persisted = await this.disk.get(key);
    let index: SourceIndex;
    const fromDisk = validSourceIndex(persisted);
    if (fromDisk) {
      index = persisted;
      this.indexDiskHits++;
    } else {
      index = { definitions: [], imports: [], uses: [] };
      try {
        index = indexEvidenceSource(path, source.text);
      } catch {
        /* Unsupported syntax retains bounded text references. */
      }
      await this.disk.set(key, index);
    }
    const value = { ...source, digest, index, parsed: !fromDisk };
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(path, value);
    return value;
  }

  private async documents(): Promise<JevCandidate[]> {
    const handle = await open(this.docsPath!, constants.O_RDONLY | constants.O_NONBLOCK);
    let raw: string;
    try {
      if (!(await handle.stat()).isFile()) throw new Error('documentation file');
      const buffer = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 64 * 1024) throw new Error('documentation budget');
      raw = buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
    const docs: unknown = JSON.parse(raw);
    if (!Array.isArray(docs) || docs.length > 6) throw new Error('documentation schema');
    return docs.map((d) => {
      if (
        !d ||
        typeof d.url !== 'string' ||
        !d.url.startsWith('https://') ||
        typeof d.text !== 'string' ||
        typeof d.version !== 'string' ||
        typeof d.retrievedAt !== 'string' ||
        d.url.length > 512 ||
        d.version.length > 128 ||
        d.retrievedAt.length > 64 ||
        Buffer.byteLength(d.text) > 6000
      )
        throw new Error('documentation schema');
      const url = new URL(d.url);
      if (url.username || url.password || url.search || url.hash)
        throw new Error('documentation URL');
      return {
        path: d.url,
        symbol: d.version,
        line: 1,
        kind: `documentation snapshot ${d.retrievedAt}`,
        sourceHash: evidenceHash(d.text),
        completeFile: false,
        text: formatSourceExcerpt(d.text.split('\n'), 1, 1, 2048),
      };
    });
  }
}

function validSourceIndex(value: unknown): value is SourceIndex {
  const v = value as SourceIndex | null;
  const line = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0;
  return Boolean(
    v &&
    Array.isArray(v.definitions) &&
    Array.isArray(v.imports) &&
    Array.isArray(v.uses) &&
    v.definitions.every(
      (d) => d && typeof d.symbol === 'string' && line(d.start) && line(d.end) && d.end >= d.start,
    ) &&
    v.imports.every(
      (i) =>
        i &&
        typeof i.local === 'string' &&
        typeof i.imported === 'string' &&
        typeof i.from === 'string',
    ) &&
    v.uses.every((u) => u && typeof u.symbol === 'string' && line(u.line)),
  );
}

async function waitForEvidence<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let aborted: () => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    aborted = () => reject(signal.reason);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
  try {
    return await Promise.race([timeout, pending]);
  } finally {
    signal.removeEventListener('abort', aborted);
  }
}
