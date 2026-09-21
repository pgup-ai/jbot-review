import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readTrackedSource } from './finding-context.ts';
import { selectPrefetchCandidates } from './jev-prefetch.ts';
import { formatJevPrefetch } from './prompt.ts';
import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { indexEvidenceSource, resolveEvidenceImport } from './evidence.ts';
import { findingSourceLocations } from './finding-context.ts';
import type { JevCandidate } from './prompt.ts';
import { isRecord } from './text.ts';
import type { Finding } from './types.ts';

export function nativeInvestigationTrace(
  transcript: string,
  workspace: string,
  sources: Map<string, string>,
) {
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const results = new Map<string, unknown>();
  for (const line of transcript.split('\n').filter(Boolean)) {
    const entry: unknown = JSON.parse(line);
    if (!isRecord(entry) || entry.type !== 'message' || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (
        message.role === 'assistant' &&
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        typeof block.name === 'string' &&
        isRecord(block.input)
      )
        calls.set(block.id, { name: block.name, input: block.input });
      if (
        message.role === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        !block.is_error
      )
        results.set(block.tool_use_id, block.content);
    }
  }
  const reads: { path: string; lines: number[] }[] = [];
  const searchReads: { path: string; lines: number[] }[] = [];
  const paths = new Set<string>();
  const searches: string[] = [];
  let unsupportedReads = 0;
  for (const [id, call] of calls) {
    const result = results.get(id);
    const text =
      typeof result === 'string'
        ? result
        : Array.isArray(result)
          ? result
              .filter((b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
          : '';
    if (['grep', 'glob'].includes(call.name) && results.has(id)) {
      const input = Object.fromEntries(
        Object.entries(call.input).sort(([a], [b]) => a.localeCompare(b)),
      );
      searches.push(
        createHash('sha256')
          .update(JSON.stringify([call.name, input]))
          .digest('hex'),
      );
    }
    if (call.name === 'grep' && results.has(id)) {
      const matches = new Map<string, Set<number>>();
      for (const match of text.matchAll(/^(.+?)([:-])(\d+)\2(.*)$/gm)) {
        const path = relative(workspace, resolve(workspace, match[1]));
        if (!path || path === '..' || path.startsWith('../')) continue;
        paths.add(path);
        const source = sources.get(path)?.split('\n');
        const line = Number(match[3]);
        if (source?.[line - 1] !== match[4]) continue;
        const lines = matches.get(path) ?? new Set<number>();
        lines.add(line);
        matches.set(path, lines);
      }
      for (const [path, lines] of matches)
        searchReads.push({ path, lines: [...lines].sort((a, b) => a - b) });
    }
    if (call.name !== 'read_file') continue;
    const raw = call.input.file_path ?? call.input.path;
    const path = typeof raw === 'string' ? relative(workspace, resolve(workspace, raw)) : '';
    if (path && path !== '..' && !path.startsWith('../')) paths.add(path);
    const source = sources.get(path);
    const lines = source?.replace(/\n$/, '').split('\n');
    const numbered = [...text.matchAll(/^(\d+): (.*)$/gm)];
    if (
      !lines ||
      !numbered.length ||
      call.input.paths ||
      call.input.include ||
      numbered.some((m) => lines[Number(m[1]) - 1] !== m[2])
    ) {
      unsupportedReads++;
      continue;
    }
    reads.push({
      path,
      lines: [...new Set(numbered.map((m) => Number(m[1])))].sort((a, b) => a - b),
    });
  }
  return { reads, searchReads, paths: [...paths], searches, unsupportedReads };
}

type Trace = ReturnType<typeof nativeInvestigationTrace>;

export function investigationOverlap(review: Trace, verification: Trace) {
  const previous = new Set(
    [...review.reads, ...review.searchReads].flatMap((r) =>
      r.lines.map((line) => `${r.path}:${line}`),
    ),
  );
  const current = new Set(
    verification.reads.flatMap((r) => r.lines.map((line) => `${r.path}:${line}`)),
  );
  return {
    readCalls: verification.reads.length,
    overlappingReadCalls: verification.reads.filter((r) =>
      r.lines.some((line) => previous.has(`${r.path}:${line}`)),
    ).length,
    fullyOverlappingReadCalls: verification.reads.filter((r) =>
      r.lines.every((line) => previous.has(`${r.path}:${line}`)),
    ).length,
    uniqueReadLines: current.size,
    overlappingLines: [...current].filter((key) => previous.has(key)).length,
    exactRepeatedSearches: verification.searches.filter((key) => review.searches.includes(key))
      .length,
    unsupportedReads: verification.unsupportedReads,
  };
}

export function nativeEvidenceCandidates(
  review: Trace,
  findings: Pick<Finding, 'path' | 'line' | 'body'>[],
  sources: Map<string, string>,
  revision: string,
  suppliedContext = '',
) {
  const observed = new Map<string, Set<number>>();
  for (const read of [...review.reads, ...review.searchReads]) {
    const lines = observed.get(read.path) ?? new Set<number>();
    read.lines.forEach((line) => lines.add(line));
    observed.set(read.path, lines);
  }
  const references = findingSourceLocations(findings).locations;
  const relevant = new Set(references.map((r) => r.path));
  for (const path of relevant) {
    if (!sources.has(path)) continue;
    const text = sources.get(path)!;
    try {
      for (const imp of indexEvidenceSource(path, text).imports) {
        const target = resolveEvidenceImport(path, imp.from, new Set(observed.keys()));
        if (target) relevant.add(target);
      }
    } catch {
      // Unsupported syntax leaves relevance limited to the finding's citations.
    }
  }
  const supplied = new Set<string>();
  for (const block of suppliedContext.matchAll(
    /^### (.+):[1-9]\d*\n((?:\d+: [^\n]*(?:\n|$))*)/gm,
  )) {
    const lines = sources.get(block[1])?.replace(/\n$/, '').split('\n');
    for (const line of block[2].matchAll(/^(\d+): (.*)$/gm))
      if (lines?.[Number(line[1]) - 1] === line[2]) supplied.add(`${block[1]}:${line[1]}`);
  }
  let duplicateLines = 0;
  const candidates: JevCandidate[] = [];
  for (const [path, observedLines] of observed) {
    const source = sources.get(path)!;
    const lines = source.replace(/\n$/, '').split('\n');
    const numbers = [...observedLines]
      .filter((line) => !supplied.has(`${path}:${line}`))
      .sort((a, b) => a - b);
    duplicateLines += observedLines.size - numbers.length;
    if (!numbers.length) continue;
    const focus = references.find((ref) => ref.path === path)?.line ?? numbers[0];
    let bytes = numbers.reduce(
      (total, line) => total + Buffer.byteLength(`${line}: ${lines[line - 1]}\n`),
      0,
    );
    while (numbers.length > 1 && bytes > 2048) {
      const line =
        Math.abs(numbers[0] - focus) > Math.abs(numbers.at(-1)! - focus)
          ? numbers.shift()!
          : numbers.pop()!;
      bytes -= Buffer.byteLength(`${line}: ${lines[line - 1]}\n`);
    }
    const text = numbers.map((line) => `${line}: ${lines[line - 1]}`).join('\n');
    candidates.push({
      path,
      line: numbers[0],
      symbol: revision,
      kind: 'native review read',
      sourceHash: createHash('sha256').update(source).digest('hex'),
      completeFile: numbers.length === lines.length,
      text,
    });
  }
  const eligible = candidates.filter(
    (c) => relevant.has(c.path) && Buffer.byteLength(c.text) <= 2048,
  );
  return {
    candidates: eligible,
    duplicateLines,
    omitted: candidates.filter((c) => !eligible.includes(c)).map((c) => c.path),
  };
}

export class NativeEvidenceStore {
  private files = new Map<string, { source: string; lines: Set<number> }>();
  private inventory?: Promise<Set<string>>;
  constructor(
    private workspace: string,
    private revision: string,
  ) {}

  async observe(transcript: string) {
    const signal = AbortSignal.timeout(1500);
    this.inventory ??= promisify(execFile)('git', ['ls-files', '-z'], {
      cwd: this.workspace,
      signal,
      maxBuffer: 2 * 1024 * 1024,
    }).then(({ stdout }) => new Set(stdout.split('\0').filter(Boolean)));
    const tracked = await this.inventory;
    const sources = new Map<string, string>();
    const paths = nativeInvestigationTrace(transcript, this.workspace, sources).paths;
    let omitted = 0;
    for (const path of paths) {
      if (this.files.size >= 64 && !this.files.has(path)) {
        omitted++;
        continue;
      }
      const file = await readTrackedSource(this.workspace, path, signal, { tracked });
      if (!file || file.truncated) {
        omitted++;
        continue;
      }
      sources.set(path, file.text);
      this.files.set(
        path,
        this.files.get(path)?.source === file.text
          ? this.files.get(path)!
          : { source: file.text, lines: new Set() },
      );
    }
    const trace = nativeInvestigationTrace(transcript, this.workspace, sources);
    for (const read of [...trace.reads, ...trace.searchReads])
      for (const line of read.lines) this.files.get(read.path)!.lines.add(line);
    return { files: this.files.size, omitted, unsupportedReads: trace.unsupportedReads };
  }

  async prepare(findings: Pick<Finding, 'path' | 'line' | 'body'>[], supplied: string) {
    const sources = new Map<string, string>();
    const reads: { path: string; lines: number[] }[] = [];
    const signal = AbortSignal.timeout(1500);
    const tracked = await this.inventory;
    let staleFiles = 0;
    const snapshot = [...this.files];
    if (tracked)
      for (const [path, observed] of snapshot) {
        const file = await readTrackedSource(this.workspace, path, signal, { tracked });
        if (!file || file.truncated || file.text !== observed.source) {
          staleFiles++;
          continue;
        }
        sources.set(path, file.text);
        reads.push({ path, lines: [...observed.lines] });
      }
    if (tracked)
      for (const ref of findingSourceLocations(findings).locations.slice(0, 20)) {
        if (sources.has(ref.path)) continue;
        const file = await readTrackedSource(this.workspace, ref.path, signal, { tracked });
        if (file && !file.truncated) sources.set(ref.path, file.text);
      }
    const evidence = nativeEvidenceCandidates(
      { reads, searchReads: [], paths: [], searches: [], unsupportedReads: 0 },
      findings,
      sources,
      this.revision,
      supplied,
    );
    const candidates = evidence.candidates;
    const selected = selectPrefetchCandidates(
      candidates,
      candidates.map((_, i) => i),
      candidates,
      candidates.length,
    );
    const packet = formatJevPrefetch(
      selected.map((i) => candidates[i]),
      candidates.filter((_, i) => !selected.includes(i)),
    );
    return {
      packet,
      stats: {
        candidates: candidates.length,
        selected: selected.length,
        duplicateLines: evidence.duplicateLines,
        staleFiles,
        omitted: evidence.omitted.length + candidates.length - selected.length,
        bytes: Buffer.byteLength(packet),
      },
    };
  }
}
