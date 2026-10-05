import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  EvidenceStore,
  indexEvidenceSource,
  JS_SOURCE,
  resolveEvidenceImport,
} from './evidence.ts';
import { readTrackedSource, findingSourceLocations, SOURCE_FILE } from './finding-context.ts';
import { checkVerificationProof, requiresVerificationProof } from './filter.ts';
import { formatStateEvidence, type StateEvidenceSource, type StateEvidenceGap } from './prompt.ts';
import type { PackSource, PackSourceProvider } from './context-pack.ts';
import {
  parseVerificationProof,
  parseVerificationSupport,
  type Finding,
  type FindingVerdict,
} from './types.ts';
import { newSideLines } from './patch.ts';

const exec = promisify(execFile);
const MAX_BYTES = 16 * 1024;
const NEST_FILTER_REGISTRATIONS = ['useGlobalFilters', 'APP_FILTER'];
type Declaration = PackSource['index']['declarations'][number];
type Candidate = {
  path: string;
  source: PackSource;
  declaration: Declaration;
  line: number;
  from?: string;
  unverifiedReceiver?: boolean;
  registered?: boolean;
};

export function stateEvidenceTerms(findings: Finding[], context: string) {
  const fields = new Set<string>();
  const enums = new Set<string>();
  for (const finding of findings.filter((finding) => requiresVerificationProof(finding))) {
    const claim = `${finding.title}\n${finding.body}`.replace(
      /\b[\w./-]+\.[cm]?[jt]sx?(?::\d+)?\b/g,
      '',
    );
    const properties = [...claim.matchAll(/\b[a-z]\w*\.([a-z]\w*)\b(?![\w(])/g)].map((m) => m[1]);
    const explicit = [...claim.matchAll(/\b([A-Z]\w*)\.([A-Z]\w*)\b/g)];
    const explicitFields = new Set(
      explicit.map((m) => m[1].match(/(State|Stage|Status|Type)$/)?.[1].toLowerCase()),
    );
    const inferred = [...context.matchAll(/\b([A-Z]\w*)\.([A-Z]\w*)\b/g)].filter((m) => {
      const suffix = m[1].match(/(State|Stage|Status|Type)$/)?.[1].toLowerCase();
      return (
        suffix &&
        !explicitFields.has(suffix) &&
        properties.includes(suffix) &&
        new RegExp(`\\b${m[2]}\\b`).test(claim)
      );
    });
    const owners = [...explicit, ...inferred];
    properties.forEach((field) => fields.add(field));
    if (owners.length) owners.forEach((m) => enums.add(m[1]));
    else {
      for (const match of claim.matchAll(/`([a-z]\w*)`/g)) fields.add(match[1]);
    }
  }
  return { fields: [...fields].slice(0, 8), enums: [...enums].slice(0, 6) };
}

function suppliedSourceLines(context: string) {
  const supplied = new Map<string, Map<number, string>>();
  for (const match of context.matchAll(/^#### ([^\n]+)\n```diff\n([^]*?)\n```/gm)) {
    const lines = supplied.get(match[1]) ?? new Map<number, string>();
    for (const row of newSideLines(match[2])) lines.set(row.line, row.content);
    supplied.set(match[1], lines);
  }
  let path = '';
  for (const line of context.split('\n')) {
    const heading = line.match(/^#{3,4} ([^\n]+?):\d+(?:-|\s|$)/);
    if (heading) path = heading[1];
    else if (line.startsWith('#')) path = '';
    const numbered = line.match(/^(\d+): (.*)$/);
    if (path && numbered) {
      if (!supplied.has(path)) supplied.set(path, new Map());
      supplied.get(path)!.set(Number(numbered[1]), numbered[2]);
    }
  }
  return supplied;
}

export async function collectStateEvidence(
  provider: PackSourceProvider,
  findings: Finding[],
  context: string,
): Promise<string> {
  const terms = stateEvidenceTerms(findings, context);
  const loaded = new Map<string, PackSource | undefined>();
  let incomplete = false;
  const load = async (path: string) => {
    if (!loaded.has(path))
      loaded.set(
        path,
        await provider.load(path).catch(() => {
          incomplete = true;
          return undefined;
        }),
      );
    return loaded.get(path);
  };
  const candidates: Candidate[] = [];
  const functionAt = (source: PackSource, line: number) =>
    source.index.declarations
      .filter((d) => ['method', 'function'].includes(d.kind) && d.start <= line && line <= d.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  const proximity = (path: string) =>
    Math.max(
      0,
      ...findings
        .filter((finding) => requiresVerificationProof(finding))
        .map((finding) => {
          const parts = finding.path.split('/');
          let common = 0;
          for (const part of path.split('/')) {
            if (part !== parts[common]) break;
            common++;
          }
          return common;
        }),
    );
  const searched = new Set<string>();
  try {
    for (let hop = 0; hop < 2; hop++) {
      const paths = new Map<string, boolean>();
      for (const symbol of [...terms.enums, ...terms.fields]) {
        if (searched.has(symbol)) continue;
        searched.add(symbol);
        for (const ref of await provider.references(symbol))
          if (!/(?:^|\/)(?:tests?|__tests__)\/|[.-](?:test|spec)\./.test(ref.path))
            paths.set(ref.path, paths.get(ref.path) || terms.fields.includes(symbol));
      }
      const ranked = [...paths.keys()]
        .filter((path) => !loaded.has(path))
        .sort(
          (a, b) =>
            Number(paths.get(b)) - Number(paths.get(a)) ||
            proximity(b) - proximity(a) ||
            a.localeCompare(b),
        );
      const room = Math.max(0, 32 - loaded.size);
      incomplete ||= ranked.length > room;
      for (const path of ranked.slice(0, room)) {
        const source = await load(path);
        if (!source) {
          incomplete = true;
          continue;
        }
        // A guard's status can be derived from another state enum in the same source.
        for (const owner of stateEvidenceTerms(findings, source.lines.join('\n')).enums)
          if (terms.enums.length < 6 && !terms.enums.includes(owner)) terms.enums.push(owner);
      }
    }
  } catch {
    incomplete = true;
  }
  for (const [path, source] of loaded) {
    if (!source) continue;
    for (const write of source.index.writes) {
      if (write.field.startsWith('$')) continue;
      if (!(
        terms.enums.some((e) => write.value.startsWith(e + '.')) ||
        terms.fields.includes(write.field)
      ))
        continue;
      const declaration = functionAt(source, write.line);
      if (
        declaration &&
        !candidates.some(
          (c) =>
            c.path === path &&
            c.declaration.start === declaration.start &&
            c.declaration.end === declaration.end,
        )
      )
        candidates.push({ path, source, declaration, line: write.line });
    }
  }
  const score = (candidate: Candidate) => {
    const { source, declaration: d } = candidate;
    const writes = source.index.writes.filter((w) => w.line >= d.start && w.line <= d.end);
    return (
      Number(writes.some((w) => terms.enums.some((e) => w.value.startsWith(e + '.')))) * 4 +
      Number(/^(?:bulk)?(?:create|add|insert|update|set|transition)/i.test(d.symbol)) * 2
    );
  };
  candidates.sort(
    (a, b) =>
      score(b) - score(a) ||
      proximity(b.path) - proximity(a.path) ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
  const missing = new Map<string, StateEvidenceGap>();
  const declared = async (
    path: string,
    symbol: string,
    owner?: string,
    hops = new Set<string>(),
  ): Promise<Candidate | undefined> => {
    const key = `${path}:${owner ?? ''}:${symbol}`;
    if (hops.has(key) || hops.size >= 4) return undefined;
    hops.add(key);
    const source = await load(path);
    if (!source) return undefined;
    const declaration = source.index.declarations
      .filter((d) => d.symbol === symbol && d.owner === owner)
      .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
    if (declaration) return { path, source, declaration, line: declaration.start };
    const binding = source.index.imports.find((i) => i.local === symbol);
    const exports = source.index.reexports.filter(
      (r) => r.exported === symbol || r.exported === '*',
    );
    for (const next of [...(binding ? [binding] : []), ...exports]) {
      const target = resolveEvidenceImport(path, next.from, provider.tracked, provider.aliases);
      if (!target) continue;
      const found = await declared(
        target,
        next.imported === '*' ? symbol : next.imported,
        owner,
        new Set(hops),
      );
      if (found) return found;
    }
    return undefined;
  };
  const seen = new Set<string>();
  const items: StateEvidenceSource[] = [];
  const queue = candidates
    .slice(0, 4)
    .map((candidate, i) => ({ candidate, priority: 4 - i, depth: 0 }));
  let omitted = Math.max(0, candidates.length - queue.length);
  // Error normalization may be registered outside the writer's dependency graph.
  if (
    findings.some(
      (f) =>
        requiresVerificationProof(f) &&
        /\b(error|exception|violation|throws?|escapes?)\b/i.test(f.title + ' ' + f.body),
    )
  ) {
    try {
      const apps = new Set(
        findingSourceLocations(findings).locations.flatMap((ref) => {
          const app = ref.path.match(/^apps\/[^/]+\//)?.[0];
          return app ? [app] : [];
        }),
      );
      for (const symbol of NEST_FILTER_REGISTRATIONS) {
        const refs = (await provider.references(symbol)).filter(
          (r) =>
            !/[.-](?:test|spec)\./.test(r.path) &&
            (!apps.size ||
              !r.path.startsWith('apps/') ||
              [...apps].some((app) => r.path.startsWith(app))),
        );
        const paths = [...new Set(refs.map((ref) => ref.path))];
        for (const path of paths.slice(0, 4)) {
          const source = await load(path);
          if (!source) {
            incomplete = true;
            continue;
          }
          const names = new Set([
            symbol,
            ...source.index.imports.filter((i) => i.imported === symbol).map((i) => i.local),
          ]);
          const registrations =
            symbol === 'APP_FILTER'
              ? source.index.writes.flatMap((w) =>
                  w.field === 'provide' && names.has(w.value) && w.object ? [w.object] : [],
                )
              : source.index.calls
                  .filter((c) => names.has(c.symbol))
                  .map((c) => ({ start: c.line, end: c.end }));
          for (const range of registrations.slice(0, 4)) {
            const declaration = { symbol, kind: 'function' as const, ...range };
            queue.push({
              candidate: { path, source, declaration, line: range.start, registered: true },
              priority: 80,
              depth: 0,
            });
          }
          incomplete ||= registrations.length > 4;
        }
        incomplete ||= paths.length > 4;
      }
    } catch {
      incomplete = true;
    }
  }
  const supplied = suppliedSourceLines(context);
  const enqueue = (
    found: Candidate | undefined,
    parent: Candidate,
    priority: number,
    depth: number,
  ) => {
    if (!found || found.declaration.kind === 'type') return;
    if (found.declaration.kind === 'class' && !parent.registered) return;
    if (
      found.path === parent.path &&
      parent.declaration.start < found.declaration.start &&
      found.declaration.end <= parent.declaration.end
    )
      return;
    queue.push({
      candidate: {
        ...found,
        from: `${parent.path}:${parent.line} ${parent.declaration.symbol}`,
        registered: parent.registered,
      },
      priority,
      depth,
    });
  };
  const objectMethods = new Map<string, Promise<Candidate | undefined>>();
  const objectMethod = (parent: Candidate, symbol: string) => {
    const key = `${parent.path}:${symbol}`;
    if (!objectMethods.has(key))
      objectMethods.set(
        key,
        (async () => {
          const paths = [
            ...new Set([
              parent.path,
              ...parent.source.index.imports.flatMap((i) => {
                const path = resolveEvidenceImport(
                  parent.path,
                  i.from,
                  provider.tracked,
                  provider.aliases,
                );
                return path ? [path] : [];
              }),
            ]),
          ];
          const definitions: Candidate[] = [];
          for (const path of new Set(
            (await provider.references(symbol, paths)).map((r) => r.path),
          )) {
            const source = await load(path);
            for (const declaration of source?.index.declarations ?? [])
              if (declaration.symbol === symbol && declaration.kind === 'method')
                definitions.push({ path, source: source!, declaration, line: declaration.start });
          }
          if (definitions.length === 1) return { ...definitions[0], unverifiedReceiver: true };
          if (definitions.length > 1)
            missing.set(`${parent.path}:${symbol}`, {
              path: parent.path,
              line: parent.line,
              symbol,
              reason: 'ambiguous',
            });
          return undefined;
        })(),
      );
    return objectMethods.get(key)!;
  };
  try {
    while (queue.length && seen.size < 32) {
      queue.sort((a, b) => b.priority - a.priority);
      const { candidate, depth } = queue.shift()!;
      const { path, source, declaration: d, line } = candidate;
      const key = `${path}:${d.start}-${d.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lines = source.lines.slice(d.start - 1, d.end);
      if (!lines.every((text, i) => supplied.get(path)?.get(d.start + i) === text)) {
        const item = {
          path,
          start: d.start,
          end: d.end,
          line,
          lines,
          symbol: d.symbol,
          from: candidate.from,
          unverifiedReceiver: candidate.unverifiedReceiver,
        };
        if (
          Buffer.byteLength(
            formatStateEvidence([...items, item], omitted + queue.length, true, [
              ...missing.values(),
            ]),
          ) > MAX_BYTES
        ) {
          omitted++;
          missing.set(key, { path, line: d.start, symbol: d.symbol, reason: 'budget' });
          continue;
        }
        items.push(item);
      }
      if (depth >= 3 || d.kind === 'class') {
        incomplete = true;
        continue;
      }
      const used = new Set(
        (candidate.registered ? source.index.uses : source.index.lookups)
          .filter((u) => u.line >= d.start && u.line <= d.end)
          .map((u) => u.symbol),
      );
      for (const binding of source.index.imports.filter((i) => used.has(i.local))) {
        const found = await declared(path, binding.local);
        const line = source.index.uses.find(
          (u) => u.symbol === binding.local && u.line >= d.start && u.line <= d.end,
        )!.line;
        if (!found && resolveEvidenceImport(path, binding.from, provider.tracked, provider.aliases))
          missing.set(`${path}:${binding.local}`, {
            path,
            line,
            symbol: binding.local,
            reason: 'missing',
          });
        if (found?.declaration.kind === 'variable')
          enqueue(found, { ...candidate, line }, 100, depth + 1);
        if (found?.declaration.kind === 'class' && candidate.registered)
          enqueue(found, { ...candidate, line }, 80, depth + 1);
      }
      for (const call of source.index.calls.filter((c) => c.line >= d.start && c.line <= d.end)) {
        let found: Candidate | undefined;
        let priority = 10;
        if (call.receiver === 'this') {
          found = await declared(path, call.symbol, d.owner);
          priority = call.valueUsed
            ? /^prepare[A-Z_]/.test(call.symbol) || call.symbol === 'prepare'
              ? 90
              : 60
            : 15;
        } else if (call.receiver.startsWith('this.')) {
          const type = source.index.injected.find(
            (i) => i.owner === d.owner && i.name === call.receiver.slice(5),
          )?.type;
          const owner = type && (await declared(path, type));
          if (owner) found = await declared(owner.path, call.symbol, owner.declaration.symbol);
        } else if (!call.receiver) found = await declared(path, call.symbol);
        else {
          found = await objectMethod(candidate, call.symbol);
          priority = call.valueUsed ? 60 : 15;
        }
        if (found && (call.receiver === 'this' || call.receiver.startsWith('this.'))) {
          const text = found.source.lines
            .slice(found.declaration.start - 1, found.declaration.end)
            .join('\n');
          if (terms.enums.some((term) => text.includes(term))) {
            if (call.receiver !== 'this') priority = 75;
            else if (/\bthrow\b/.test(text)) priority = 90;
          }
        }
        enqueue(found, { ...candidate, line: call.line }, priority + (depth + 1) * 5, depth + 1);
      }
    }
  } catch {
    incomplete = true;
  }
  omitted += queue.filter(
    ({ candidate }) =>
      !seen.has(`${candidate.path}:${candidate.declaration.start}-${candidate.declaration.end}`),
  ).length;
  let packet = formatStateEvidence(items, omitted, incomplete || queue.length > 0, [
    ...missing.values(),
  ]);
  while (Buffer.byteLength(packet) > MAX_BYTES && items.length) {
    items.pop();
    packet = formatStateEvidence(items, ++omitted, true, [...missing.values()]);
  }
  return packet;
}

export class VerificationEvidence {
  private store: EvidenceStore;
  private revision: Promise<string | undefined>;
  constructor(private workspace: string) {
    this.store = new EvidenceStore(workspace, [], undefined, {
      shared: true,
      handoff: false,
      prefetch: false,
    });
    this.revision = this.head();
  }
  private async head() {
    return exec('git', ['rev-parse', 'HEAD'], { cwd: this.workspace, timeout: 1500 })
      .then(({ stdout }) => stdout.trim())
      .catch(() => undefined);
  }
  async prepare(findings: Finding[], context: string, timeoutMs: number) {
    try {
      return await collectStateEvidence(
        await this.store.packProvider(AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 4000)))),
        findings,
        context,
      );
    } catch {
      return formatStateEvidence([], 0, true);
    }
  }
  async support(
    verdict: FindingVerdict,
    finding: Finding,
    suppliedSource?: string,
  ): Promise<FindingVerdict> {
    const support = parseVerificationSupport(verdict.support);
    if (verdict.verdict !== 'confirmed' || verdict.unavailable || !support) return verdict;
    const supplied = suppliedSource === undefined ? undefined : suppliedSourceLines(suppliedSource);
    try {
      const revision = await this.revision;
      if (!revision || revision !== (await this.head())) return verdict;
      const signal = AbortSignal.timeout(2000);
      const sources = new Map<string, string>();
      const sourceHashes: Record<string, string> = {};
      for (const ref of support.references) {
        if (!SOURCE_FILE.test(ref.path)) return verdict;
        if (supplied && supplied.get(ref.path)?.get(ref.line)?.trim() !== ref.quote.trim())
          return verdict;
        if (!sources.has(ref.path)) {
          const source = await readTrackedSource(this.workspace, ref.path, signal);
          if (!source || source.truncated) return verdict;
          sources.set(ref.path, source.text);
          sourceHashes[ref.path] = createHash('sha256').update(source.text).digest('hex');
        }
        if (sources.get(ref.path)!.split(/\r?\n/)[ref.line - 1]?.trim() !== ref.quote.trim())
          return verdict;
      }
      if (revision !== (await this.head())) return verdict;
      return {
        ...verdict,
        verifiedSupport: {
          ...support,
          target: JSON.stringify([finding.path, finding.line, finding.title, finding.body]),
          revision,
          sourceHashes,
        },
      };
    } catch {
      return verdict;
    }
  }
  async check(verdict: FindingVerdict, finding: Finding, suppliedSource?: string) {
    if (
      verdict.verdict !== 'confirmed' ||
      !JS_SOURCE.test(finding.path) ||
      !requiresVerificationProof(finding, verdict.finding)
    )
      return verdict;
    const sources = new Map<string, string>();
    const producers = new Set<string>();
    const unindexedSources = new Set<string>();
    const proof = parseVerificationProof(verdict.proof);
    const supplied = suppliedSource === undefined ? undefined : suppliedSourceLines(suppliedSource);
    if (
      proof &&
      (!supplied ||
        [...proof.producer, ...proof.guard, ...proof.effect].every(
          (ref) => supplied.get(ref.path)?.get(ref.line)?.trim() === ref.quote.trim(),
        ))
    ) {
      try {
        const revision = await this.revision;
        if (!revision || revision !== (await this.head()))
          throw new Error('Review revision is unavailable or changed.');
        const signal = AbortSignal.timeout(2000);
        const { tracked } = await this.store.packProvider(signal);
        for (const ref of [...proof.producer, ...proof.guard, ...proof.effect]) {
          if (sources.has(ref.path)) continue;
          const source = await readTrackedSource(this.workspace, ref.path, signal, {
            tracked,
            maxBytes: 1024 * 1024,
          });
          signal.throwIfAborted();
          if (source) {
            sources.set(ref.path, source.text);
            if (JS_SOURCE.test(ref.path) && !source.truncated) {
              try {
                const index = indexEvidenceSource(ref.path, source.text, { rich: true });
                for (const write of index.writes) producers.add(`${ref.path}:${write.line}`);
                for (const call of index.calls) producers.add(`${ref.path}:${call.line}`);
                for (const declaration of index.declarations)
                  if (['function', 'method'].includes(declaration.kind))
                    producers.add(`${ref.path}:${declaration.start}`);
              } catch {
                unindexedSources.add(ref.path);
              }
            } else unindexedSources.add(ref.path);
          }
        }
      } catch {
        return {
          index: verdict.index,
          verdict: 'uncertain' as const,
          unavailable: true,
          reason: 'Proof source validation did not complete.',
        };
      }
    }
    return checkVerificationProof(verdict, finding, sources, producers, unindexedSources);
  }
}
