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
let other = 0;
let unsigned = 0;
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
  const { checked, verified, skipped, unattributed } = verifyJournalLines(
    lines,
    publicKey,
    endpoint,
  );
  bad += checked - verified;
  other += unattributed;
  unsigned += skipped;
  const parts = [];
  if (skipped > 0) parts.push(`${skipped} unsigned`);
  if (unattributed > 0) parts.push(`${unattributed} for another endpoint`);
  const note = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  console.log(
    `${verified === checked ? 'ok  ' : 'FAIL'} ${sessionId}: ${verified}/${checked} verified${note}`,
  );
}

// Counted apart: an unreadable session is not one bad frame, and rolling it
// into the frame tally would understate what it hides.
const unread = unreadable > 0 ? `, ${unreadable} unreadable session(s)` : '';
// Unexamined is not clean: rewriting endpoints would otherwise empty a scoped
// pass and still exit 0. Supply each companion's key to complete the audit.
const rest = other > 0 ? `, ${other} frame(s) UNEXAMINED (need another endpoint's key)` : '';
// Reported, not failed: client frames carry no signature until clients hold
// keys, so failing on them is an alarm nothing can clear. That leaves a
// stripped signature indistinguishable from a client frame — a gap in a
// companion's signed seq run is the detector for that, once seq numbering per
// endpoint is confirmed contiguous.
const unsig = unsigned > 0 ? `, ${unsigned} unsigned frame(s)` : '';
console.log(`${files.length} session(s), ${bad} unverified frame(s)${unread}${rest}${unsig}`);
process.exitCode = bad === 0 && unreadable === 0 && other === 0 ? 0 : 1;
