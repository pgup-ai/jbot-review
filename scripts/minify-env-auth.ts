import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { PROVIDERS } from '../src/shared/config.ts';
import { minifyEnvAuth } from '../src/local/env-auth.ts';

// `npm run env:minify-auth [path]` — folds pasted multi-line JSON credentials
// in .env back to one line. Candidate keys come from the provider catalog, so
// new CLI backends are covered automatically. Prints key names only, never
// values.
const path = process.argv[2] ?? '.env';
if (!existsSync(path)) {
  console.error(`[jbot-review] ${path} not found.`);
  process.exit(1);
}
const candidateKeys = new Set(Object.values(PROVIDERS).map((provider) => provider.keyEnv));
const original = readFileSync(path, 'utf8');
const { content, changed, warnings } = minifyEnvAuth(original, candidateKeys);
for (const warning of warnings) console.warn(`[jbot-review] ${warning}`);
if (content === original) {
  console.log(`[jbot-review] ${path}: nothing to minify.`);
} else {
  writeFileSync(path, content);
  console.log(`[jbot-review] ${path}: minified ${changed.join(', ')}.`);
}
