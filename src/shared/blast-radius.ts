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
const NAMED_EXPORT_START = /^\s*export\s+(type\s+)?\{/;

export function extractChangedExportedSymbols(files: PrFile[]): string[] {
  const symbols = new Set<string>();
  for (const file of files) {
    if (!file.patch) continue;
    const blocks: Partial<Record<'+' | '-', { text: string; typeOnly: boolean }>> = {};
    const lists = { '+': new Map<string, string>(), '-': new Map<string, string>() };
    const flush = (side: '+' | '-', complete: boolean) => {
      const block = blocks[side];
      if (block === undefined) return;
      const end = complete ? block.text.indexOf('}') : block.text.lastIndexOf(',');
      const source = complete
        ? (block.text
            .slice(end + 1)
            .replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*/, '')
            .match(/^from\s+(['"])(.*?)\1/)?.[2] ?? '')
        : '';
      for (const part of block.text
        .slice(0, Math.max(0, end))
        .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
        .split(',')) {
        const specifier = part.trim().replace(/\s+/g, ' ');
        const binding = specifier.replace(/^type\s+(?!as\b)/, '');
        const name = binding.split(/\s+as\s+/i).at(-1) ?? '';
        const typeOnly = block.typeOnly || binding !== specifier;
        if (/^[A-Za-z_$][\w$]*$/.test(name))
          lists[side].set([typeOnly, binding, source].join('\0'), name);
      }
      delete blocks[side];
    };
    const finishHunk = () => {
      flush('+', false);
      flush('-', false);
      for (const side of ['+', '-'] as const) {
        const other = side === '+' ? '-' : '+';
        for (const [specifier, name] of lists[side])
          if (!lists[other].has(specifier)) symbols.add(name);
      }
      lists['+'].clear();
      lists['-'].clear();
    };
    for (const line of file.patch.split('\n')) {
      if (line.startsWith('@@')) {
        finishHunk();
        continue;
      }
      const declaration = line.match(EXPORT_DECLARATION);
      if (declaration) symbols.add(declaration[1]);
      for (const side of ['+', '-'] as const) {
        if (line[0] !== side && line[0] !== ' ') continue;
        const text = line.slice(1);
        const start = text.match(NAMED_EXPORT_START);
        if (start) blocks[side] = { text: text.slice(start[0].length), typeOnly: !!start[1] };
        else if (blocks[side] !== undefined) blocks[side].text += '\n' + text;
        if (blocks[side]?.text.includes('}')) flush(side, true);
      }
    }
    finishHunk();
  }
  return [...symbols];
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
