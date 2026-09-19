import { relative, resolve } from 'node:path';

export function reviewReadLocations(
  workspace: string,
  tool: string,
  input: Record<string, unknown>,
): { path: string; line: number }[] {
  let cwd = workspace;
  const locations: { path: string; line: number }[] = [];
  const add = (raw: unknown, line: number) => {
    if (typeof raw !== 'string' || !raw || raw.length > 512 || raw.includes('\0')) return;
    const path = relative(workspace, resolve(cwd, raw));
    if (path && path !== '..' && !path.startsWith('../')) locations.push({ path, line });
  };
  if (tool === 'read' || tool === 'read_file') {
    add(
      input.filePath ?? input.path ?? input.file,
      Number.isSafeInteger(input.offset) && Number(input.offset) > 0 ? Number(input.offset) : 1,
    );
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
    else if (args.length === 2 && args[0] === 'cat' && !args[1].startsWith('-')) add(args[1], 1);
    else if (args.length === 4 && args[0] === 'sed' && args[1] === '-n') {
      const range = /^([1-9]\d*),([1-9]\d*)p$/.exec(args[2]);
      if (!range || Number(range[2]) < Number(range[1]) || !Number.isSafeInteger(Number(range[2])))
        return [];
      add(args[3], Number(range[1]));
    } else return [];
    if (end < 0) break;
    offset = end + 1;
    if (offset === tokens.length) return [];
  }
  return locations.slice(0, 64);
}
