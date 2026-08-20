import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function benchmarkArgument(name: string, argv = process.argv): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = argv[index + 1];
    return value && !value.startsWith('--') ? value : undefined;
  }
  const value = argv
    .find((candidate) => candidate.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
  return value && !value.startsWith('--') ? value : undefined;
}

export function readJsonLines<T>(path: string): T[] {
  const resolved = resolve(path);
  const values: T[] = [];
  for (const [index, line] of readFileSync(resolved, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line) as T);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON in ${resolved}:${index + 1}: ${detail}`);
    }
  }
  return values;
}
