import { createHash } from 'node:crypto';
import { readTrackedSource } from './finding-context.ts';
import type { PrFile } from './github.ts';
import {
  formatJevPrefetch,
  buildJevRequest,
  formatSourceExcerpt,
  JEV_MODEL,
  type JevCandidate,
} from './prompt.ts';

const MAX_FILES = 12;
const MAX_CONTEXT_BYTES = 6_000;
const MAX_SELECTED = 4;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|c|h|cpp|hpp|sql)$/i;

export type JevPrefetchMode = 'off' | 'shadow' | 'on' | 'deterministic';

export interface JevPrefetchStats {
  kind: 'jev-prefetch';
  version: 3 | 4;
  scope?: 'exploration' | 'verification';
  selectedHash?: string;
  coverageBytes?: number;
  cacheHits?: number;
  parsedFiles?: number;
  omittedFiles?: number;
  mode: JevPrefetchMode;
  model: typeof JEV_MODEL | null;
  status: 'disabled' | 'skipped' | 'shadow' | 'applied' | 'fallback';
  reason?:
    | 'missing-key'
    | 'no-candidates'
    | 'no-relevant-candidates'
    | 'timeout'
    | 'http'
    | 'invalid-response'
    | 'unavailable';
  httpStatus?: number;
  candidateFiles: number;
  sampledFiles: number;
  collectedCandidates: number;
  scoredCandidates: number;
  selectedCandidates: number;
  baselineOverlap: number;
  completeFileCandidates: number;
  requestBytes: number;
  contextBytes: number;
  injectedBytes: number;
  collectMs: number;
  apiMs: number;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  selectedScores?: number[];
  requestHash?: string;
  candidateHash?: string;
}

export function selectJevCandidates(
  value: unknown,
  candidates: JevCandidate[],
  allCandidates = candidates,
) {
  const response = value as {
    model?: unknown;
    answers?: Record<string, { type?: unknown; noul?: unknown }>;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  } | null;
  if (!response || response.model !== JEV_MODEL) throw new Error('invalid-response');
  const scores = candidates.map((_, i) => {
    const answer = response.answers?.[`c${i}`];
    const score = answer?.noul;
    if (
      answer?.type !== 'noul' ||
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    )
      throw new Error('invalid-response');
    return score;
  });
  const inputTokens = response.usage?.input_tokens;
  const outputTokens = response.usage?.output_tokens;
  if (
    typeof inputTokens !== 'number' ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== 'number' ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  )
    throw new Error('invalid-response');
  const indexes = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  const selected = selectPrefetchCandidates(
    candidates,
    indexes.filter((i) => scores[i] >= 0.5),
    allCandidates,
  );
  return { selected, scores: selected.map((i) => scores[i]), inputTokens, outputTokens };
}

function selectPrefetchCandidates(
  candidates: JevCandidate[],
  indexes: number[],
  allCandidates: JevCandidate[],
) {
  const selected: number[] = [];
  const locations = new Set<string>();
  for (const index of indexes) {
    const c = candidates[index];
    if (locations.has(c.path)) continue;
    const next = [...selected, index];
    const block = formatJevPrefetch(
      next.map((i) => candidates[i]),
      allCandidates.filter((c) => !next.some((i) => candidates[i] === c)),
    );
    if (Buffer.byteLength(block) > MAX_CONTEXT_BYTES) continue;
    selected.push(index);
    locations.add(c.path);
    if (selected.length === MAX_SELECTED) break;
  }
  return selected;
}

export async function buildJevPrefetch(
  workspace: string,
  files: PrFile[],
  entries: { symbol: string; callSites: string[] }[],
  options: {
    mode: JevPrefetchMode;
    prepared?: {
      candidates: JevCandidate[];
      task: string;
      scope: 'exploration' | 'verification';
      cacheHits: number;
      parsedFiles: number;
      omittedFiles: number;
      elapsedMs: number;
    };
    apiKey?: string;
    timeoutMs: number;
    log: (message: string) => void;
    onStats: (stats: JevPrefetchStats) => void;
  },
): Promise<string> {
  const started = Date.now() - (options.prepared?.elapsedMs ?? 0);
  const stats: JevPrefetchStats = {
    kind: 'jev-prefetch',
    version: options.prepared ? 4 : 3,
    ...(options.prepared
      ? {
          scope: options.prepared.scope,
          cacheHits: options.prepared.cacheHits,
          parsedFiles: options.prepared.parsedFiles,
          omittedFiles: options.prepared.omittedFiles,
        }
      : {}),
    mode: options.mode,
    model: options.mode === 'deterministic' ? null : JEV_MODEL,
    status: 'disabled',
    candidateFiles: 0,
    sampledFiles: 0,
    collectedCandidates: 0,
    scoredCandidates: 0,
    selectedCandidates: 0,
    baselineOverlap: 0,
    completeFileCandidates: 0,
    requestBytes: 0,
    contextBytes: 0,
    injectedBytes: 0,
    collectMs: 0,
    apiMs: 0,
    elapsedMs: 0,
  };
  let apiStarted: number | undefined;
  let signal: AbortSignal | undefined;
  try {
    if (options.mode === 'off') return '';
    stats.status = 'skipped';
    if (options.mode !== 'deterministic' && !options.apiKey) {
      stats.reason = 'missing-key';
      return '';
    }
    signal = AbortSignal.timeout(Math.max(0, Math.min(5000, Math.floor(options.timeoutMs))));
    const candidates: JevCandidate[] = options.prepared?.candidates ?? [];
    if (!options.prepared) {
      const eligible = entries.map((e) => ({
        ...e,
        callSites: e.callSites.filter((p) => SOURCE_FILE.test(p)),
      }));
      stats.candidateFiles = new Set(eligible.flatMap((e) => e.callSites)).size;
      const paths = new Set<string>();
      for (let i = 0; paths.size < MAX_FILES && eligible.some((e) => i < e.callSites.length); i++) {
        for (const e of eligible) {
          if (e.callSites[i]) paths.add(e.callSites[i]);
          if (paths.size === MAX_FILES) break;
        }
      }

      for (const path of paths) {
        signal.throwIfAborted();
        const source = await readTrackedSource(workspace, path, signal);
        if (!source?.text) continue;
        stats.sampledFiles++;
        const lines = source.text.split(/\r?\n/);
        const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
        const completeFile = !source.truncated && Buffer.byteLength(numbered) <= 2048;
        const symbols = eligible.filter((e) => e.callSites.includes(path)).map((e) => e.symbol);
        let hits = 0;
        for (let i = 0; i < lines.length && hits < 3; i++) {
          const symbol = symbols.find((s) =>
            new RegExp(`(?<![\\w$])${s.replace(/\$/g, '\\$')}(?![\\w$])`).test(lines[i]),
          );
          if (!symbol) continue;
          const start = Math.max(0, i - 12);
          candidates.push({
            symbol,
            path,
            line: i + 1,
            completeFile,
            text: completeFile
              ? numbered
              : formatSourceExcerpt(lines.slice(start, i + 13), start + 1, i + 1, 2048),
          });
          hits++;
        }
      }
    } else {
      stats.candidateFiles = new Set(candidates.map((c) => c.path)).size;
      stats.sampledFiles = stats.candidateFiles;
    }
    stats.collectedCandidates = candidates.length;
    stats.collectMs = Date.now() - started;
    const request = buildJevRequest(files, candidates, options.prepared?.task);
    if (!request.candidates.length) {
      stats.reason = 'no-candidates';
      return '';
    }
    signal.throwIfAborted();
    stats.candidateHash = createHash('sha256')
      .update(JSON.stringify(request.candidates))
      .digest('hex');
    let selected: number[];
    if (options.mode === 'deterministic') {
      selected = selectPrefetchCandidates(
        request.candidates,
        request.candidates.map((_, i) => i),
        candidates,
      );
      stats.estimatedCostUsd = 0;
    } else {
      stats.scoredCandidates = request.candidates.length;
      stats.requestBytes = Buffer.byteLength(request.body);
      stats.requestHash = createHash('sha256').update(request.body).digest('hex');
      apiStarted = Date.now();
      stats.collectMs = apiStarted - started;
      const response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: request.body,
      });
      stats.httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        stats.reason = 'http';
        return '';
      }
      const chunks: Uint8Array[] = [];
      let responseBytes = 0;
      for await (const chunk of response.body ?? []) {
        responseBytes += chunk.byteLength;
        if (responseBytes > 16_384) throw new Error('invalid-response');
        chunks.push(chunk);
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new Error('invalid-response');
      }
      const result = selectJevCandidates(value, request.candidates, candidates);
      stats.inputTokens = result.inputTokens;
      stats.outputTokens = result.outputTokens;
      stats.estimatedCostUsd = (result.inputTokens * 0.042) / 1_000_000;
      stats.selectedScores = result.scores;
      selected = result.selected;
    }
    stats.selectedHash = createHash('sha256')
      .update(JSON.stringify(selected.map((i) => request.candidates[i])))
      .digest('hex');
    stats.selectedCandidates = selected.length;
    stats.completeFileCandidates = selected.filter(
      (i) => request.candidates[i].completeFile,
    ).length;
    if (!selected.length) {
      stats.reason = 'no-relevant-candidates';
      return '';
    }
    stats.baselineOverlap = selected.filter((i) => i < selected.length).length;
    const block = formatJevPrefetch(
      selected.map((i) => request.candidates[i]),
      candidates.filter((c) => !selected.some((i) => request.candidates[i] === c)),
    );
    stats.contextBytes = Buffer.byteLength(block);
    stats.status = options.mode === 'shadow' ? 'shadow' : 'applied';
    stats.injectedBytes = options.mode === 'shadow' ? 0 : stats.contextBytes;
    return options.mode === 'shadow' ? '' : block;
  } catch (error) {
    stats.reason = signal?.aborted
      ? 'timeout'
      : error instanceof Error && error.message === 'invalid-response'
        ? 'invalid-response'
        : 'unavailable';
    return '';
  } finally {
    stats.elapsedMs = Date.now() - started;
    if (apiStarted === undefined && options.mode !== 'off') stats.collectMs = stats.elapsedMs;
    if (apiStarted !== undefined) stats.apiMs = Date.now() - apiStarted;
    if (
      stats.reason &&
      !['missing-key', 'no-candidates', 'no-relevant-candidates'].includes(stats.reason)
    )
      stats.status = 'fallback';
    options.log(`Jev prefetch: ${JSON.stringify(stats)}`);
    options.onStats(stats);
  }
}
