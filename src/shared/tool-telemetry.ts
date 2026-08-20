import { createHmac } from 'node:crypto';

import type {
  BackendTelemetryCapability,
  ExplorationBudgetTier,
  ExplorationMode,
  ExplorationTelemetryRow,
  TelemetryRecorder,
  TelemetryStopReason,
  ToolTelemetryClass,
} from './telemetry.ts';

export const MAX_TOOL_TELEMETRY_ROWS = 2_048;
export const MAX_TOOL_IDENTITIES = 4_096;

export interface ToolTelemetryStart {
  session: string;
  backend: string;
  capability: BackendTelemetryCapability;
  toolClass: ToolTelemetryClass;
  inputBytes: number;
  identity?: string;
  identityKind?: 'path' | 'query' | 'scope';
  diffScope?: 'whole' | 'path';
}

export interface ToolTelemetryFinish {
  success: boolean;
  outputBytesBeforeCap: number;
  outputBytesAfterCap: number;
  failureClass?: 'denied' | 'timeout' | 'execution' | 'invalid-input' | 'unknown';
  durationMs?: number;
}

export interface ExplorationTelemetryFinish {
  session: string;
  backend: string;
  capability: BackendTelemetryCapability;
  budgetTier: ExplorationBudgetTier;
  stopReason: TelemetryStopReason;
  turnCount?: number;
  explorationMode?: ExplorationMode;
}

export interface ToolTelemetryAccumulator {
  startTool(input: ToolTelemetryStart): (finish: ToolTelemetryFinish) => void;
  finishSession(input: ExplorationTelemetryFinish): void;
}

interface SessionCounters {
  toolCalls: number;
  toolInputBytes: number;
  toolOutputBytes: number;
  uniquePathHashes: Set<string>;
  uniqueQueryHashes: Set<string>;
  duplicateReads: number;
  repeatedSearches: number;
  droppedToolRows: number;
  classes: Set<ToolTelemetryClass>;
}

const EMPTY: ToolTelemetryAccumulator = {
  startTool: () => () => undefined,
  finishSession: () => undefined,
};

export function createToolTelemetryAccumulator(
  recorder: TelemetryRecorder,
  salt: string,
  now: () => number = Date.now,
): ToolTelemetryAccumulator {
  if (!recorder.enabled) return EMPTY;

  const sessions = new Map<string, SessionCounters>();
  const seen = new Set<string>();
  let rows = 0;

  const countersFor = (backend: string, session: string): SessionCounters => {
    const key = `${backend}\0${session}`;
    let counters = sessions.get(key);
    if (!counters) {
      counters = {
        toolCalls: 0,
        toolInputBytes: 0,
        toolOutputBytes: 0,
        uniquePathHashes: new Set(),
        uniqueQueryHashes: new Set(),
        duplicateReads: 0,
        repeatedSearches: 0,
        droppedToolRows: 0,
        classes: new Set(),
      };
      sessions.set(key, counters);
    }
    return counters;
  };

  return {
    startTool(input) {
      const startedAt = now();
      const counters = countersFor(input.backend, input.session);
      const normalized = input.identity
        ? normalizeIdentity(input.identity, input.identityKind)
        : '';
      const hash = normalized
        ? createHmac('sha256', salt).update(`${input.toolClass}\0${normalized}`).digest('hex')
        : undefined;
      const duplicate = hash ? seen.has(hash) : false;
      if (hash && seen.size < MAX_TOOL_IDENTITIES) seen.add(hash);
      if (
        hash &&
        input.identityKind === 'path' &&
        counters.uniquePathHashes.size < MAX_TOOL_IDENTITIES
      ) {
        counters.uniquePathHashes.add(hash);
      }
      if (
        hash &&
        input.identityKind === 'query' &&
        counters.uniqueQueryHashes.size < MAX_TOOL_IDENTITIES
      ) {
        counters.uniqueQueryHashes.add(hash);
      }

      let finished = false;
      return (finish) => {
        if (finished) return;
        finished = true;
        counters.toolCalls += 1;
        counters.toolInputBytes += boundedCount(input.inputBytes);
        counters.toolOutputBytes += boundedCount(finish.outputBytesAfterCap);
        counters.classes.add(input.toolClass);
        if (duplicate && input.toolClass === 'file-read') counters.duplicateReads += 1;
        if (duplicate && input.toolClass === 'search') counters.repeatedSearches += 1;
        if (rows >= MAX_TOOL_TELEMETRY_ROWS) {
          counters.droppedToolRows += 1;
          return;
        }
        rows += 1;
        recorder.recordTool({
          kind: 'tool',
          session: input.session,
          backend: input.backend,
          toolClass: input.toolClass,
          capability: input.capability,
          durationMs: finish.durationMs ?? Math.max(now() - startedAt, 0),
          inputBytes: boundedCount(input.inputBytes),
          outputBytesBeforeCap: boundedCount(finish.outputBytesBeforeCap),
          outputBytesAfterCap: boundedCount(finish.outputBytesAfterCap),
          duplicate,
          success: finish.success,
          ...(finish.failureClass ? { failureClass: finish.failureClass } : {}),
          ...(input.diffScope ? { diffScope: input.diffScope } : {}),
        });
      };
    },
    finishSession(input) {
      const counters = countersFor(input.backend, input.session);
      const row: ExplorationTelemetryRow = {
        kind: 'exploration',
        session: input.session,
        backend: input.backend,
        capability: input.capability,
        explorationMode: input.explorationMode ?? deriveExplorationMode(counters.classes),
        budgetTier: input.budgetTier,
        stopReason: input.stopReason,
        turnCountAvailable: input.turnCount !== undefined,
        ...(input.turnCount !== undefined ? { turnCount: boundedCount(input.turnCount) } : {}),
        toolCalls: counters.toolCalls,
        toolInputBytes: counters.toolInputBytes,
        toolOutputBytes: counters.toolOutputBytes,
        uniquePathHashes: counters.uniquePathHashes.size,
        uniqueQueryHashes: counters.uniqueQueryHashes.size,
        duplicateReads: counters.duplicateReads,
        repeatedSearches: counters.repeatedSearches,
        droppedToolRows: counters.droppedToolRows,
      };
      recorder.recordExploration(row);
    },
  };
}

export function classifyReadonlyTool(name: string): ToolTelemetryClass {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
  if (normalized === 'git_diff' || normalized.includes('diff')) return 'diff-recovery';
  if (normalized.includes('read')) return 'file-read';
  if (normalized.includes('grep') || normalized.includes('search') || normalized === 'find') {
    return 'search';
  }
  if (normalized.includes('glob') || normalized.includes('list') || normalized.includes('tree')) {
    return 'list';
  }
  if (
    normalized.includes('web') ||
    normalized.includes('context7') ||
    normalized.includes('docs')
  ) {
    return 'external-docs';
  }
  return 'other-readonly';
}

export function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

export function toolIdentity(
  toolClass: ToolTelemetryClass,
  input: unknown,
): { identity?: string; identityKind?: 'path' | 'query' | 'scope' } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return toolClass === 'diff-recovery' ? { identity: 'whole-diff', identityKind: 'scope' } : {};
  }
  const value = input as Record<string, unknown>;
  const firstString = (...keys: string[]): string | undefined => {
    for (const key of keys) if (typeof value[key] === 'string') return value[key].trim();
    return undefined;
  };
  if (toolClass === 'file-read' || toolClass === 'list' || toolClass === 'diff-recovery') {
    const path = firstString('path', 'file', 'filePath', 'directory');
    return path
      ? { identity: path, identityKind: 'path' }
      : toolClass === 'diff-recovery'
        ? { identity: 'whole-diff', identityKind: 'scope' }
        : {};
  }
  if (toolClass === 'search' || toolClass === 'external-docs') {
    const query = firstString('query', 'pattern', 'search', 'text');
    return query ? { identity: query, identityKind: 'query' } : {};
  }
  return {};
}

function normalizeIdentity(value: string, kind: 'path' | 'query' | 'scope' | undefined): string {
  const compact = value.trim().replaceAll(/\s+/g, ' ');
  return kind === 'path' ? compact.replace(/^\.\//, '').replaceAll(/\/{2,}/g, '/') : compact;
}

function deriveExplorationMode(classes: Set<ToolTelemetryClass>): ExplorationMode {
  if (classes.size === 0) return 'embedded-only';
  const diff = classes.has('diff-recovery');
  const adjacent = [...classes].some((toolClass) => toolClass !== 'diff-recovery');
  return diff && adjacent ? 'mixed' : diff ? 'diff-recovery' : 'adjacent-context';
}

function boundedCount(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}
