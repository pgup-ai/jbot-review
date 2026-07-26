import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readJournalLines } from '../src/gateway/journal.ts';
import { verifyJournalLines } from '../src/shared/envelope-signature.ts';

/**
 * Checks a stored run's frames against the endpoint's advertised key. Unlike
 * the viewer, this depends on the gateway for nothing — run it where the
 * journal lives, on a copy if the host itself is in question:
 *
 *   npx tsx scripts/verify-journal.ts <runId> <publicKey.pem> [dataDir]
 *
 * The key comes from /api/endpoints (`publicKey`) on the gateway.
 */
const [runId, keyPath, dataDir = process.env.JBOT_GATEWAY_DATA || 'gateway-data'] =
  process.argv.slice(2);

if (!runId || !keyPath) {
  console.error('usage: verify-journal.ts <runId> <publicKey.pem> [dataDir]');
  process.exit(2);
}

const publicKey = readFileSync(keyPath, 'utf8');
const sessions = readdirSync(join(dataDir, runId))
  .filter((entry) => entry.endsWith('.ndjson'))
  .map((entry) => entry.replace(/\.ndjson$/, ''));

let bad = 0;
for (const sessionId of sessions) {
  const { total, verified } = verifyJournalLines(
    readJournalLines(dataDir, runId, sessionId),
    publicKey,
  );
  bad += total - verified;
  console.log(
    `${verified === total ? 'ok  ' : 'FAIL'} ${sessionId}: ${verified}/${total} verified`,
  );
}

console.log(`${sessions.length} session(s), ${bad} unverified frame(s)`);
process.exitCode = bad === 0 ? 0 : 1;
