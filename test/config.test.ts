import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROVIDERS,
  modelSupportsPromptCache,
  providerCredentialSources,
  resolveProviderCredential,
} from '../src/shared/config.ts';
import { buildConfig } from '../src/shared/opencode.ts';

describe('xiaomi-token-plan-sgp (native Models.dev provider)', () => {
  it('registers the Singapore Token Plan provider with no custom def', () => {
    const p = PROVIDERS['xiaomi-token-plan-sgp'];
    assert.equal(p.defaultModel, 'xiaomi-token-plan-sgp/mimo-v2.5-pro');
    assert.equal(p.keyEnv, 'MIMO_API_KEY');
    assert.equal(p.keyInput, 'mimo-api-key');
    // Models.dev supplies the base URL + model catalog; we pin only the key.
    assert.equal('custom' in p, false);
  });

  it('emits only the key — opencode resolves base URL/models from Models.dev', () => {
    const config = buildConfig(
      'xiaomi-token-plan-sgp',
      'mimo-v2.5-pro',
      'tp-abc',
      undefined,
      false,
    );
    const entry = (config as { provider: Record<string, Record<string, unknown>> }).provider[
      'xiaomi-token-plan-sgp'
    ];
    const options = entry.options as Record<string, unknown>;
    assert.equal(options.apiKey, 'tp-abc');
    assert.equal('baseURL' in options, false);
    assert.equal('npm' in entry, false);
    assert.equal('setCacheKey' in options, false, 'prompt cache off for this model');
  });

  it('disables prompt caching for mimo (unverified endpoint), keeps it for other providers', () => {
    assert.equal(modelSupportsPromptCache('xiaomi-token-plan-sgp', 'mimo-v2.5-pro'), false);
    assert.equal(modelSupportsPromptCache('openai', 'gpt-5.4-nano'), true);
  });
});

describe('provider credentials', () => {
  it('prefers Grok account auth and falls back to the xAI API key', () => {
    const grok = PROVIDERS.grok;
    assert.deepEqual(providerCredentialSources(grok), [
      { env: 'GROK_AUTH_JSON', input: 'grok-auth' },
      { env: 'XAI_API_KEY', input: 'xai-api-key' },
    ]);
    assert.equal(
      resolveProviderCredential(grok, ({ env }) =>
        env === 'GROK_AUTH_JSON' ? 'account-auth' : 'api-key',
      ),
      'account-auth',
    );
    assert.equal(
      resolveProviderCredential(grok, ({ env }) => (env === 'GROK_AUTH_JSON' ? ' ' : 'api-key')),
      'api-key',
    );
  });
});
