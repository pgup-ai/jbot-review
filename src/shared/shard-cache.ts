import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { sanitizeFinding, type Finding } from './types.ts';

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
  // JSON-array framing keeps field boundaries unambiguous: a delimiter-joined
  // payload would let a NUL inside one field alias a different field split.
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify([
      FINGERPRINT_VERSION,
      input.headSha,
      input.model,
      input.evidenceQuotes,
      input.config,
      input.context,
      input.guidelines,
    ]),
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

/** Fail-open: a cache problem is a miss, never a run failure. */
export function loadCachedShardResult(
  dir: string,
  fingerprint: string,
): CachedShardResult | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, `${fingerprint}.json`), 'utf8'));
    // A persistent cache can hold entries written by other jbot versions; the
    // findings go through the SAME gate as a live model response
    // (sanitizeFinding), so required-field damage is a miss and optionals
    // normalize with the live path's tolerance.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as CachedShardResult).summary !== 'string' ||
      !Array.isArray((parsed as CachedShardResult).findings)
    ) {
      return undefined;
    }
    const findings = (parsed as CachedShardResult).findings.map(sanitizeFinding);
    if (findings.some((finding) => finding === undefined)) return undefined;
    return { summary: (parsed as CachedShardResult).summary, findings: findings as Finding[] };
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
