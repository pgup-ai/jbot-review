import type { PrFile } from '../shared/github.ts';

/**
 * Parses raw `git diff` output into the `PrFile[]` shape the review pipeline
 * consumes (`{ filename, patch? }`, see github.ts).
 *
 * GitHub-patch equivalence (invariant #7): GitHub's REST `patch` field — the
 * text inline-comment anchors are validated against (`parseAddedLines`) — is
 * the hunk text from the first `@@` onward, with no `diff --git`/index/
 * `---`/`+++` file headers. This parser reproduces exactly that: sections are
 * split on `diff --git `, headers are dropped, hunks are kept verbatim
 * (including `\ No newline at end of file` markers, which GitHub keeps too).
 * Binary and mode-only sections have no hunks → `patch: undefined`, matching
 * GitHub omitting `patch` for binaries; the runner already drops patchless
 * files before review.
 *
 * Diff sides (local mode only): the LEFT side must be the merge-base of the
 * branch and its target — the same left side as GitHub's three-dot
 * `base...head`. The RIGHT side is the WORKING TREE, not HEAD: the review
 * sessions, guideline discovery, and blast-radius all read the checkout, so
 * diffing to HEAD under a dirty tree would show the model a diff that
 * disagrees with the files on disk. Local anchors are never posted to
 * GitHub, so worktree-relative line numbers are safe; on a clean tree this
 * is byte-identical to `merge-base...HEAD`.
 */
/**
 * The exact `git` invocation the local driver uses (exported so tests can run
 * REAL git against hostile config). The `-c` pins neutralize user gitconfig
 * that changes the output shape this parser depends on: `diff.noprefix`,
 * `diff.mnemonicPrefix`, and (git ≥2.45) `diff.srcPrefix`/`dstPrefix` all
 * rewrite the `a/`/`b/` path prefixes; `core.quotePath` escapes non-ASCII
 * paths; external diff/textconv replace hunks entirely. Older gits ignore
 * unknown `-c` keys. Append the merge-base SHA (and nothing else) for the
 * merge-base→worktree diff.
 */
export const GIT_DIFF_ARGS = [
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  '-c',
  'diff.srcPrefix=a/',
  '-c',
  'diff.dstPrefix=b/',
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--find-renames',
  '--unified=3',
];

export function parseGitDiff(diffText: string): PrFile[] {
  const files: PrFile[] = [];
  let section: string[] | null = null;
  const flush = () => {
    if (section) files.push(parseSection(section));
    section = null;
  };
  for (const line of diffText.split('\n')) {
    // Hunk content lines always carry a +/-/space/\ prefix, so a bare
    // `diff --git ` at column 0 can only start a new file section.
    if (line.startsWith('diff --git ')) {
      flush();
      section = [line];
    } else if (section) {
      section.push(line);
    }
  }
  flush();
  return files;
}

function parseSection(lines: string[]): PrFile {
  let renameTo = '';
  let newPath = '';
  let oldPath = '';
  let hunkStart = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@ ')) {
      hunkStart = i;
      break;
    }
    if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
    else if (line.startsWith('+++ ')) newPath = stripPathPrefix(line.slice(4), 'b/');
    else if (line.startsWith('--- ')) oldPath = stripPathPrefix(line.slice(4), 'a/');
  }
  // New-side path wins; deletions (`+++ /dev/null`) keep the old path, which
  // is how GitHub lists deleted files. Header-less sections (mode-only,
  // binary) fall back to the `diff --git` line itself.
  const filename = renameTo || newPath || oldPath || pathFromDiffGitLine(lines[0]);

  if (hunkStart < 0) return { filename };
  const hunkLines = lines.slice(hunkStart);
  // git diff output ends with a newline; drop the one empty trailer it leaves.
  if (hunkLines[hunkLines.length - 1] === '') hunkLines.pop();
  return { filename, patch: hunkLines.join('\n') };
}

function stripPathPrefix(raw: string, prefix: 'a/' | 'b/'): string {
  let path = raw;
  if (path.endsWith('\t')) path = path.slice(0, -1);
  // core.quotePath=false leaves quoting only for control chars/quotes in the
  // name; strip the surrounding quotes best-effort.
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path === '/dev/null') return '';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

// "diff --git a/<path> b/<path>" — last resort when no ---/+++/rename header
// names the file (mode-only, binary). Ambiguous for paths containing " b/",
// but any section with hunks also carries ---/+++ headers, so those never
// reach this heuristic.
function pathFromDiffGitLine(header: string): string {
  const rest = header.slice('diff --git '.length);
  const quoted = rest.lastIndexOf(' "b/');
  if (quoted >= 0) return rest.slice(quoted + 4).replace(/"$/, '');
  const plain = rest.lastIndexOf(' b/');
  return plain >= 0 ? rest.slice(plain + 3) : rest;
}
