import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { verifyJournalLines } from '../src/shared/envelope-signature.ts';

/**
 * Checks a stored run's frames against the endpoint's advertised key. Unlike
 * the viewer, this depends on the gateway for nothing — run it where the
 * journal lives, on a copy if the host itself is in question:
 *
 *   npx tsx scripts/verify-journal.ts <runId> <publicKey.pem> [dataDir]
 *
 * The key comes from /api/endpoints (`publicKey`) on the gateway. One key
 * verifies one companion, so a run spanning several needs a pass each.
 */
const [runId, keyPath, dataDir = process.env.JBOT_GATEWAY_DATA || 'gateway-data'] =
  process.argv.slice(2);

if (!runId || !keyPath) {
  console.error('usage: verify-journal.ts <runId> <publicKey.pem> [dataDir]');
  process.exit(2);
}

/** Reports the path rather than a stack: every argument here is user-supplied. */
function fail(what: string, error: unknown): never {
  console.error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

let publicKey = '';
try {
  publicKey = readFileSync(keyPath, 'utf8');
} catch (error) {
  fail(`cannot read key ${keyPath}`, error);
}

const runDir = join(dataDir, runId);
let files: string[] = [];
try {
  files = readdirSync(runDir).filter((entry) => entry.endsWith('.ndjson'));
} catch (error) {
  fail(`cannot read run ${runDir}`, error);
}

let bad = 0;
for (const file of files) {
  const sessionId = file.replace(/\.ndjson$/, '');
  let lines: string[];
  try {
    // Read here rather than through readJournalLines, which returns [] for an
    // unreadable file — indistinguishable from an empty one, and reporting an
    // unreadable journal as 0/0 verified would make a failure look green.
    lines = readFileSync(join(runDir, file), 'utf8').split('\n').filter(Boolean);
  } catch (error) {
    console.log(`FAIL ${sessionId}: unreadable (${error instanceof Error ? error.message : ''})`);
    bad += 1;
    continue;
  }
  const { checked, verified, skipped } = verifyJournalLines(lines, publicKey);
  bad += checked - verified;
  const note = skipped > 0 ? ` (${skipped} unsigned client frame(s) skipped)` : '';
  console.log(
    `${verified === checked ? 'ok  ' : 'FAIL'} ${sessionId}: ${verified}/${checked} verified${note}`,
  );
}

console.log(`${files.length} session(s), ${bad} unverified frame(s)`);
process.exitCode = bad === 0 ? 0 : 1;
