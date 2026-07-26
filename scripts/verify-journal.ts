import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { verifyJournalLines } from '../src/shared/envelope-signature.ts';

/**
 * Checks a stored run's frames against the endpoint's advertised key. Unlike
 * the viewer, this depends on the gateway for nothing — run it where the
 * journal lives, on a copy if the host itself is in question:
 *
 *   npx tsx scripts/verify-journal.ts <runId> <publicKey.pem> [dataDir] [endpoint]
 *
 * The key comes from /api/endpoints (`publicKey`) on the gateway. One key
 * verifies one companion: on a run spanning several, name the endpoint so the
 * others are skipped rather than read as tampered.
 */
const [runId, keyPath, dataDir = process.env.JBOT_GATEWAY_DATA || 'gateway-data', endpoint] =
  process.argv.slice(2);

if (!runId || !keyPath) {
  console.error('usage: verify-journal.ts <runId> <publicKey.pem> [dataDir] [endpoint]');
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
let unreadable = 0;
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
    unreadable += 1;
    continue;
  }
  const { checked, verified, skipped } = verifyJournalLines(lines, publicKey, endpoint);
  bad += checked - verified;
  const note = skipped > 0 ? ` (${skipped} skipped)` : '';
  console.log(
    `${verified === checked ? 'ok  ' : 'FAIL'} ${sessionId}: ${verified}/${checked} verified${note}`,
  );
}

// Counted apart: an unreadable session is not one bad frame, and rolling it
// into the frame tally would understate what it hides.
const unread = unreadable > 0 ? `, ${unreadable} unreadable session(s)` : '';
console.log(`${files.length} session(s), ${bad} unverified frame(s)${unread}`);
process.exitCode = bad === 0 && unreadable === 0 ? 0 : 1;
