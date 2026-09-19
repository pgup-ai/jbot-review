import { parse } from '@babel/parser';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import { readTrackedSource, findingSourceLocations } from './finding-context.ts';
import { buildJevPrefetch, type JevPrefetchMode, type JevPrefetchStats } from './jev-prefetch.ts';
import {
  formatSourceExcerpt,
  evidenceTask,
  formatEvidenceCoverage,
  type JevCandidate,
} from './prompt.ts';
import type { PrFile } from './github.ts';
import type { Finding } from './types.ts';

const exec = promisify(execFile);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const JS_SOURCE = /\.[cm]?[jt]sx?$/;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|c|h|cpp|hpp|sql)$/;
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
export type SourceIndex = {
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

export class EvidenceStore {
  private cache = new Map<
    string,
    { text: string; truncated: boolean; index: SourceIndex; digest: string }
  >();
  constructor(
    private workspace: string,
    private files: PrFile[],
    private docsPath?: string,
  ) {}

  async prepare(
    scope: 'exploration' | 'verification',
    findings: Finding[],
    mode: JevPrefetchMode,
    options: {
      timeoutMs: number;
      apiKey?: string;
      log: (s: string) => void;
      onStats: (s: JevPrefetchStats) => void;
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
      const { stdout } = await exec('git', ['ls-files', '-z'], {
        cwd: this.workspace,
        signal,
        maxBuffer: 2 * 1024 * 1024,
      });
      const paths = new Set(stdout.split('\0').filter((p) => SOURCE.test(p)));
      const refs = findingSourceLocations(findings).locations;
      const seeds =
        scope === 'verification' ? refs.map((r) => r.path) : this.files.map((f) => f.filename);
      const read = async (path: string) => {
        if (loaded.has(path)) return loaded.get(path);
        if (loaded.size >= 64 || bytes >= 2 * 1024 * 1024 || !paths.has(path)) return undefined;
        signal.throwIfAborted();
        const old = this.cache.get(path);
        const source = await this.load(path, signal);
        if (!source || bytes + Buffer.byteLength(source.text) > 2 * 1024 * 1024) return undefined;
        if (source === old) cacheHits++;
        else parsedFiles++;
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
          if (lines.some((l) => l >= d.start && l <= d.end)) targets.push({ path, ...d });
      }
      const symbols = [...new Set(targets.map((t) => t.symbol))].slice(0, 20);
      let matches: string[] = [];
      if (symbols.length) {
        try {
          const found = await exec(
            'git',
            ['grep', '-l', '-z', '-w', '-F', ...symbols.flatMap((s) => ['-e', s]), '--'],
            { cwd: this.workspace, signal, maxBuffer: 1024 * 1024 },
          );
          matches = found.stdout.split('\0').filter((p) => paths.has(p));
        } catch (error) {
          if ((error as { code?: number }).code !== 1) throw error;
        }
      }
      // Imports and citations get a slot before broad symbol matches consume the read budget.
      for (const [path, source] of Array.from(loaded)) {
        for (const imp of source.index.imports) {
          if (
            !source.index.uses.some(
              (u) =>
                u.symbol === imp.local &&
                (focus.get(path) ?? []).some((l) => Math.abs(l - u.line) <= 20),
            )
          )
            continue;
          const target = resolveEvidenceImport(path, imp.from, paths);
          if (target) await read(target);
        }
      }
      for (const path of matches.slice(0, 64)) await read(path);
      const candidates: JevCandidate[] = [];
      const seen = new Set<string>();
      const add = (path: string, symbol: string, line: number, kind: string) => {
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
          sourceHash: source.digest,
          completeFile,
          text: completeFile
            ? full
            : formatSourceExcerpt(lines.slice(start, line + 16), start + 1, line, 2048),
        });
      };
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
            if (d.symbol === imp.imported) add(resolved, d.symbol, d.start, 'imported definition');
          }
        }
      }
      for (const [path, source] of loaded) {
        const lines = source.text.split(/\r?\n/);
        for (const symbol of symbols) {
          const line = lines.findIndex((l) =>
            new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`).test(l),
          );
          if (line >= 0) add(path, symbol, line + 1, 'text reference; binding unresolved');
        }
      }
      const docs = scope === 'verification' && this.docsPath ? await this.documents() : [];
      // Reserve documentation candidates so a large code pool cannot evict all external contracts.
      const pool = [...candidates.slice(0, 2), ...docs, ...candidates.slice(2)];
      const task = evidenceTask(findings);
      const omitted = [...new Set([...seeds, ...matches])].filter(
        (p) => paths.has(p) && !loaded.has(p),
      );
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

  private async load(path: string, signal: AbortSignal) {
    const source = await readTrackedSource(this.workspace, path, signal);
    if (!source) return undefined;
    const digest = hash(source.text);
    const old = this.cache.get(path);
    if (old?.digest === digest && old.truncated === source.truncated) return old;
    let index: SourceIndex = { definitions: [], imports: [], uses: [] };
    try {
      index = indexEvidenceSource(path, source.text);
    } catch {
      /* Unsupported syntax retains bounded text references. */
    }
    const value = { ...source, digest, index };
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
        sourceHash: hash(d.text),
        completeFile: false,
        text: formatSourceExcerpt(d.text.split('\n'), 1, 1, 2048),
      };
    });
  }
}
