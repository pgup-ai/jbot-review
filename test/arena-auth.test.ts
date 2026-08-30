import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveArenaAuthRoute } from '../src/local/arena-auth.ts';
import { PROVIDERS, providerCredentialSources } from '../src/shared/config.ts';

describe('arena auth routing', () => {
  it('derives routes and provider validation from the runtime config', () => {
    for (const [provider, config] of Object.entries(PROVIDERS)) {
      const route = resolveArenaAuthRoute(`${provider}/arena-model`);
      const credentials = providerCredentialSources(config);
      assert.deepEqual(route, {
        schemaVersion: 1,
        model: `${provider}/arena-model`,
        provider,
        credentialAlias: credentials[0]!.env,
        fallbackCredentialAlias: credentials[1]?.env ?? '',
        baseUrlAlias: config.custom?.baseURL.env ?? '',
      });
    }
    assert.throws(() => resolveArenaAuthRoute('unknown/model'), /Unknown provider/);
    assert.throws(() => resolveArenaAuthRoute('cline/a,cline/b'), /exactly one model/);
  });
});
