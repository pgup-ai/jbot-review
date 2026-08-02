import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Finding } from './types.ts';

/**
 * Content-addressed reuse of completed shard results. When one shard of a
 * sharded review fails permanently, the whole run fails (invariant 1 forbids
 * partial coverage) and a re-trigger re-bills every shard — including the ones
 * that succeeded. Keying completed results by the exact content they reviewed
 * lets the re-run reuse them: same head, same model, byte-identical patches.
 *
 * Reuse is exact-content only, so invariant 1 is untouched — the union of
 * shards still covers the full diff; a cached result IS that shard's full
 * review of identical input. Bump FINGERPRINT_VERSION when the prompt contract
 * changes in ways that make old outputs incomparable.
 */
const FINGERPRINT_VERSION = 1;

export interface CachedShardResult {
  summary: string;
  findings: Finding[];
}

export function shardFingerprint(input: {
  headSha: string;
  model: string;
  files: { filename: string; patch?: string }[];
}): string {
  const hash = createHash('sha256');
  hash.update(`v${FINGERPRINT_VERSION}\0${input.headSha}\0${input.model}`);
  const sorted = [...input.files].sort((a, b) => a.filename.localeCompare(b.filename));
  for (const file of sorted) hash.update(`\0${file.filename}\0${file.patch ?? ''}`);
  return hash.digest('hex').slice(0, 32);
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
      !Array.isArray((parsed as CachedShardResult).findings)
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
