import {
  reviewReadLocations,
  suppliedOverlap,
  type SuppliedContext,
} from './review-read-locations.ts';

/** One opencode turn as `JBOT_TRANSCRIPT_DIR` writes it to `evidence-trace.jsonl`. */
export interface EvidenceTraceRow {
  label: string;
  sessionID: string;
  workspace: string;
  prompt: string;
  /** False when the turn's message listing was cut short, so earlier calls are missing. */
  complete: boolean;
  supplied?: {
    ranges: [string, [number, number][]][];
    lines: [string, number][];
    symbols: string[];
    directories: string[];
  };
  calls: {
    name: string;
    toolClass: string;
    input: Record<string, unknown>;
    status: string;
    output?: unknown;
  }[];
}

/**
 * supplied: the diff or pack already held it; repeat: lines this session already read;
 * new: lines it had not seen; unlocated: a search, listing or diff the parser cannot place.
 */
export type EvidenceCallClass = 'supplied' | 'repeat' | 'new' | 'unlocated';

export interface ClassifiedCall {
  label: string;
  sessionID: string;
  name: string;
  toolClass: string;
  input: Record<string, unknown>;
  class: EvidenceCallClass;
  /** A finding lands in the lines this call read. */
  cited: boolean;
  outputBytes: number;
}

// The read tool's default window; a whole-file cat is clamped the same way.
const READ_WINDOW = 2000;

export function classifyEvidenceTrace(
  rows: EvidenceTraceRow[],
  findings: { path: string; line: number }[],
): ClassifiedCall[] {
  const seen = new Map<string, Map<string, [number, number][]>>();
  const classified: ClassifiedCall[] = [];
  for (const row of rows) {
    const supplied: SuppliedContext | undefined = row.supplied && {
      ranges: new Map(row.supplied.ranges),
      lines: new Map(row.supplied.lines),
      symbols: new Set(row.supplied.symbols),
      directories: new Set(row.supplied.directories),
    };
    // Pages that share a label run in separate sessions, each with its own reads.
    const read = seen.get(row.sessionID) ?? new Map<string, [number, number][]>();
    seen.set(row.sessionID, read);
    for (const call of row.calls) {
      const locations = reviewReadLocations(row.workspace, call.name, call.input).map(
        (location) => ({
          ...location,
          endLine: Math.min(
            location.endLine,
            location.line + READ_WINDOW - 1,
            supplied?.lines.get(location.path) ?? Number.MAX_SAFE_INTEGER,
          ),
        }),
      );
      const repeat =
        locations.length > 0 &&
        locations.every(({ path, line, endLine }) => {
          const ranges = read.get(path) ?? [];
          let covered = 0;
          for (let n = line; n <= endLine; n++)
            if (ranges.some(([start, end]) => n >= start && n <= end)) covered++;
          return covered * 2 >= endLine - line + 1;
        });
      classified.push({
        label: row.label,
        sessionID: row.sessionID,
        name: call.name,
        toolClass: call.toolClass,
        input: call.input,
        class:
          supplied && suppliedOverlap(row.workspace, call.name, call.input, supplied)
            ? 'supplied'
            : !locations.length
              ? 'unlocated'
              : repeat
                ? 'repeat'
                : 'new',
        cited:
          call.status === 'completed' &&
          findings.some((finding) =>
            locations.some(
              ({ path, line, endLine }) =>
                finding.path === path && finding.line >= line && finding.line <= endLine,
            ),
          ),
        outputBytes: Buffer.byteLength(JSON.stringify(call.output) ?? ''),
      });
      if (call.status === 'completed')
        for (const { path, line, endLine } of locations)
          read.set(path, [...(read.get(path) ?? []), [line, endLine]]);
    }
  }
  return classified;
}
