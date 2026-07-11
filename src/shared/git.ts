import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PrFile } from './github.ts';

const execFileAsync = promisify(execFile);
const GIT_CONFIG_TIMEOUT_MS = 5_000;
const GIT_DIFF_TIMEOUT_MS = 60_000;
const GIT_DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/** Runs `git <args>` and returns stdout (empty string on a read miss). */
export type GitConfigCommand = (args: string[]) => Promise<string>;

/**
 * Marks `workspace` a safe git directory so git commands (including the ones
 * opencode runs itself inside bash) don't refuse with "dubious ownership" when
 * the checkout is owned by a different uid than the runner — the case in the
 * Docker action where `/github/workspace` is bind-mounted.
 *
 * The entry must be global because we can't inject `-c safe.directory` into the
 * git invocations opencode makes internally. To keep a long-lived (app-mode)
 * runner from appending a duplicate entry on every review, skip the write when
 * the path is already marked safe. Best-effort: a failure is logged, not
 * thrown, so a missing/locked git config never fails the run.
 */
export async function ensureGitSafeDirectory(
  workspace: string,
  log: (msg: string) => void,
  runGitConfig: GitConfigCommand = runGitConfigCommand,
): Promise<void> {
  const directory = workspace.trim();
  if (!directory) return;

  try {
    const existing = await runGitConfig(['config', '--global', '--get-all', 'safe.directory']);
    if (existing.split('\n').some((line) => line.trim() === directory)) return;

    await runGitConfig(['config', '--global', '--add', 'safe.directory', directory]);
    log(`Configured git safe.directory for ${directory}.`);
  } catch (error) {
    log(
      `Could not configure git safe.directory for ${directory}; git commands may fail: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function runGitConfigCommand(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: GIT_CONFIG_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return stdout;
  } catch (error) {
    // `git config --get-all` exits 1 when the key is unset — treat that read
    // miss as "no entries" so we fall through to the add. A failing `--add`
    // (or a genuinely broken git) still propagates to the caller's catch.
    if (args.includes('--get-all')) return '';
    throw error;
  }
}

/**
 * The exact `git` invocation for every diff the review pipeline reads (the
 * local driver's merge-base→worktree diff and the pi engine's git_diff tool),
 * exported so tests can run REAL git against hostile config. The `-c` pins
 * neutralize user gitconfig that changes the output shape parseGitDiff depends
 * on: `diff.noprefix`, `diff.mnemonicPrefix`, and (git ≥2.45)
 * `diff.srcPrefix`/`dstPrefix` all rewrite the `a/`/`b/` path prefixes;
 * `core.quotePath` escapes non-ASCII paths. `--no-ext-diff` and `--no-textconv`
 * keep hunks raw: GitHub's `patch` field applies neither an external diff
 * driver nor a `.gitattributes` textconv, so what the model reads must not
 * either. Older gits ignore unknown `-c` keys. Append a revspec (and nothing
 * else) to select the diff sides.
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
  '--no-textconv',
  '--find-renames',
  '--unified=3',
];

/**
 * Parses raw `git diff` output into GitHub-shaped per-file hunks. File headers
 * are removed so recovered patches use the same line-anchor format as the
 * REST `patch` field. Binary, mode-only, and pure-rename sections stay
 * patchless because they have no hunks to review or anchor.
 */
export function parseGitDiff(diffText: string): PrFile[] {
  const files: PrFile[] = [];
  let section: string[] | null = null;
  const flush = () => {
    if (section) files.push(parseDiffSection(section));
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

function parseDiffSection(lines: string[]): PrFile {
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
  const filename = renameTo || newPath || oldPath || pathFromDiffGitLine(lines[0]);

  if (hunkStart < 0) return { filename };
  const hunkLines = lines.slice(hunkStart);
  if (hunkLines[hunkLines.length - 1] === '') hunkLines.pop();
  return { filename, patch: hunkLines.join('\n') };
}

function stripPathPrefix(raw: string, prefix: 'a/' | 'b/'): string {
  let path = raw;
  if (path.endsWith('\t')) path = path.slice(0, -1);
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path === '/dev/null') return '';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function pathFromDiffGitLine(header: string): string {
  const rest = header.slice('diff --git '.length);
  const quoted = rest.lastIndexOf(' "b/');
  if (quoted >= 0) return rest.slice(quoted + 4).replace(/"$/, '');
  const plain = rest.lastIndexOf(' b/');
  return plain >= 0 ? rest.slice(plain + 3) : rest;
}

/**
 * GitHub can omit `patch` for large text diffs as well as non-hunk changes.
 * Recover only the missing entries from the checked-out three-dot diff while
 * preserving API patches verbatim for inline-anchor compatibility.
 */
export async function hydratePrFilePatches(
  files: PrFile[],
  options: {
    workspace: string;
    baseSha?: string;
    headSha?: string;
    runGitDiff?: (workspace: string, args: string[]) => Promise<string>;
  },
): Promise<{ files: PrFile[]; recovered: string[] }> {
  const missing = files.filter((file) => !file.patch);
  if (missing.length === 0) return { files, recovered: [] };
  if (!options.baseSha || !options.headSha) {
    throw new Error('Cannot recover GitHub-omitted patches without the PR base and head SHAs.');
  }

  const runGitDiff = options.runGitDiff ?? runGitDiffCommand;
  const diffText = await runGitDiff(options.workspace, [
    ...GIT_DIFF_ARGS,
    `${options.baseSha}...${options.headSha}`,
  ]);
  const checkoutFiles = new Map(parseGitDiff(diffText).map((file) => [file.filename, file]));
  const unmatched = missing.filter((file) => !checkoutFiles.has(file.filename));
  if (unmatched.length > 0) {
    const paths = unmatched.map((file) => file.filename);
    const listed = paths.slice(0, 10).join(', ');
    const remainder = paths.length > 10 ? `, and ${paths.length - 10} more file(s)` : '';
    throw new Error(
      `Checkout diff did not contain ${listed}${remainder}; refusing incomplete PR coverage.`,
    );
  }

  const recovered: string[] = [];
  const hydrated = files.map((file) => {
    if (file.patch) return file;
    const patch = checkoutFiles.get(file.filename)?.patch;
    if (!patch) return file;
    recovered.push(file.filename);
    return { ...file, patch };
  });
  return {
    files: hydrated,
    recovered,
  };
}

async function runGitDiffCommand(workspace: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
    timeout: GIT_DIFF_TIMEOUT_MS,
    maxBuffer: GIT_DIFF_MAX_BUFFER,
  });
  return stdout;
}
