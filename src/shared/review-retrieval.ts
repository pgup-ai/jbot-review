import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvidenceStore, JS_SOURCE } from './evidence.ts';
import { evidenceHash } from './evidence-cache.ts';
import { explorationCheckpoint, selectReadEvidence } from './exploration-policy.ts';
import { reviewReadLocations } from './review-read-locations.ts';
import {
  EXPLORATION_CHECKPOINT,
  REVIEW_RETRIEVAL_DESCRIPTION,
  REVIEW_RETRIEVAL_POLICY,
  REVIEW_RETRIEVAL_UNAVAILABLE,
} from './prompt.ts';
import type { JevPrefetchStats } from './jev-prefetch.ts';

interface ContextEvent {
  sessionID: string;
  agent: string;
  system: { type: string; text: string }[];
}
interface ToolEvent {
  sessionID: string;
  tool: string;
  status: string;
  agent?: string;
  input?: unknown;
  result?: { content?: unknown; metadata?: Record<string, unknown> };
}
interface PluginContext {
  tool: {
    transform(
      fn: (editor: { add(tool: ReturnType<typeof reviewRetrievalTool>): void }) => void,
    ): Promise<unknown>;
    hook(name: 'execute.after', fn: (event: ToolEvent) => void | Promise<void>): Promise<unknown>;
  };
  session: { hook(name: 'context', fn: (event: ContextEvent) => void): Promise<unknown> };
}

export function reviewRetrievalTool(workspace: string) {
  const store = new EvidenceStore(workspace, [], undefined, {
    shared: true,
    handoff: false,
    prefetch: false,
  });
  return {
    name: 'review_context',
    options: { codemode: false },
    description: REVIEW_RETRIEVAL_DESCRIPTION,
    input: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 512 },
        line: { type: 'integer', minimum: 1 },
      },
      required: ['path', 'line'],
      additionalProperties: false,
    },
    async execute(input: unknown) {
      const ref = input as { path?: unknown; line?: unknown } | null;
      if (
        !ref ||
        typeof ref.path !== 'string' ||
        ref.path.length > 512 ||
        !Number.isSafeInteger(ref.line) ||
        Number(ref.line) < 1
      )
        return { content: REVIEW_RETRIEVAL_UNAVAILABLE };
      let stats: JevPrefetchStats | undefined;
      let paths: string[] = [];
      const content = await store.prepare('verification', [], 'deterministic', {
        timeoutMs: 4000,
        locations: [{ path: ref.path, line: Number(ref.line) }],
        log: () => {},
        onStats: (row) => {
          stats = row;
        },
        onSelection: (selected) => {
          paths = selected.map((c) => c.path);
        },
      });
      return {
        content: content || REVIEW_RETRIEVAL_UNAVAILABLE,
        metadata: {
          jbotRetrieval: {
            selected: stats?.selectedCandidates ?? 0,
            candidates: stats?.collectedCandidates ?? 0,
            preparationMs: stats?.elapsedMs ?? 0,
            fallback: !content,
            paths,
          },
        },
      };
    },
  };
}

export async function installReviewRetrieval(
  ctx: PluginContext,
  workspace: string,
  statsDirectory: string,
  options: { retrieval: boolean; checkpoints: boolean; readEvidence?: boolean | 'linked' },
) {
  const tool = reviewRetrievalTool(workspace);
  const linkedStore =
    options.readEvidence === 'linked'
      ? new EvidenceStore(workspace, [], undefined, {
          shared: true,
          handoff: false,
          prefetch: false,
        })
      : undefined;
  if (options.retrieval) {
    await ctx.tool.transform((editor) => editor.add(tool));
  }
  const sessions = new Map<string, ReturnType<typeof newSession>>();
  function newSession() {
    return {
      progress: { requests: 0, outputBytes: 0, repeatedResults: 0 },
      previous: { requests: 0, outputBytes: 0, repeatedResults: 0 },
      seen: new Set<string>(),
      evidencePaths: new Set<string>(),
      knownPaths: new Set<string>(),
      deliveredPaths: new Map<string, number>(),
      preparation: Promise.resolve(),
      stats: {
        checkpoints: 0,
        turnCheckpoints: 0,
        byteCheckpoints: 0,
        repetitionCheckpoints: 0,
        retrievalCalls: 0,
        retrievalFallbacks: 0,
        selectedCandidates: 0,
        candidates: 0,
        preparationMs: 0,
        readEvidenceAttempts: 0,
        readEvidencePackets: 0,
        readEvidenceBytes: 0,
        readEvidenceFallbacks: 0,
        readEvidencePreparationMs: 0,
        readEvidenceDeliveredFiles: 0,
        readEvidenceObservedReads: 0,
        readEvidenceSubsequentReads: 0,
        readEvidenceUnclassifiedShellCalls: 0,
        readEvidenceExcludedCandidates: 0,
        readEvidenceEmptyPackets: 0,
      },
    };
  }
  const session = (id: string) => {
    let state = sessions.get(id);
    if (!state) {
      state = newSession();
      sessions.set(id, state);
    }
    return state;
  };
  const save = (id: string) => {
    try {
      writeFileSync(
        join(statsDirectory, `exploration-${evidenceHash(id)}.json`),
        JSON.stringify(session(id).stats),
        { mode: 0o600 },
      );
    } catch {
      /* Telemetry must not interrupt the review. */
    }
  };
  await ctx.session.hook('context', (event) => {
    if (event.agent === 'jbot-wrapup' || event.agent === 'jbot-plain') return;
    if (options.retrieval) event.system.push({ type: 'text', text: REVIEW_RETRIEVAL_POLICY });
    const state = session(event.sessionID);
    state.progress.requests++;
    const reason = options.checkpoints
      ? explorationCheckpoint(state.progress, state.previous)
      : undefined;
    if (!reason) {
      if (state.progress.requests === 1) save(event.sessionID);
      return;
    }
    event.system.push({ type: 'text', text: EXPLORATION_CHECKPOINT });
    state.previous = { ...state.progress };
    state.stats.checkpoints++;
    if (reason === 'turns') state.stats.turnCheckpoints++;
    if (reason === 'bytes') state.stats.byteCheckpoints++;
    if (reason === 'repetition') state.stats.repetitionCheckpoints++;
    save(event.sessionID);
  });
  await ctx.tool.hook('execute.after', async (event) => {
    const state = session(event.sessionID);
    const reads =
      event.status === 'completed' && event.input && typeof event.input === 'object'
        ? reviewReadLocations(workspace, event.tool, event.input as Record<string, unknown>)
        : [];
    for (const ref of reads) {
      state.stats.readEvidenceObservedReads++;
      const deliveredTurn = state.deliveredPaths.get(ref.path);
      if (deliveredTurn !== undefined && deliveredTurn < state.progress.requests)
        state.stats.readEvidenceSubsequentReads++;
      if (state.knownPaths.size < 256) state.knownPaths.add(ref.path);
    }
    if (
      event.status === 'completed' &&
      ['shell', 'bash', 'execute', 'exec'].includes(event.tool) &&
      !reads.length
    )
      state.stats.readEvidenceUnclassifiedShellCalls++;
    if (
      options.readEvidence &&
      event.status === 'completed' &&
      event.result &&
      event.agent !== 'jbot-wrapup' &&
      event.agent !== 'jbot-plain' &&
      state.stats.readEvidenceAttempts < 2 &&
      event.input &&
      typeof event.input === 'object' &&
      (typeof event.result.content === 'string' || Array.isArray(event.result.content))
    ) {
      const ref = reads.find((r) => JS_SOURCE.test(r.path) && !state.evidencePaths.has(r.path));
      if (ref) {
        const originalResult = event.result;
        const originalContent = event.result.content;
        // Reserve before awaiting so parallel reads cannot exceed the session budget.
        state.evidencePaths.add(ref.path);
        state.stats.readEvidenceAttempts++;
        const prepare = async () => {
          const started = Date.now();
          try {
            let paths: string[] = [];
            let stats: JevPrefetchStats | undefined;
            const packet = linkedStore
              ? {
                  content: await linkedStore.prepare('verification', [], 'deterministic', {
                    timeoutMs: 4000,
                    locations: [ref],
                    log: () => {},
                    onStats: (row) => {
                      stats = row;
                    },
                    selectCandidates: (candidates) => {
                      const selected = selectReadEvidence(candidates, ref.path, state.knownPaths);
                      state.stats.readEvidenceExcludedCandidates +=
                        candidates.length - selected.length;
                      return selected;
                    },
                    onSelection: (selected) => {
                      paths = selected.map((c) => c.path);
                    },
                  }),
                  metadata: { jbotRetrieval: { selected: paths.length, paths } },
                }
              : await tool.execute(ref);
            const text = '\n\n' + packet.content;
            const bytes = Buffer.byteLength(text);
            if (packet.metadata?.jbotRetrieval.selected && bytes <= 7000) {
              event.result = {
                ...originalResult,
                content:
                  typeof originalContent === 'string'
                    ? originalContent + text
                    : [...originalContent, { type: 'text', text }],
              };
              state.stats.readEvidencePackets++;
              state.stats.readEvidenceBytes += bytes;
              for (const path of packet.metadata.jbotRetrieval.paths) {
                state.deliveredPaths.set(path, state.progress.requests);
                state.knownPaths.add(path);
              }
              state.stats.readEvidenceDeliveredFiles = state.deliveredPaths.size;
            } else if (linkedStore && stats?.status === 'skipped')
              state.stats.readEvidenceEmptyPackets++;
            else state.stats.readEvidenceFallbacks++;
          } catch {
            state.stats.readEvidenceFallbacks++;
          } finally {
            state.stats.readEvidencePreparationMs += Date.now() - started;
          }
        };
        if (linkedStore) {
          // Serialize augmentation so parallel reads cannot deliver the same dependency twice.
          state.preparation = state.preparation.then(prepare);
          await state.preparation;
        } else await prepare();
      }
    }
    if (event.status === 'completed') {
      const content = JSON.stringify(event.result?.content) ?? '';
      state.progress.outputBytes += Buffer.byteLength(content);
      const digest = evidenceHash(content);
      if (state.seen.has(digest)) state.progress.repeatedResults++;
      if (state.seen.size < 4096) state.seen.add(digest);
    }
    if (event.tool === 'review_context') {
      state.stats.retrievalCalls++;
      const result = event.result?.metadata?.jbotRetrieval as
        | { selected: number; candidates: number; preparationMs: number; fallback: boolean }
        | undefined;
      if (result) {
        state.stats.selectedCandidates += result.selected;
        state.stats.candidates += result.candidates;
        state.stats.preparationMs += result.preparationMs;
      }
      if (!result || result.fallback) state.stats.retrievalFallbacks++;
    }
    save(event.sessionID);
  });
}
