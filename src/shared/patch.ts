/**
 * Minimal unified-diff parser. Returns the set of new-side line numbers that
 * were added in a file's patch and are therefore valid inline-comment anchors.
 * GitHub rejects an entire review (HTTP 422) if a comment targets a line that
 * is not part of the diff, so findings are validated against this set.
 */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseAddedLines(patch: string | undefined): Set<number> {
  const added = new Set<number>();
  if (!patch) return added;
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
      added.add(newLine);
      newLine += 1;
    } else if (marker === '-') {
      // Removed line: present only on the old side.
    } else if (marker === '\\') {
      // "\ No newline at end of file": annotates the preceding line, on neither side.
    } else {
      newLine += 1;
    }
  }
  return added;
}
