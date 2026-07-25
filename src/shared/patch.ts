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

/** Trim, drop a leading diff marker, trim again — indentation and '+'/'-' must not block a match. */
function normalizeSnippetLine(text: string): string {
  const trimmed = text.trim();
  const unmarked = trimmed.startsWith('+') || trimmed.startsWith('-') ? trimmed.slice(1) : trimmed;
  return unmarked.trim();
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
  const matches: number[] = [];
  for (const { line, content } of addedLines(patch)) {
    if (content.trim().startsWith(needle)) matches.push(line);
  }
  return matches.length === 1 ? matches[0] : undefined;
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
  if (!patch) return undefined;
  const target = evidence.split('\n').map(normalizeSnippetLine);
  while (target[0] === '') target.shift();
  while (target.at(-1) === '') target.pop();
  if (target.length === 0) return undefined;

  const side = Array.from(newSideLines(patch), (l) => ({
    line: l.line,
    added: l.added,
    text: normalizeSnippetLine(l.content),
  }));
  let matches = 0;
  let anchor: number | undefined;
  for (let i = 0; i + target.length <= side.length; i += 1) {
    if (target.some((line, j) => side[i + j].text !== line)) continue;
    matches += 1;
    if (matches > 1) return undefined;
    anchor = side.slice(i, i + target.length).find((l) => l.added)?.line;
  }
  return anchor;
}
