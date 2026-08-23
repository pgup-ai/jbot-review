import { join, resolve } from 'node:path';

export interface LocalArgs {
  workspace?: string;
  base?: string;
  preview: boolean;
}

export interface LocalPaths {
  workspace: string;
  artifactRoot: string;
  benchmarkOutput?: string;
}

export function parseLocalArgs(argv: string[]): LocalArgs {
  const seen = new Set<string>();
  const parsed: LocalArgs = { preview: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag !== '--preview' && flag !== '--workspace' && flag !== '--base') {
      throw new Error(`Unknown local review argument "${flag}".`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate local review argument "${flag}".`);
    seen.add(flag);

    if (flag === '--preview') {
      parsed.preview = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || !value.trim() || value.startsWith('--')) {
      throw new Error(`Local review argument "${flag}" requires a value.`);
    }
    index += 1;
    if (flag === '--workspace') parsed.workspace = value;
    else parsed.base = value.trim();
  }

  return parsed;
}

export function resolveConfiguredBase(
  explicitBase: string | undefined,
  environmentBase: string | undefined,
): string | undefined {
  return (explicitBase ?? environmentBase?.trim()) || undefined;
}

export function resolveLocalPaths(
  args: LocalArgs,
  launchDirectory: string,
  benchmarkOutput: string | undefined,
): LocalPaths {
  const launchRoot = resolve(launchDirectory);
  const output = benchmarkOutput?.trim();
  return {
    workspace: resolve(launchRoot, args.workspace ?? '.'),
    artifactRoot: join(launchRoot, '.jbot-review'),
    ...(output ? { benchmarkOutput: resolve(launchRoot, output) } : {}),
  };
}
