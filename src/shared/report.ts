import type { Finding } from './types.ts';
import { formatFindingLocation, formatFindingMetadata } from './github.ts';

/**
 * Pure review-body layout helpers. `runner.ts` wires these into the posted
 * review body; kept here so the layout rules are unit-testable in isolation.
 * Grouping the findings by category is left to the model (in its summary),
 * not enforced in code.
 */

/** One-line entry: severity, kind/confidence, title, clickable location. */
function findingLine(finding: Finding): string {
  return `- **${finding.severity}${formatFindingMetadata(finding)}** ${finding.title} — \`${formatFindingLocation(finding)}\``;
}

/**
 * The "outside the diff" section: findings that could not be anchored inline,
 * listed flat with their full bodies (they are uncommon and self-contained).
 */
export function renderOrphanedSection(orphaned: Finding[]): string[] {
  if (orphaned.length === 0) return [];
  const lines = ['### Findings (outside the diff)', ''];
  for (const finding of orphaned) lines.push(findingLine(finding), `  ${finding.body}`);
  return lines;
}

/** Normalize a bullet for duplicate detection: drop marker, case, and spacing. */
function bulletKey(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** A line that is only a bold category header, e.g. `**Bugs**` or `**Bugs**:`. */
function isCategoryHeader(line: string): boolean {
  return /^\s*\*\*[^*]+\*\*:?\s*$/.test(line);
}

/**
 * Merge per-shard summaries into one block. Only bullet lines are deduped
 * (case/spacing insensitive); headers and prose pass through verbatim, so a
 * grouped summary's bold category headers are never collapsed across shards
 * (which would otherwise reattach the next shard's bullets under the wrong
 * header). A header left with no content beneath it after dedup (a duplicate
 * shard whose only bullets were already seen) is then dropped, and blank-line
 * runs are collapsed.
 */
export function condenseSummary(parts: string[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const part of parts) {
    for (const raw of part.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (line.trim() && /^\s*[-*+]\s+/.test(line)) {
        const key = bulletKey(line);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(line);
    }
  }

  // Drop category headers left empty by cross-shard dedup: a header whose next
  // non-blank line is another header (or the end) has nothing beneath it.
  const kept = merged.filter((line, i) => {
    if (!isCategoryHeader(line)) return true;
    let j = i + 1;
    while (j < merged.length && merged[j].trim() === '') j++;
    return j < merged.length && !isCategoryHeader(merged[j]);
  });

  // Collapse blank-line runs and trim.
  const out: string[] = [];
  for (const line of kept) {
    if (!line.trim()) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    } else {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
