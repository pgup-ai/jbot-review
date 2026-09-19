import { relative, resolve } from 'node:path';

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
  if (tool === 'read' || tool === 'read_file') {
    const line =
      Number.isSafeInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : 1;
    const endLine =
      Number.isSafeInteger(input.limit) && Number(input.limit) > 0
        ? Math.min(Number.MAX_SAFE_INTEGER, line + Number(input.limit) - 1)
        : Number.MAX_SAFE_INTEGER;
    add(input.filePath ?? input.path ?? input.file, line, endLine);
    return locations;
  }
  if (!['shell', 'bash', 'execute', 'exec'].includes(tool)) return [];
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
