/**
 * Minimal unified-diff parser. Returns the set of new-side line numbers that
 * were added in a file's patch and are therefore valid inline-comment anchors.
 * GitHub rejects an entire review (HTTP 422) if a comment targets a line that
 * is not part of the diff, so findings are validated against this set.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Walks a patch, yielding every NEW-side line (added or context) with its number. */
function* newSideLines(
  patch: string,
): Generator<{ line: number; content: string; added: boolean }> {
  let newLine = 0;
  let insideHunk = false;
  for (const raw of patch.split('\n')) {
    const header = raw.match(HUNK_HEADER);
    if (header) {
      newLine = Number(header[1]);
      insideHunk = true;
      continue;
    }
    if (!insideHunk) continue;
    const marker = raw[0];
    // Removed lines are old-side only; "\ No newline at end of file" annotates
    // the preceding line and is on neither side.
    if (marker === '-' || marker === '\\') continue;
    yield { line: newLine, content: raw.slice(1), added: marker === '+' };
    newLine += 1;
  }
}

/** Walks a patch, yielding each ADDED line's new-side number and content (sans '+'). */
function* addedLines(patch: string): Generator<{ line: number; content: string }> {
  for (const side of newSideLines(patch)) if (side.added) yield side;
}

/**
 * Drops a leading diff marker the model may have copied along with the line.
 * Applied to a QUOTE only, never to patch content — `newSideLines` already
 * removed the real marker, so stripping again would eat a genuine leading
 * '+'/'-' from source (`-1`, `--verbose`, a markdown bullet) and let two
 * different lines collapse to the same text.
 */
function stripQuotedMarker(line: string): string {
  return line.startsWith('+') || line.startsWith('-') ? line.slice(1).trim() : line;
}

export function parseAddedLines(patch: string | undefined): Set<number> {
  const added = new Set<number>();
  if (patch) for (const { line } of addedLines(patch)) added.add(line);
  return added;
}

/**
 * Orphan rescue: the new-side number of the added line containing a finding's
 * verbatim `evidence` quote. Undefined unless EXACTLY one line matches — an
 * absent or ambiguous quote must leave the finding orphaned, not mis-anchored.
 *
 * The match is a line-PREFIX (trimmed), not a free substring: the model quotes
 * the line from its start, and the quote may be truncated to the evidence cap
 * on a long line — so a prefix matches both the whole line and a truncated
 * one, while still rejecting a mid-line substring like `order.subtotal` inside
 * `return order.subtotal;` that a plain `includes` would wrongly re-anchor.
 */
export function rescueAnchorByEvidence(
  patch: string | undefined,
  evidence: string,
): number | undefined {
  const needle = evidence.trim();
  if (!patch || !needle) return undefined;
  // Ambiguity fails closed: only a quote that matched nothing as written is
  // retried on the assumption its leading '+'/'-' was a marker.
  const asWritten = prefixMatches(patch, needle);
  const found = asWritten.length > 0 ? asWritten : prefixMatches(patch, stripQuotedMarker(needle));
  return found.length === 1 ? found[0] : undefined;
}

function prefixMatches(patch: string, needle: string): number[] {
  if (!needle) return [];
  const matches: number[] = [];
  for (const { line, content } of addedLines(patch)) {
    if (content.trim().startsWith(needle)) matches.push(line);
  }
  return matches;
}

/**
 * New-side line to anchor a finding whose `evidence` quotes one or more
 * consecutive lines of the file. The matched window may span context lines —
 * that is what makes a short quote unique — but the anchor is the first ADDED
 * line inside it, because GitHub only accepts comments on lines this PR added.
 *
 * Undefined unless EXACTLY one window matches: an ambiguous quote must leave
 * the finding orphaned rather than mis-anchored. Blank lines are trimmed off
 * the quote's ends only; internally the run must be genuinely consecutive, so
 * "consecutive" keeps meaning what it says and the anchor stays unambiguous.
 */
export function anchorByEvidenceSnippet(
  patch: string | undefined,
  evidence: string,
): number | undefined {
  const window = evidenceWindow(patch, evidence);
  return typeof window === 'object' ? window.anchor : undefined;
}

export interface EvidenceWindow {
  /** First ADDED line in the window; undefined when the match is context-only. */
  anchor: number | undefined;
  /** New-side span of the matched run, context lines included. */
  start: number;
  end: number;
}

/**
 * The unique window `anchorByEvidenceSnippet` matches, with its new-side span.
 * The span lets a caller distinguish "the quote corroborates this claimed
 * line" (line inside the window) from "the quote lives elsewhere".
 * 'ambiguous' is distinct from undefined (no match) so a caller can refuse
 * weaker fallbacks: a context+added duplicate matches the window twice but the
 * added-lines-only prefix rescue once, and that rescue must not win.
 */
export function evidenceWindow(
  patch: string | undefined,
  evidence: string,
): EvidenceWindow | 'ambiguous' | undefined {
  if (!patch) return undefined;
  const target = evidence.split('\n').map((line) => line.trim());
  while (target[0] === '') target.shift();
  while (target.at(-1) === '') target.pop();
  if (target.length === 0) return undefined;

  const side = Array.from(newSideLines(patch), (l) => ({
    line: l.line,
    added: l.added,
    text: l.content.trim(),
  }));
  // Source that legitimately starts with '+'/'-' is indistinguishable from a
  // copied diff marker, so the quote is tried as written first. Only a quote
  // that matched NOTHING is retried stripped: retrying an AMBIGUOUS one would
  // let a second reading of it anchor somewhere the quote itself never pointed.
  const asWritten = matchWindow(side, target);
  const result =
    asWritten.matches > 0 ? asWritten : matchWindow(side, target.map(stripQuotedMarker));
  if (result.matches > 1) return 'ambiguous';
  return result.matches === 1
    ? { anchor: result.anchor, start: result.start, end: result.end }
    : undefined;
}

/** `matches` separates "no match" from "ambiguous"; only exactly one yields a window. */
function matchWindow(
  side: { line: number; added: boolean; text: string }[],
  target: string[],
): { matches: number; anchor: number | undefined; start: number; end: number } {
  let matches = 0;
  let anchor: number | undefined;
  let start = 0;
  let end = 0;
  for (let i = 0; i + target.length <= side.length; i += 1) {
    const mismatched = target.some(
      (line, j) =>
        side[i + j].text !== line ||
        // Hunks are yielded back to back, so neighbours in `side` can straddle a
        // hunk boundary and be far apart in the file — not a consecutive run.
        (j > 0 && side[i + j].line !== side[i + j - 1].line + 1),
    );
    if (mismatched) continue;
    matches += 1;
    if (matches > 1) return { matches, anchor: undefined, start: 0, end: 0 };
    anchor = side.slice(i, i + target.length).find((l) => l.added)?.line;
    start = side[i].line;
    end = side[i + target.length - 1].line;
  }
  return { matches, anchor, start, end };
}
