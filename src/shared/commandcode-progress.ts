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

const TOOL_NAMES = ['jbot_read_file', 'jbot_search', 'jbot_list_files'];
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
  lastCompletedTool?: string;
  lastEventAgeMs?: number;
}

export function createCommandCodeProgress(now = Date.now) {
  const started = now();
  let buffer = '';
  let usage: PromptTokenUsage | undefined;
  let dropping = false;
  let observedEvents = 0;
  let droppedFrames = 0;
  let lastEventAt: number | undefined;
  let lastCompletedTool: string | undefined;
  const toolOutcomes: Record<string, number> = {};
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
    if (parsed.type === 'result') usage = parseCommandCodeUsage(parsed.usage) ?? usage;
    if (parsed.type !== 'event' || !isRecord(parsed.event)) return;
    if (parsed.event.type === 'run_end' && isRecord(parsed.event.result))
      usage = parseCommandCodeUsage(parsed.event.result.usage) ?? usage;
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
        ...(lastCompletedTool ? { lastCompletedTool } : {}),
        ...(lastEventAt !== undefined ? { lastEventAgeMs: now() - lastEventAt } : {}),
      };
    },
  };
}
