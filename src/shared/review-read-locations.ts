import { relative, resolve } from 'node:path';

const SHELL_TOOLS = ['shell', 'bash', 'execute', 'exec'];

export function reviewReadLocations(
  workspace: string,
  tool: string,
  input: Record<string, unknown>,
): { path: string; line: number; endLine: number }[] {
  let cwd = workspace;
  const locations: { path: string; line: number; endLine: number }[] = [];
  const add = (raw: unknown, line: number, endLine = Number.MAX_SAFE_INTEGER) => {
    if (typeof raw !== 'string' || !raw || raw.length > 512 || raw.includes('\0')) return;
    const path = relative(workspace, resolve(cwd, raw));
    if (path && path !== '..' && !path.startsWith('../')) locations.push({ path, line, endLine });
  };
  if (tool === 'read_file') {
    if (input.offset !== undefined && input.offset !== 0) return [];
    const line =
      Number.isSafeInteger(input.line) && Number(input.line) > 0 ? Number(input.line) : 1;
    add(input.path, line, line);
    return locations;
  }
  if (tool === 'read') {
    const line =
      Number.isSafeInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : 1;
    const limit =
      Number.isSafeInteger(input.limit) && Number(input.limit) > 0
        ? Math.min(2000, Number(input.limit))
        : 2000;
    add(
      input.filePath ?? input.path ?? input.file,
      line,
      Math.min(Number.MAX_SAFE_INTEGER, line + limit - 1),
    );
    return locations;
  }
  if (!SHELL_TOOLS.includes(tool)) return [];
  const command = input.command;
  // Observe a tiny literal grammar; never evaluate shell syntax or replay its output.
  if (
    typeof command !== 'string' ||
    command.length > 8192 ||
    /[\\\n\r`$;|<>()[\]*?{}!]/.test(command)
  )
    return [];
  const tokens: string[] = [];
  let rest = command.trim();
  while (rest) {
    const match = /^(?:'([^']*)'|"([^"]*)"|(&&)|([^\s'"&]+))(?:\s*|$)/.exec(rest);
    if (!match) return [];
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4]);
    rest = rest.slice(match[0].length);
  }
  if (input.cwd !== undefined || input.workdir !== undefined) {
    const directory = input.cwd ?? input.workdir;
    if (typeof directory !== 'string') return [];
    cwd = resolve(workspace, directory);
  }
  for (let offset = 0; offset < tokens.length;) {
    const end = tokens.indexOf('&&', offset);
    const args = tokens.slice(offset, end < 0 ? undefined : end);
    if (offset === 0 && args.length === 2 && args[0] === 'cd') cwd = resolve(cwd, args[1]);
    else if (args.length > 1 && args[0] === 'cat' && args.slice(1).every((p) => !p.startsWith('-')))
      for (const path of args.slice(1)) add(path, 1);
    else if (args.length === 4 && args[0] === 'sed' && args[1] === '-n') {
      const range = /^([1-9]\d*),([1-9]\d*)p$/.exec(args[2]);
      if (!range || Number(range[2]) < Number(range[1]) || !Number.isSafeInteger(Number(range[2])))
        return [];
      add(args[3], Number(range[1]), Number(range[2]));
    } else return [];
    if (end < 0) break;
    offset = end + 1;
    if (offset === tokens.length) return [];
  }
  return locations.slice(0, 64);
}

/** What a page's context pack delivered: line ranges by path, symbols, and listed directories. */
export interface SuppliedContext {
  ranges: Map<string, [number, number][]>;
  symbols: Set<string>;
  directories: Set<string>;
  /** Line counts of the files in ranges. */
  lines: Map<string, number>;
}

/**
 * The pattern of the first grep, rg or git grep in a shell command
 * (`git log --grep` is not one).
 */
function shellSearchPattern(command: string): string | undefined {
  const tokens = [...command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
  for (let i = 0; i < tokens.length; i++) {
    const gitGrep = tokens[i] === 'git' && tokens[i + 1] === 'grep';
    if (tokens[i] !== 'grep' && tokens[i] !== 'rg' && !gitGrep) continue;
    for (let j = i + (gitGrep ? 2 : 1); j < tokens.length; j++) {
      if (/^(?:\|\|?|&&|;)$/.test(tokens[j])) break;
      if (tokens[j] === '-e') return tokens[j + 1];
      // These flags take a value, which is not the pattern.
      if (/^-[ABCmtgf]$|^--(?:include|exclude|glob|type)$/.test(tokens[j])) j++;
      else if (!tokens[j].startsWith('-')) return tokens[j];
    }
  }
  return undefined;
}

/** Identifiers in a pattern; escapes are blanked so `\bFoo\b` yields `Foo`. */
function searchTokens(pattern: string): string[] {
  return pattern.replace(/\\[\s\S]/g, ' ').match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
}

/** Whether a tool call re-reads or re-searches what the session's context pack already supplied. */
export function suppliedOverlap(
  workspace: string,
  tool: string,
  input: Record<string, unknown>,
  supplied: SuppliedContext,
): 'read' | 'search' | false {
  for (const location of reviewReadLocations(workspace, tool, input)) {
    const ranges = supplied.ranges.get(location.path);
    const total = supplied.lines.get(location.path);
    // Clamp whole-file and default-window reads to the file, so only mostly-supplied reads count.
    const last = Math.min(location.endLine, total ?? 0);
    if (!ranges || last < location.line) continue;
    let covered = 0;
    for (let line = location.line; line <= last; line++)
      if (ranges.some(([start, end]) => line >= start && line <= end)) covered++;
    if (covered * 2 >= last - location.line + 1) return 'read';
  }
  const dirInput = input.path ?? input.filePath;
  if (
    tool === 'read' &&
    typeof dirInput === 'string' &&
    supplied.directories.has(relative(workspace, resolve(workspace, dirInput)))
  )
    return 'read';
  const pattern =
    tool === 'grep'
      ? input.pattern
      : SHELL_TOOLS.includes(tool) && typeof input.command === 'string'
        ? shellSearchPattern(input.command)
        : undefined;
  return typeof pattern === 'string' &&
    searchTokens(pattern).some((token) => supplied.symbols.has(token))
    ? 'search'
    : false;
}
