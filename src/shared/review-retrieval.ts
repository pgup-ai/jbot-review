import { reviewExperiment } from './review-experiment.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvidenceStore, JS_SOURCE } from './evidence.ts';
import { evidenceHash } from './evidence-cache.ts';
import {
  explorationCheckpoint,
  readEvidenceSession,
  selectReadEvidence,
} from './exploration-policy.ts';
import { reviewReadLocations } from './review-read-locations.ts';
import { EXPLORATION_CHECKPOINT } from './prompt.ts';
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
    hook(name: 'execute.after', fn: (event: ToolEvent) => void | Promise<void>): Promise<unknown>;
  };
  session: { hook(name: 'context', fn: (event: ContextEvent) => void): Promise<unknown> };
}

export async function installReviewRetrieval(
  ctx: PluginContext,
  workspace: string,
  statsDirectory: string,
  options: {
    checkpoints: boolean;
    readEvidence?: boolean | 'linked';
    readEvidencePhase?: 'all' | 'review' | 'verification';
  } = reviewExperiment().exploration,
  sessionLabel?: (sessionID: string) => string | undefined,
) {
  const store = new EvidenceStore(workspace, [], undefined, {
    shared: true,
    handoff: false,
    prefetch: false,
  });
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
      readEvidenceSession(options.readEvidencePhase ?? 'all', sessionLabel?.(event.sessionID)) &&
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
            const packet = {
              content: await store.prepare('verification', [], 'deterministic', {
                timeoutMs: 4000,
                locations: [ref],
                log: () => {},
                onStats: (row) => {
                  stats = row;
                },
                selectCandidates: (candidates) => {
                  const selected =
                    options.readEvidence === 'linked'
                      ? selectReadEvidence(candidates, ref.path, state.knownPaths)
                      : candidates;
                  state.stats.readEvidenceExcludedCandidates += candidates.length - selected.length;
                  return selected;
                },
                onSelection: (selected) => {
                  paths = selected.map((c) => c.path);
                },
              }),
              metadata: { jbotRetrieval: { selected: paths.length, paths } },
            };
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
            } else if (options.readEvidence === 'linked' && stats?.status === 'skipped')
              state.stats.readEvidenceEmptyPackets++;
            else state.stats.readEvidenceFallbacks++;
          } catch {
            state.stats.readEvidenceFallbacks++;
          } finally {
            state.stats.readEvidencePreparationMs += Date.now() - started;
          }
        };
        if (options.readEvidence === 'linked') {
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
    save(event.sessionID);
  });
}
