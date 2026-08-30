import { parseModelName } from '@symma/protocol';

import { providerConfig, providerCredentialSources } from '../shared/config.ts';
import { resolveModelSelection } from '../shared/model.ts';

export interface ArenaAuthRouteV1 {
  schemaVersion: 1;
  model: string;
  provider: string;
  credentialAlias: string;
  fallbackCredentialAlias: string;
  baseUrlAlias: string;
}

export function resolveArenaAuthRoute(model: string): ArenaAuthRouteV1 {
  const selected = resolveModelSelection(model);
  if (selected.length !== 1) throw new Error('Arena auth routing requires exactly one model.');
  const resolvedModel = selected[0]!;
  const { providerID } = parseModelName(resolvedModel);
  const config = providerConfig(providerID, resolvedModel);
  const credentials = providerCredentialSources(config);
  return {
    schemaVersion: 1,
    model: resolvedModel,
    provider: providerID,
    credentialAlias: credentials[0]!.env,
    fallbackCredentialAlias: credentials[1]?.env ?? '',
    baseUrlAlias: config.custom?.baseURL.env ?? '',
  };
}

function main(): void {
  const models = process.argv.slice(2);
  if (!models.length) throw new Error('Pass at least one fully qualified model.');
  process.stdout.write(`${JSON.stringify(models.map(resolveArenaAuthRoute))}\n`);
}

if (process.argv[1]?.endsWith('/arena-auth.js') || process.argv[1]?.endsWith('/arena-auth.ts'))
  main();
