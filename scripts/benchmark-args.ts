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
  return readFileSync(resolve(path), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}
