import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { PrFile } from './github.ts';
import { formatBlastRadiusContext } from './prompt.ts';

// Preload unchanged callers because smaller models may not investigate them unaided.
export const MAX_BLAST_SYMBOLS = 20;
export const MAX_CALLSITE_FILES_PER_SYMBOL = 8;

const execFileAsync = promisify(execFile);
const GIT_GREP_TIMEOUT_MS = 10_000;

const EXPORT_DECLARATION =
  /^[+-]\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const NAMED_EXPORT_START = /^\s*export\s+(?:type\s+)?\{/;

export function extractChangedExportedSymbols(files: PrFile[]): string[] {
  const symbols = new Set<string>();
  for (const file of files) {
    if (!file.patch) continue;
    const blocks: Partial<Record<'+' | '-', { text: string; changed: boolean }>> = {};
    for (const line of file.patch.split('\n')) {
      if (line.startsWith('@@')) {
        delete blocks['+'];
        delete blocks['-'];
        continue;
      }
      const declaration = line.match(EXPORT_DECLARATION);
      if (declaration) symbols.add(declaration[1]);
      for (const side of ['+', '-'] as const) {
        if (line[0] !== side && line[0] !== ' ') continue;
        const text = line.slice(1);
        const start = text.match(NAMED_EXPORT_START);
        const block = start
          ? { text: text.slice(start[0].length), changed: line[0] === side }
          : blocks[side];
        if (!block) continue;
        if (!start) {
          block.text += '\n' + text;
          block.changed ||= line[0] === side;
        }
        const end = block.text.indexOf('}');
        if (end < 0) blocks[side] = block;
        else {
          if (block.changed)
            for (const symbol of exportedNamesFromList(block.text.slice(0, end)))
              symbols.add(symbol);
          delete blocks[side];
        }
      }
    }
  }
  return [...symbols];
}

function exportedNamesFromList(exportList: string): string[] {
  return exportList
    .split(',')
    .map((part) => part.trim())
    .map(
      (part) =>
        part
          .split(/\s+as\s+/i)
          .at(-1)
          ?.trim() ?? '',
    )
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
}

export type SymbolGrep = (workspace: string, symbol: string) => Promise<string[]>;

async function gitGrepFiles(workspace: string, symbol: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['grep', '-l', '-w', '-F', '--', symbol], {
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
    const allSymbols = extractChangedExportedSymbols(files);
    const symbols = allSymbols.slice(0, MAX_BLAST_SYMBOLS);
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
    return formatBlastRadiusContext(
      callSiteLists.filter(({ callSites }) => callSites.length > 0),
      allSymbols.length,
      symbols.length,
      MAX_CALLSITE_FILES_PER_SYMBOL,
    );
  } catch {
    return '';
  }
}
