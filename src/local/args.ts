import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export interface LocalArgs {
  workspace?: string;
  base?: string;
  prContext?: string;
  output?: string;
  preview: boolean;
}

export interface LocalPaths {
  workspace: string;
  artifactRoot: string;
  benchmarkOutput?: string;
  prContext?: string;
  arenaOutput?: string;
}

export function parseLocalArgs(argv: string[]): LocalArgs {
  const seen = new Set<string>();
  const parsed: LocalArgs = { preview: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (
      flag !== '--preview' &&
      flag !== '--workspace' &&
      flag !== '--base' &&
      flag !== '--pr-context' &&
      flag !== '--output'
    ) {
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
    else if (flag === '--base') parsed.base = value.trim();
    else if (flag === '--pr-context') parsed.prContext = value;
    else parsed.output = value;
  }

  if (Boolean(parsed.prContext) !== Boolean(parsed.output)) {
    throw new Error(
      'Local review arguments "--pr-context" and "--output" must be supplied together.',
    );
  }
  if (parsed.prContext && parsed.preview) {
    throw new Error('Arena review arguments cannot be combined with "--preview".');
  }
  if (parsed.prContext && parsed.base) {
    throw new Error('Arena review takes its base SHA from "--pr-context", not "--base".');
  }
  return parsed;
}

function pathIsInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

export function assertArenaPathIsolation(
  workspace: string,
  prContext: string,
  output: string,
): void {
  const realWorkspace = realpathSync(workspace);
  const realContext = realpathSync(prContext);
  const realOutputParent = realpathSync(dirname(output));
  if (pathIsInside(realWorkspace, realContext) || pathIsInside(realWorkspace, realOutputParent)) {
    throw new Error('Arena context and output paths must be outside the reviewed workspace.');
  }
}

export function resolveLocalPaths(
  args: LocalArgs,
  launchDirectory: string,
  benchmarkOutput: string | undefined,
): LocalPaths {
  const launchRoot = resolve(launchDirectory);
  const output = benchmarkOutput?.trim();
  const workspace = resolve(launchRoot, args.workspace ?? '.');
  if (args.output && output) {
    throw new Error('Arena "--output" cannot be combined with JBOT_BENCHMARK_OUTPUT.');
  }
  let arena:
    { prContext: string; arenaOutput: string; artifactRoot: string } | Record<string, never> = {};
  if (args.prContext && args.output) {
    if (!isAbsolute(args.prContext) || !isAbsolute(args.output)) {
      throw new Error('Arena --pr-context and --output paths must be absolute.');
    }
    const prContext = resolve(args.prContext);
    const arenaOutput = resolve(args.output);
    if (pathIsInside(workspace, prContext) || pathIsInside(workspace, arenaOutput)) {
      throw new Error('Arena context and output paths must be outside the reviewed workspace.');
    }
    arena = { prContext, arenaOutput, artifactRoot: dirname(arenaOutput) };
  }
  return {
    workspace,
    artifactRoot: join(launchRoot, '.jbot-review'),
    ...(output ? { benchmarkOutput: resolve(launchRoot, output) } : {}),
    ...arena,
  };
}
