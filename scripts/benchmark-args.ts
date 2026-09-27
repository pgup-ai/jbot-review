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

/** A typo must throw: NaN or 0 downstream silently empties a worker pool or never grants a semaphore. */
export function integerArgument(name: string, fallback: number, min: number, argv = process.argv) {
  const raw = benchmarkArgument(name, argv);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min)
    throw new Error(`--${name} must be an integer ≥ ${min}, got ${raw}.`);
  return value;
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
