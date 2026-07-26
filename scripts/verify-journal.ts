import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { verifyJournalLines } from '../src/shared/envelope-signature.ts';

/**
 * Checks a stored run's frames against its companions' keys. Run it where the
 * journal lives, on a copy if the host itself is in question:
 *
 *   npx tsx scripts/verify-journal.ts <runId> <publicKey.pem>... [dataDir]
 *
 * Pass every companion's key; a frame verifies under whichever fits, so a run
 * spanning several companions audits in one invocation.
 *
 * The verdict is only as trustworthy as the keys' provenance. For corruption
 * and storage tampering, /api/endpoints (`publicKey`) is fine. To audit a
 * gateway you no longer trust, the keys must never have come from it: copy
 * ~/.local/share/jbot-companion/signing-key.pub.pem off each companion
 * machine. A fully compromised gateway is shut down and rotated, not argued
 * with — this tool then tells you which stored runs still deserve belief.
 */
const args = process.argv.slice(2);
const runId = args.shift();
// Everything that looks like a key is one; a lone trailing non-.pem arg is the
// data dir, matching the old positional form.
const dataDirArg =
  args.length > 1 && !args[args.length - 1]!.endsWith('.pem') ? args.pop() : undefined;
const keyPaths = args;
const dataDir = dataDirArg ?? process.env.JBOT_GATEWAY_DATA ?? 'gateway-data';

if (!runId || keyPaths.length === 0) {
  console.error('usage: verify-journal.ts <runId> <publicKey.pem>... [dataDir]');
  process.exit(2);
}

/** Reports the path rather than a stack: every argument here is user-supplied. */
function fail(what: string, error: unknown): never {
  console.error(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const publicKeys = keyPaths.map((keyPath) => {
  try {
    return readFileSync(keyPath, 'utf8');
  } catch (error) {
    fail(`cannot read key ${keyPath}`, error);
  }
});

const runDir = join(dataDir, runId);
let files: string[] = [];
try {
  files = readdirSync(runDir).filter((entry) => entry.endsWith('.ndjson'));
} catch (error) {
  fail(`cannot read run ${runDir}`, error);
}

let bad = 0;
let broken = 0;
let moved = 0;
let unreadable = 0;
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
  const { checked, verified, skipped, breaks, misplaced } = verifyJournalLines(lines, publicKeys, {
    runId,
    sessionId,
  });
  bad += checked - verified - misplaced;
  broken += breaks;
  moved += misplaced;
  unsigned += skipped;
  const parts = [];
  if (skipped > 0) parts.push(`${skipped} unsigned`);
  if (breaks > 0)
    parts.push(`${breaks} sequence break(s): frames deleted, reordered, or duplicated`);
  const note = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  console.log(
    `${verified === checked && breaks === 0 ? 'ok  ' : 'FAIL'} ${sessionId}: ${verified}/${checked} verified${note}`,
  );
}

// Reported, not failed: client frames carry no signature until clients hold
// keys, so failing on them is an alarm nothing can clear. A stripped signature
// posing as one is caught by the sequence break it leaves behind.
const unread = unreadable > 0 ? `, ${unreadable} unreadable session(s)` : '';
const seq = broken > 0 ? `, ${broken} sequence break(s)` : '';
const swapped = moved > 0 ? `, ${moved} frame(s) signed for a different run/session` : '';
const unsig = unsigned > 0 ? `, ${unsigned} unsigned frame(s)` : '';
console.log(
  `${files.length} session(s), ${bad} unverified frame(s)${seq}${swapped}${unread}${unsig}`,
);
process.exitCode = bad === 0 && broken === 0 && moved === 0 && unreadable === 0 ? 0 : 1;
