import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { Finding } from './types.ts';

/**
 * Content-addressed reuse of completed shard results: a shard failure fails
 * the whole run (invariant 1 forbids partial coverage), so a re-trigger
 * re-bills every shard — including the ones that succeeded. Reuse is
 * exact-content only (same head, model, byte-identical patches), so the union
 * of shards still covers the full diff and invariant 1 is untouched. Bump
 * FINGERPRINT_VERSION when the prompt contract makes old outputs incomparable.
 */
const FINGERPRINT_VERSION = 1;

export interface CachedShardResult {
  summary: string;
  findings: Finding[];
}

export function shardFingerprint(input: {
  headSha: string;
  model: string;
  /** The shard's assembled prompt context — carries PR metadata, prior threads, and the diff slice. */
  context: string;
  guidelines: string;
  evidenceQuotes: boolean;
  /** Provider-call configuration that changes output without changing the prompt (engine, modelOptions). */
  config: string;
}): string {
  const hash = createHash('sha256');
  hash.update(
    `v${FINGERPRINT_VERSION}\0${input.headSha}\0${input.model}\0${input.evidenceQuotes}` +
      `\0${input.config}\0${input.context}\0${input.guidelines}`,
  );
  return hash.digest('hex').slice(0, 32);
}

/**
 * The forgery guard for the poisoning vector: the workspace is the PR
 * author's tree, so a cache directory that RESOLVES inside it (symlinks
 * included) would let a PR commit a fabricated "clean" shard result. Returns
 * the directory to use, or undefined when it must not be used.
 */
export function resolveShardCacheDir(dir: string, workspace: string): string | undefined {
  // Realpath the closest EXISTING ancestor so a not-yet-created cache dir
  // still resolves through symlinked prefixes (macOS /var → /private/var).
  const real = (path: string): string => {
    let current = resolve(path);
    let suffix = '';
    for (;;) {
      try {
        return join(realpathSync(current), suffix);
      } catch {
        const parent = dirname(current);
        if (parent === current) return join(current, suffix);
        suffix = suffix ? join(basename(current), suffix) : basename(current);
        current = parent;
      }
    }
  };
  const resolvedDir = real(dir);
  const resolvedWorkspace = real(workspace);
  const inside =
    resolvedDir === resolvedWorkspace || resolvedDir.startsWith(resolvedWorkspace + sep);
  return inside ? undefined : dir;
}

const CACHED_SEVERITIES = new Set(['P0', 'P1', 'P2', 'P3', 'nit']);

const optionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

function isCachedFinding(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.path === 'string' &&
    typeof f.line === 'number' &&
    typeof f.title === 'string' &&
    typeof f.body === 'string' &&
    typeof f.severity === 'string' &&
    CACHED_SEVERITIES.has(f.severity) &&
    // Mistyped optionals would crash downstream (the anchor matcher splits
    // `evidence`; filters read `confidence`/`kind`).
    optionalString(f.evidence) &&
    optionalString(f.kind) &&
    optionalString(f.confidence) &&
    optionalString(f.id)
  );
}

/** Fail-open: a cache problem is a miss, never a run failure. */
export function loadCachedShardResult(
  dir: string,
  fingerprint: string,
): CachedShardResult | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${fingerprint}.json`), 'utf8'));
    // A persistent workspace can hold entries written by other jbot versions;
    // a shape this version does not recognize is a miss, not a crash.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as CachedShardResult).summary !== 'string' ||
      !Array.isArray((parsed as CachedShardResult).findings) ||
      !(parsed as CachedShardResult).findings.every(isCachedFinding)
    ) {
      return undefined;
    }
    return parsed as CachedShardResult;
  } catch {
    return undefined;
  }
}

/** Fail-open: never let a cache write failure touch the review. */
export function saveShardResult(dir: string, fingerprint: string, result: CachedShardResult): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${fingerprint}.json`), JSON.stringify(result));
  } catch {
    /* cache is best-effort */
  }
}
