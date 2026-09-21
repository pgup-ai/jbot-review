import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { indexEvidenceSource, resolveEvidenceImport } from '../src/shared/evidence.ts';
import { findingSourceLocations } from '../src/shared/finding-context.ts';
import { formatJevPrefetch, type JevCandidate } from '../src/shared/prompt.ts';
import { isRecord } from '../src/shared/text.ts';
import type { Finding } from '../src/shared/types.ts';

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
  const searches: string[] = [];
  let unsupportedReads = 0;
  for (const [id, call] of calls) {
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
    if (call.name !== 'read_file') continue;
    const raw = call.input.file_path ?? call.input.path;
    const path = typeof raw === 'string' ? relative(workspace, resolve(workspace, raw)) : '';
    const source = sources.get(path);
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
  return { reads, searches, unsupportedReads };
}

type Trace = ReturnType<typeof nativeInvestigationTrace>;

export function investigationOverlap(review: Trace, verification: Trace) {
  const previous = new Set(review.reads.flatMap((r) => r.lines.map((line) => `${r.path}:${line}`)));
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

export function nativeEvidenceHandoff(
  review: Trace,
  findings: Finding[],
  sources: Map<string, string>,
  revision: string,
) {
  const observed = new Map<string, Set<number>>();
  for (const read of review.reads) {
    const lines = observed.get(read.path) ?? new Set<number>();
    read.lines.forEach((line) => lines.add(line));
    observed.set(read.path, lines);
  }
  const relevant = new Set(findingSourceLocations(findings).locations.map((r) => r.path));
  for (const path of relevant) {
    if (!observed.has(path)) continue;
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
  const candidates: JevCandidate[] = [];
  for (const [path, observedLines] of observed) {
    const source = sources.get(path)!;
    const lines = source.replace(/\n$/, '').split('\n');
    const numbers = [...observedLines].sort((a, b) => a - b);
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
  const selected = candidates
    .filter((c) => relevant.has(c.path) && Buffer.byteLength(c.text) <= 2048)
    .slice(0, 8);
  let omitted = candidates.filter((c) => !selected.includes(c));
  while (selected.length && Buffer.byteLength(formatJevPrefetch(selected, omitted)) > 16 * 1024) {
    selected.pop();
    omitted = candidates.filter((c) => !selected.includes(c));
  }
  return {
    context: formatJevPrefetch(selected, omitted),
    selected: selected.map((c) => c.path),
    omitted: omitted.map((c) => c.path),
  };
}
