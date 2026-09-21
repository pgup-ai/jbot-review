import { createHash } from 'node:crypto';
import type { PromptTokenUsage } from './opencode.ts';
import { isFiniteNumber, isRecord } from './text.ts';

export function parseCommandCodeUsage(value: unknown): PromptTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const fields = [
    value.inputTokens,
    value.outputTokens,
    value.cacheReadTokens,
    value.cacheWriteTokens,
  ];
  if (!fields.every((field) => isFiniteNumber(field) && field >= 0)) return undefined;
  const [input, output, cacheRead, cacheWrite] = fields as number[];
  return { input, output, reasoning: 0, cacheRead, cacheWrite };
}

const TOOL_NAMES = ['read_file', 'grep', 'glob', 'shell_command', 'read_directory'];
const OUTCOMES = ['tool_completed', 'tool_errored', 'tool_denied', 'tool_hook_blocked'];

export function commandCodeToolOutcome(frame: unknown): string | undefined {
  if (!isRecord(frame) || !isRecord(frame.event)) return undefined;
  const event = frame.event;
  if (typeof event.type !== 'string' || !OUTCOMES.includes(event.type)) return undefined;
  const name =
    typeof event.toolName === 'string' && TOOL_NAMES.includes(event.toolName)
      ? event.toolName
      : 'other';
  return `${name}:${event.type}`;
}

export interface CommandCodeProgress {
  elapsedMs: number;
  complete: boolean;
  observedEvents: number;
  droppedFrames: number;
  toolOutcomes: Record<string, number>;
  observedToolActiveMs: number;
  maxConcurrentTools: number;
  repeatedToolCalls: number;
  stopReason?: string;
  lastCompletedTool?: string;
  lastEventAgeMs?: number;
}

export function createCommandCodeProgress(now = Date.now) {
  const started = now();
  let buffer = '';
  let usage: PromptTokenUsage | undefined;
  let stopReason: string | undefined;
  let dropping = false;
  let observedEvents = 0;
  let droppedFrames = 0;
  let lastEventAt: number | undefined;
  let lastCompletedTool: string | undefined;
  const toolOutcomes: Record<string, number> = {};
  const active = new Set<string>();
  const seen = new Set<string>();
  let activeSince = 0;
  let observedToolActiveMs = 0;
  let maxConcurrentTools = 0;
  let repeatedToolCalls = 0;
  const frame = (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      droppedFrames++;
      return;
    }
    if (!isRecord(parsed)) return;
    const result =
      parsed.type === 'result'
        ? parsed
        : isRecord(parsed.event) && parsed.event.type === 'run_end' && isRecord(parsed.event.result)
          ? parsed.event.result
          : undefined;
    if (result) {
      usage = parseCommandCodeUsage(result.usage) ?? usage;
      if (
        ['end_turn', 'permission_denied', 'max_turns', 'aborted', 'error'].includes(
          String(result.stopReason),
        )
      )
        stopReason = String(result.stopReason);
    }
    if (parsed.type !== 'event' || !isRecord(parsed.event)) return;
    const event = parsed.event;
    if (event.type === 'tool_queued' && TOOL_NAMES.includes(String(event.toolName))) {
      const digest = createHash('sha256')
        .update(JSON.stringify([event.toolName, event.input]))
        .digest('hex');
      if (seen.has(digest)) repeatedToolCalls++;
      else if (seen.size < 4096) seen.add(digest);
    }
    if (typeof event.toolCallId === 'string') {
      if (event.type === 'tool_running') {
        if (active.size === 0) activeSince = now();
        active.add(event.toolCallId);
        maxConcurrentTools = Math.max(maxConcurrentTools, active.size);
      } else if (
        OUTCOMES.includes(String(event.type)) &&
        active.delete(event.toolCallId) &&
        active.size === 0
      ) {
        observedToolActiveMs += now() - activeSince;
      }
    }
    observedEvents++;
    lastEventAt = now();
    const outcome = commandCodeToolOutcome(parsed);
    if (outcome) {
      toolOutcomes[outcome] = (toolOutcomes[outcome] ?? 0) + 1;
      if (parsed.event.type === 'tool_completed') lastCompletedTool = outcome.split(':')[0];
    }
  };
  return {
    feed(chunk: string) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf('\n', offset);
        const part = chunk.slice(offset, end < 0 ? undefined : end);
        if (!dropping) {
          if (buffer.length + part.length > 1_048_576) {
            buffer = '';
            dropping = true;
            droppedFrames++;
          } else buffer += part;
        }
        if (end < 0) break;
        if (!dropping) frame(buffer);
        buffer = '';
        dropping = false;
        offset = end + 1;
      }
    },
    finish() {
      if (!dropping) frame(buffer);
      buffer = '';
    },
    usage: () => usage,
    snapshot(complete = false): CommandCodeProgress {
      return {
        elapsedMs: now() - started,
        complete: complete && droppedFrames === 0,
        observedEvents,
        droppedFrames,
        toolOutcomes: { ...toolOutcomes },
        observedToolActiveMs: observedToolActiveMs + (active.size ? now() - activeSince : 0),
        maxConcurrentTools,
        repeatedToolCalls,
        ...(stopReason ? { stopReason } : {}),
        ...(lastCompletedTool ? { lastCompletedTool } : {}),
        ...(lastEventAt !== undefined ? { lastEventAgeMs: now() - lastEventAt } : {}),
      };
    },
  };
}

export function parseCommandCodeBenchmark(value: unknown) {
  if (!isRecord(value) || !isFiniteNumber(value.wallTimeMs) || !Array.isArray(value.turnDetails))
    return undefined;
  const turns = [];
  for (const turn of value.turnDetails) {
    if (
      !isRecord(turn) ||
      !isFiniteNumber(turn.apiDurationMs) ||
      !isFiniteNumber(turn.toolDurationMs) ||
      !Array.isArray(turn.toolCalls)
    )
      return undefined;
    turns.push({
      apiMs: turn.apiDurationMs,
      toolWorkMs: turn.toolDurationMs,
      toolCalls: turn.toolCalls.length,
    });
  }
  return { wallTimeMs: value.wallTimeMs, turns };
}
