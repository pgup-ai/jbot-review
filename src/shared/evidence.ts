import { parse, type ParserPlugin } from '@babel/parser';
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
import type { PackSource, PackSourceProvider } from './context-pack.ts';
import type { PrFile } from './github.ts';
import type { Finding } from './types.ts';

const exec = promisify(execFile);
const PACK_SOURCE_GLOBS = ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mts', '*.cts', '*.mjs', '*.cjs'];
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
// Falls back to an inner .id (e.g. a PrivateName like #repo lacks its own .name/.value).
const keyOrPrivateName = (value: unknown) => name(value) || name(ast(value)?.id);
// A computed key only counts when it's a string literal, e.g. ['status.in'].
const keyName = (key: unknown, computed: unknown) =>
  computed && ast(key)?.type !== 'StringLiteral' ? '' : keyOrPrivateName(key);
type SourceIndex = {
  definitions: { symbol: string; start: number; end: number }[];
  imports: { local: string; imported: string; from: string; line: number }[];
  uses: { symbol: string; line: number }[];
};

export type DeclarationKind =
  'function' | 'class' | 'variable' | 'type' | 'method' | 'property' | 'constructor';

/** Context-pack index: `SourceIndex` plus the declarations a review page cites. */
export type RichSourceIndex = SourceIndex & {
  declarations: {
    symbol: string;
    start: number;
    end: number;
    kind: DeclarationKind;
    owner?: string;
  }[];
  /** Anonymous functions passed as call arguments, such as test callbacks. */
  callbacks: { start: number; end: number }[];
  reexports: { exported: string; imported: string; from: string }[];
  /** Constructor parameter properties: `this.<name>` holds a `<type>`. */
  injected: { owner: string; name: string; type: string }[];
  /** `this.<member>` has target '', `this.<target>.<member>` names the target. */
  memberCalls: { target: string; member: string; line: number }[];
};

const FUNCTION_VALUE = new Set(['FunctionExpression', 'ArrowFunctionExpression']);
const MEMBER_KIND: Record<string, DeclarationKind> = {
  ClassMethod: 'method',
  ClassPrivateMethod: 'method',
  TSDeclareMethod: 'method',
  ClassProperty: 'property',
  ClassPrivateProperty: 'property',
};
const TYPE_DECLARATION = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
]);

/** NestJS parameter decorators need the legacy plugin; only the modern one reads a decorated computed key. */
function parseSource(path: string, text: string) {
  // .ts cannot hold JSX, and enabling it there rejects generic arrows such as <T>(x: T) => x.
  const plugins: ParserPlugin[] = /\.[cm]?ts$/i.test(path) ? ['typescript'] : ['typescript', 'jsx'];
  const options = (decorators: ParserPlugin) => ({
    sourceType: 'unambiguous' as const,
    plugins: [...plugins, decorators],
    attachComment: false,
  });
  try {
    return parse(text, options('decorators-legacy'));
  } catch {
    return parse(text, options('decorators'));
  }
}

export function indexEvidenceSource(path: string, text: string): SourceIndex;
export function indexEvidenceSource(
  path: string,
  text: string,
  options: { rich: true },
): RichSourceIndex;
export function indexEvidenceSource(
  path: string,
  text: string,
  options: { rich?: boolean } = {},
): SourceIndex | RichSourceIndex {
  const result: RichSourceIndex = {
    definitions: [],
    imports: [],
    uses: [],
    declarations: [],
    callbacks: [],
    reexports: [],
    injected: [],
    memberCalls: [],
  };
  function indexRich(n: Ast, parent: Ast | undefined, owner: string | undefined) {
    if (!n.loc) return;
    const start = n.loc.start.line;
    const end = n.loc.end.line;
    const declare = (symbol: string, kind: DeclarationKind, memberOf?: string) => {
      if (symbol)
        result.declarations.push({
          symbol,
          start,
          end,
          kind,
          ...(memberOf ? { owner: memberOf } : {}),
        });
    };
    const member = MEMBER_KIND[n.type];
    if (n.type === 'FunctionDeclaration') declare(name(n.id), 'function');
    else if (n.type === 'ClassDeclaration') declare(name(n.id), 'class');
    else if (TYPE_DECLARATION.has(n.type)) declare(name(n.id), 'type');
    else if (n.type === 'VariableDeclarator')
      declare(name(n.id), FUNCTION_VALUE.has(ast(n.init)?.type ?? '') ? 'function' : 'variable');
    else if (
      n.type === 'ObjectMethod' ||
      (n.type === 'ObjectProperty' && FUNCTION_VALUE.has(ast(n.value)?.type ?? ''))
    )
      declare(keyName(n.key, n.computed), 'function');
    else if (member && owner && n.kind === 'constructor') {
      declare('constructor', 'constructor', owner);
      for (const param of (n.params as Ast[] | undefined) ?? []) {
        const parameter = param.type === 'TSParameterProperty' ? ast(param.parameter) : undefined;
        const type = ast(ast(ast(parameter?.typeAnnotation)?.typeAnnotation)?.typeName);
        if (parameter && type?.type === 'Identifier')
          result.injected.push({ owner, name: name(parameter), type: name(type) });
      }
    } else if (member && owner) {
      // An arrow/function-valued class property (`handle = () => {}`) is a method, not data.
      const kind =
        member === 'property' && FUNCTION_VALUE.has(ast(n.value)?.type ?? '') ? 'method' : member;
      declare(keyName(n.key, n.computed), kind, owner);
    } else if (
      FUNCTION_VALUE.has(n.type) &&
      ['CallExpression', 'NewExpression'].includes(parent?.type ?? '')
    )
      result.callbacks.push({ start, end });
    else if (n.type === 'ExportAllDeclaration')
      result.reexports.push({ exported: '*', imported: '*', from: name(n.source) });
    else if (n.type === 'ExportNamedDeclaration' && n.source)
      for (const s of (n.specifiers as Ast[] | undefined) ?? [])
        result.reexports.push({
          exported: name(s.exported),
          imported: s.type === 'ExportNamespaceSpecifier' ? '*' : name(s.local),
          from: name(n.source),
        });
    else if (
      (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') &&
      !n.computed
    ) {
      const object = ast(n.object);
      // The property's own line, not `this`'s, so a chain broken across lines matches changed lines.
      const line = ast(n.property)?.loc?.start.line ?? start;
      if (object?.type === 'ThisExpression')
        result.memberCalls.push({ target: '', member: keyOrPrivateName(n.property), line });
      else if (
        (object?.type === 'MemberExpression' || object?.type === 'OptionalMemberExpression') &&
        !object.computed &&
        ast(object.object)?.type === 'ThisExpression'
      )
        result.memberCalls.push({
          target: keyOrPrivateName(object.property),
          member: keyOrPrivateName(n.property),
          line,
        });
    }
  }
  function walk(n: Ast, parent?: Ast, owner?: string) {
    if (n.type === 'ImportDeclaration') {
      for (const s of n.specifiers as Ast[])
        result.imports.push({
          local: name(s.local),
          imported: name(s.imported) || (s.type === 'ImportDefaultSpecifier' ? 'default' : '*'),
          from: name(n.source),
          line: s.loc?.start?.line ?? n.loc!.start!.line,
        });
      return;
    }
    if (options.rich) indexRich(n, parent, owner);
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
    const scope =
      n.type === 'ClassDeclaration' || n.type === 'ClassExpression' ? symbol || undefined : owner;
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
        for (const child of value) if (ast(child)?.type) walk(child as Ast, n, scope);
      } else if (ast(value)?.type) walk(value as Ast, n, scope);
    }
  }
  if (JS_SOURCE.test(path)) walk(parseSource(path, text) as unknown as Ast);
  if (options.rich) return result;
  const { definitions, imports, uses } = result;
  return { definitions, imports, uses };
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

export interface PathAlias {
  /** Specifier prefix; wildcard aliases stop at the `*`. */
  prefix: string;
  wildcard: boolean;
  targets: string[];
}

/** tsconfig `compilerOptions.paths`, tolerating a leading BOM, comments and trailing commas. */
export function parseTsconfigPaths(text: string): PathAlias[] {
  const source = text.replace(/^\uFEFF/, '');
  let json = '';
  for (let i = 0, quoted = false; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      json += c;
      if (c === '\\') json += source[++i] ?? '';
      else if (c === '"') quoted = false;
    } else if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      json += '\n';
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      quoted = c === '"';
      json += c;
    }
  }
  const options = (
    JSON.parse(json.replace(/,(\s*[}\]])/g, '$1')) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    }
  ).compilerOptions;
  const baseUrl = options?.baseUrl ?? '.';
  // Cap entries/targets: a hostile tsconfig must not blow up alias-matching CPU.
  return Object.entries(options?.paths ?? {})
    .slice(0, 256)
    .map(([key, targets]) => ({
      prefix: key.replace(/\*$/, ''),
      wildcard: key.endsWith('*'),
      targets: targets.slice(0, 8).map((target) => posix.normalize(posix.join(baseUrl, target))),
    }))
    .sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.prefix.length - a.prefix.length);
}

const IMPORT_SUFFIXES = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

/** Only tracked paths resolve, so an alias in a PR's tsconfig cannot point reads outside the repo. */
export function resolveEvidenceImport(
  path: string,
  specifier: string,
  paths: Set<string>,
  aliases: PathAlias[] = [],
): string | undefined {
  const bases = specifier.startsWith('.')
    ? [posix.normalize(posix.join(posix.dirname(path), specifier))]
    : aliases.flatMap(({ prefix, wildcard, targets }) =>
        wildcard
          ? specifier.startsWith(prefix)
            ? targets.map((target) => target.replace('*', () => specifier.slice(prefix.length)))
            : []
          : specifier === prefix
            ? targets
            : [],
      );
  for (const base of bases) {
    const stem = base.replace(/\.[cm]?js$/, '');
    const hit = [base, ...IMPORT_SUFFIXES.map((suffix) => stem + suffix)].find((p) => paths.has(p));
    if (hit) return hit;
  }
  return undefined;
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
  private packInventory?: Promise<{ tracked: Set<string>; aliases: PathAlias[] }>;
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

  /** Head-source access for one page's context pack; inventory and aliases load once per run. */
  async packProvider(signal: AbortSignal): Promise<PackSourceProvider> {
    this.packInventory ??= (async () => {
      const tracked = await this.tracked(AbortSignal.timeout(4000));
      // Nx-style repos keep `paths` in tsconfig.base.json.
      for (const file of ['tsconfig.json', 'tsconfig.base.json']) {
        try {
          const config = await this.read(file, AbortSignal.timeout(1000), tracked);
          const aliases = config ? parseTsconfigPaths(config.text) : [];
          if (aliases.length) return { tracked, aliases };
        } catch {
          // An unreadable or invalid config keeps relative imports only.
        }
      }
      return { tracked, aliases: [] };
    })().catch((error) => {
      // The next page retries instead of every page falling back for the rest of the run.
      this.packInventory = undefined;
      throw error;
    });
    const { tracked, aliases } = await waitForEvidence(this.packInventory, signal);
    let files = 0;
    let bytes = 0;
    return {
      tracked,
      aliases,
      load: async (path): Promise<PackSource | undefined> => {
        if (!JS_SOURCE.test(path)) return undefined;
        signal.throwIfAborted();
        // A cap miss counts as uncollected, like a deadline miss.
        if (files >= 64 || bytes >= 2 * 1024 * 1024) throw new Error('context pack file cap');
        const source = await this.read(path, signal, tracked);
        // The tracked reader swallows aborts, so a deadline surfaces here as a rejection.
        signal.throwIfAborted();
        // A file cut at the read cap cannot be parsed or cited by line.
        if (!source || source.truncated) return undefined;
        files++;
        bytes += Buffer.byteLength(source.text);
        try {
          const index = indexEvidenceSource(path, source.text, { rich: true });
          return { lines: source.text.split(/\r?\n/), index };
        } catch {
          // Syntax Babel rejects is a missing source, not a missed deadline.
          return undefined;
        }
      },
      references: async (symbol, paths) => {
        const scope = paths?.map((path) => `:(literal)${path}`) ?? PACK_SOURCE_GLOBS;
        const { stdout } = await exec(
          'git',
          ['grep', '-n', '-z', '-I', '-w', '-F', '-e', symbol, '--', ...scope],
          { cwd: this.workspace, signal, maxBuffer: 4 * 1024 * 1024 },
        ).catch((error) => {
          if (error.code === 1) return { stdout: '' };
          throw error;
        });
        // A -z record is path NUL line NUL text; paths may hold newlines, and -I skips binaries.
        return [...stdout.matchAll(/([^\0]*)\0(\d+)\0[^\n]*\n/g)].map(([, path, line]) => ({
          path,
          line: Number(line),
        }));
      },
    };
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
    if (!this.reuse.shared) return readTrackedSource(this.workspace, path, signal, { tracked });
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

  private async search(patterns: string[], signal: AbortSignal): Promise<string[]> {
    if (!patterns.length) return [];
    const key = JSON.stringify(patterns);
    let pending = this.reuse.shared ? this.searches.get(key) : undefined;
    if (pending) this.searchSharedRequests++;
    else {
      this.searchCalls++;
      pending = exec(
        'git',
        ['grep', '-l', '-z', '-F', ...patterns.flatMap((s) => ['-e', s]), '--'],
        {
          cwd: this.workspace,
          signal: this.reuse.shared ? AbortSignal.timeout(4000) : signal,
          maxBuffer: 1024 * 1024,
        },
      )
        .then(({ stdout }) => stdout.split('\0').filter(Boolean))
        .catch((error) => {
          if (error.code === 1) return [];
          throw error;
        })
        .finally(() => {
          if (this.searches.get(key) === pending) this.searches.delete(key);
        });
      if (this.reuse.shared) this.searches.set(key, pending);
    }
    return waitForEvidence(pending, signal);
  }

  async sourceContext(findings: Finding[]) {
    try {
      const signal = AbortSignal.timeout(1500);
      const tracked = await this.tracked(signal);
      const refs = findingSourceLocations(findings).locations;
      const related: { path: string; line: number }[] = [];
      for (const path of [...new Set(refs.map((ref) => ref.path))].slice(0, 20)) {
        const source = await this.load(path, signal, tracked, 256 * 1024);
        if (!source) continue;
        const mentioned = findings
          .filter((f) => f.path === path)
          .flatMap((f) => [...`${f.title} ${f.body}`.matchAll(/`([^`\n]+)`/g)])
          .flatMap((match) => match[1].match(/[A-Za-z_$][\w$]*/g) ?? [])
          .slice(0, 40);
        let lines = refs.filter((ref) => ref.path === path).map((ref) => ref.line);
        const seen = new Set(lines);
        for (let hop = 0; hop < 2; hop++) {
          const symbols = new Set([
            ...(hop === 0 ? mentioned : []),
            ...source.index.uses
              .filter((use) => lines.some((line) => Math.abs(line - use.line) <= 2))
              .map((use) => use.symbol),
          ]);
          const definitions = [...symbols].slice(0, 8).flatMap((symbol) => {
            const matches = source.index.definitions.filter((d) => d.symbol === symbol);
            const preceding = matches.filter((d) => d.start <= lines[0]);
            return preceding.length ? preceding.slice(-1) : matches.slice(0, 1);
          });
          const candidates = [
            ...source.index.imports.filter((imp) => symbols.has(imp.local)).map((imp) => imp.line),
            ...definitions.map((d) => Math.min(d.end, d.start + 8)),
          ];
          for (const line of candidates.slice(0, 6))
            if (![...seen].some((covered) => Math.abs(line - covered) <= 20)) {
              seen.add(line);
              related.push({ path, line });
            }
          lines = definitions.map((d) => d.start);
        }
      }
      return await buildFindingSourceContext(
        this.workspace,
        findings,
        (path, signal) => this.read(path, signal, tracked),
        related,
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
        scope === 'verification' || options.locations
          ? refs.map((r) => r.path)
          : this.files.map((f) => f.filename);
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
          scope === 'verification' || options.locations
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
      // A changed internal function can affect an unchanged exported wrapper's callers.
      const modules = [
        ...new Set(
          seeds
            .filter((p) => JS_SOURCE.test(p))
            .map((p) => {
              const stem = posix.basename(p, posix.extname(p));
              return stem === 'index' ? posix.basename(posix.dirname(p)) : stem;
            }),
        ),
      ].slice(0, 20);
      const isTest = (path: string) =>
        /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(path);
      const changed = new Set(this.files.map((f) => f.filename));
      const rank = (path: string) =>
        Number(isTest(path)) * 4 + Number(/^scripts?\//.test(path)) * 2 + Number(changed.has(path));
      const byRank = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);
      const callers = (
        await this.search(
          modules.map((m) => `/${m}`),
          signal,
        )
      )
        .filter((p) => paths.has(p))
        .sort(byRank);
      for (const path of callers.slice(0, 20)) await read(path);
      const matches = (await this.search(symbols, signal)).filter((p) => paths.has(p)).sort(byRank);
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
        const caller = kind === 'import-linked reference' || kind === 'import-linked test';
        const start = Math.max(0, line - (caller ? 4 : 16));
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
            : formatSourceExcerpt(
                lines.slice(start, line + (caller ? 36 : 16)),
                start + 1,
                line,
                2048,
              ),
        });
      };
      if (scope === 'verification' && this.reuse.handoff) {
        const before = candidates.length;
        for (const ref of this.observations.values())
          add(ref.path, 'review source location', ref.line, 'revalidated review read');
        this.handoffCandidates += candidates.length - before;
      }
      if (scope === 'verification')
        for (const ref of refs) add(ref.path, 'cited source', ref.line, 'cited context');
      const changeWeight = new Map(
        this.files.map((f) => [f.filename, Buffer.byteLength(f.patch ?? '')]),
      );
      const callerRefs = [...loaded]
        .flatMap(([path, source]) => {
          const refs = source.index.imports.flatMap((binding) => {
            const related = resolveEvidenceImport(path, binding.from, paths);
            if (!related || !seeds.includes(related)) return [];
            return source.index.uses
              .filter((u) => u.symbol === binding.local)
              .slice(0, 1)
              .map((use) => ({ path, symbol: binding.imported, line: use.line, related }));
          });
          return refs
            .sort((a, b) => (changeWeight.get(b.related) ?? 0) - (changeWeight.get(a.related) ?? 0))
            .slice(0, 2);
        })
        .sort(
          (a, b) =>
            rank(a.path) - rank(b.path) ||
            (changeWeight.get(b.related) ?? 0) - (changeWeight.get(a.related) ?? 0) ||
            a.path.localeCompare(b.path),
        );
      for (const ref of callerRefs)
        add(
          ref.path,
          ref.symbol,
          ref.line,
          isTest(ref.path) ? 'import-linked test' : 'import-linked reference',
          ref.related,
        );
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
          ...callers,
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
    const key = JSON.stringify(['index-v3-babel-7.29.9', path, digest, source.truncated]);
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
        typeof i.from === 'string' &&
        line(i.line),
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
