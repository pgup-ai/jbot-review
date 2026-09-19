import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvidenceStore } from './evidence.ts';
import { evidenceHash } from './evidence-cache.ts';
import { explorationCheckpoint } from './exploration-policy.ts';
import {
  EXPLORATION_CHECKPOINT,
  REVIEW_RETRIEVAL_DESCRIPTION,
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
  result?: { content?: unknown; metadata?: Record<string, unknown> };
}
interface PluginContext {
  tool: {
    transform(
      fn: (editor: { add(tool: ReturnType<typeof reviewRetrievalTool>): void }) => void,
    ): Promise<unknown>;
    hook(name: 'execute.after', fn: (event: ToolEvent) => void): Promise<unknown>;
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
      const content = await store.prepare('verification', [], 'deterministic', {
        timeoutMs: 4000,
        locations: [{ path: ref.path, line: Number(ref.line) }],
        log: () => {},
        onStats: (row) => {
          stats = row;
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
  options: { retrieval: boolean; checkpoints: boolean },
) {
  if (options.retrieval) {
    const tool = reviewRetrievalTool(workspace);
    await ctx.tool.transform((editor) => editor.add(tool));
  }
  const sessions = new Map<string, ReturnType<typeof newSession>>();
  function newSession() {
    return {
      progress: { requests: 0, outputBytes: 0, repeatedResults: 0 },
      previous: { requests: 0, outputBytes: 0, repeatedResults: 0 },
      seen: new Set<string>(),
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
  await ctx.tool.hook('execute.after', (event) => {
    const state = session(event.sessionID);
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
