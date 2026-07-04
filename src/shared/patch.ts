/**
 * Minimal unified-diff parser. Returns the set of new-side line numbers that
 * were added in a file's patch and are therefore valid inline-comment anchors.
 * GitHub rejects an entire review (HTTP 422) if a comment targets a line that
 * is not part of the diff, so findings are validated against this set.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Walks a patch, yielding each ADDED line's new-side number and content (sans '+'). */
function* addedLines(patch: string): Generator<{ line: number; content: string }> {
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
    if (marker === '+') {
      yield { line: newLine, content: raw.slice(1) };
      newLine += 1;
    } else if (marker === '-') {
      // Removed line: present only on the old side.
    } else if (marker === '\\') {
      // "\ No newline at end of file": annotates the preceding line, on neither side.
    } else {
      newLine += 1;
    }
  }
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
 * The match is whole-line (trimmed) equality, not substring: the prompt asks
 * the model to quote the changed line exactly, and a substring like
 * `return true` would otherwise re-anchor onto an unrelated `if (x) return true;`.
 */
export function rescueAnchorByEvidence(
  patch: string | undefined,
  evidence: string,
): number | undefined {
  const needle = evidence.trim();
  if (!patch || !needle) return undefined;
  const matches: number[] = [];
  for (const { line, content } of addedLines(patch)) {
    if (content.trim() === needle) matches.push(line);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
