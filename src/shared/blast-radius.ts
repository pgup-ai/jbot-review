import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PrFile } from './github.ts';

/**
 * Deterministic blast-radius manifest: for each exported symbol this PR adds
 * or modifies, list the unchanged files that reference it. The flagship miss
 * pattern this targets is "changed code breaks an UNCHANGED caller" — a
 * flash-tier model rarely volunteers the grep, so the wrapper greps for it
 * and puts the call sites in front of the model.
 *
 * Everything here is best-effort: any failure yields an empty block, never a
 * failed review run.
 */
export const MAX_BLAST_SYMBOLS = 20;
export const MAX_CALLSITE_FILES_PER_SYMBOL = 8;

const execFileAsync = promisify(execFile);
const GIT_GREP_TIMEOUT_MS = 10_000;

/**
 * Pulls exported top-level symbol names from a patch's ADDED lines. Touching
 * an export's declaration line is the cheap, language-light signal that its
 * contract may have changed.
 */
const EXPORT_DECLARATION = new RegExp(
  String.raw`^\+\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?` +
    String.raw`(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)`,
);

export function extractChangedExportedSymbols(files: PrFile[]): string[] {
  const symbols = new Set<string>();
  for (const file of files) {
    if (!file.patch) continue;
    for (const line of file.patch.split('\n')) {
      const match = line.match(EXPORT_DECLARATION);
      if (match) symbols.add(match[1]);
    }
  }
  return [...symbols];
}

export type SymbolGrep = (workspace: string, symbol: string) => Promise<string[]>;

async function gitGrepFiles(workspace: string, symbol: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['grep', '-l', '-w', '--', symbol], {
      cwd: workspace,
      timeout: GIT_GREP_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return stdout.split('\n').filter(Boolean);
  } catch (error) {
    // git grep exits 1 on "no matches" — that is a result, not a failure.
    if (isExitCodeOne(error)) return [];
    throw error;
  }
}

function isExitCodeOne(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 1
  );
}

/**
 * Renders the '## Changed symbol usage' prompt section. Only symbols with at
 * least one reference OUTSIDE the changed files appear — those are exactly
 * the unchanged callers the coverage protocol tells the model to check.
 * Returns '' when there is nothing useful to say or on any failure.
 */
export async function buildBlastRadiusBlock(
  workspace: string,
  files: PrFile[],
  grep: SymbolGrep = gitGrepFiles,
): Promise<string> {
  try {
    const symbols = extractChangedExportedSymbols(files).slice(0, MAX_BLAST_SYMBOLS);
    if (symbols.length === 0) return '';

    const changed = new Set(files.map((file) => file.filename));
    // One grep per symbol, all in parallel: serial greps over a large
    // worktree would add minutes of wall time before the review starts.
    const callSiteLists = await Promise.all(
      symbols.map(async (symbol) => ({
        symbol,
        callSites: (await grep(workspace, symbol)).filter((file) => !changed.has(file)),
      })),
    );
    const entries: string[] = [];
    for (const { symbol, callSites } of callSiteLists) {
      if (callSites.length === 0) continue;
      const shown = callSites.slice(0, MAX_CALLSITE_FILES_PER_SYMBOL);
      const more =
        callSites.length > shown.length ? `, +${callSites.length - shown.length} more` : '';
      entries.push(`- \`${symbol}\` — referenced by unchanged: ${shown.join(', ')}${more}`);
    }
    if (entries.length === 0) return '';

    return [
      '## Changed symbol usage',
      'Exported symbols this PR adds or modifies, with UNCHANGED files that reference them.',
      'Check each listed call site: does it still hold after this change? (Coverage protocol step 2.)',
      ...entries,
    ].join('\n');
  } catch {
    return '';
  }
}
