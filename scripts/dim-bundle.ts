/**
 * Builds DIM_AUTH_BUNDLE from a local `dim auth login`.
 *
 * dim needs both `auth.json` (the OAuth token store) and `dimcode.sqlite` (the
 * provider connection) — with only the first it reports "No connected
 * provider", and no CLI command reconstructs the second. The store ships at
 * ~4MB because it caches the builtin catalog for every provider dim knows;
 * pruning it to the one provider actually used brings the encoded blob under
 * the 48KB GitHub secret cap.
 *
 * Usage: npm run dim:bundle [-- <dimProviderId>]
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { encodeDimBundle } from '../src/shared/dim.ts';

const GITHUB_SECRET_LIMIT = 48 * 1024;
// Bulky and none of CI's business; the provider row is all dim needs carried.
const DROPPED_TABLES = [
  'messages',
  'sessions',
  'session_states',
  'session_blobs',
  'blob_data',
  'usage_ledger',
  'usage_daily_stats',
  'usage_run_stats',
  'file_checkpoints',
  'compaction_states',
  'queue_items',
  'permission_decisions',
];

const provider = process.argv[2] ?? 'dimcode-api-oauth';
const source = join(homedir(), '.dimcode', 'v2');

for (const file of ['auth.json', 'dimcode.sqlite']) {
  try {
    statSync(join(source, file));
  } catch {
    console.error(
      `Missing ${join(source, file)}. Run: dim auth login --device-login --provider ${provider}`,
    );
    process.exit(1);
  }
}

const work = mkdtempSync(join(tmpdir(), 'jbot-dim-bundle-'));
try {
  const store = join(work, 'dimcode.sqlite');
  copyFileSync(join(source, 'dimcode.sqlite'), store);
  const db = new DatabaseSync(store);
  for (const table of DROPPED_TABLES) db.exec(`DELETE FROM ${table}`);
  const kept = db.prepare('SELECT COUNT(*) AS n FROM providers WHERE providerId = ?').get(provider);
  if (!(kept as { n: number }).n) {
    console.error(`Provider "${provider}" is not connected locally. Run \`dim provider list\`.`);
    process.exit(1);
  }
  db.prepare('DELETE FROM providers WHERE providerId <> ?').run(provider);
  db.exec('VACUUM');
  db.close();

  const bundle = encodeDimBundle({
    auth: readFileSync(join(source, 'auth.json'), 'utf8').trim(),
    store: readFileSync(store).toString('base64'),
  });
  if (bundle.length > GITHUB_SECRET_LIMIT) {
    console.error(
      `Bundle is ${bundle.length} bytes, over the ${GITHUB_SECRET_LIMIT}-byte GitHub secret cap.`,
    );
    process.exit(1);
  }
  console.error(`DIM_AUTH_BUNDLE (${bundle.length} bytes, provider ${provider}):`);
  console.log(bundle);
} finally {
  rmSync(work, { recursive: true, force: true });
}
