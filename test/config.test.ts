import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROVIDERS,
  modelSupportsPromptCache,
  providerCredentialSources,
  resolveProviderBaseURL,
  resolveProviderCredential,
  resolveProviderModel,
} from '../src/shared/config.ts';
import { buildConfig } from '../src/shared/opencode.ts';

function providerEntry(
  config: ReturnType<typeof buildConfig>,
  providerID: string,
): Record<string, unknown> {
  return (config as { provider: Record<string, Record<string, unknown>> }).provider[providerID];
}

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
    const entry = providerEntry(config, 'xiaomi-token-plan-sgp');
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

describe('kimi-for-coding (native Models.dev provider)', () => {
  it('uses the direct Kimi key surface and current K3 default', () => {
    assert.deepEqual(PROVIDERS['kimi-for-coding'], {
      defaultModel: 'kimi-for-coding/k3',
      keyEnv: 'KIMI_API_KEY',
      keyInput: 'kimi-api-key',
      promptCache: false,
    });
  });

  it('emits a native provider entry without duplicating Models.dev metadata', () => {
    const config = buildConfig('kimi-for-coding', 'k3', 'kimi-key', undefined, false);
    const entry = providerEntry(config, 'kimi-for-coding');
    const options = entry.options as Record<string, unknown>;

    assert.equal(options.apiKey, 'kimi-key');
    assert.equal('baseURL' in options, false);
    assert.equal('npm' in entry, false);
    assert.equal('models' in entry, false);
    assert.equal('setCacheKey' in options, false);
  });
});

describe('openai-compatible custom provider', () => {
  const provider = PROVIDERS['openai-compatible'];

  it('uses namespaced credentials, requires a model, and leaves direct OpenAI unchanged', () => {
    assert.deepEqual(
      Object.entries(PROVIDERS)
        .filter(([, config]) => !config.defaultModel)
        .map(([providerID]) => providerID),
      ['openai-compatible'],
    );
    assert.equal(provider.defaultModel, undefined);
    assert.equal(provider.keyEnv, 'JBOT_OPENAI_COMPATIBLE_API_KEY');
    assert.equal(provider.keyInput, 'openai-compatible-api-key');
    assert.equal(provider.custom?.baseURL.env, 'JBOT_OPENAI_COMPATIBLE_BASE_URL');
    assert.equal(provider.custom?.baseURL.input, 'openai-compatible-base-url');
    assert.equal(PROVIDERS.openai.keyEnv, 'OPENAI_API_KEY');
    assert.equal(PROVIDERS.openai.keyInput, 'openai-api-key');
    assert.equal('custom' in PROVIDERS.openai, false);
    assert.throws(
      () => resolveProviderModel('openai-compatible', provider, ''),
      /Missing model for provider "openai-compatible"/,
    );
    assert.equal(
      resolveProviderModel('openai-compatible', provider, 'custom-model'),
      'custom-model',
    );
  });

  it('requires and validates an HTTP(S) base URL', () => {
    assert.throws(
      () => resolveProviderBaseURL('openai-compatible', provider, () => ''),
      /Missing base URL for provider "openai-compatible"/,
    );
    assert.throws(
      () => resolveProviderBaseURL('openai-compatible', provider, () => 'file:///tmp/model'),
      /expected http:\/\/ or https:\/\//,
    );
    assert.equal(
      resolveProviderBaseURL('openai-compatible', provider, ({ env }) =>
        env === 'JBOT_OPENAI_COMPATIBLE_BASE_URL' ? 'http://localhost:8000/v1' : '',
      ),
      'http://localhost:8000/v1',
    );
    assert.equal(
      resolveProviderBaseURL('openai', PROVIDERS.openai, () => ''),
      undefined,
    );
  });

  it('builds the documented custom OpenCode provider entry', () => {
    const config = buildConfig(
      'openai-compatible',
      'served-model',
      'proxy-key',
      { temperature: 0 },
      false,
      [],
      'https://proxy.example/v1',
    );
    const entry = providerEntry(config, 'openai-compatible');
    const options = entry.options as Record<string, unknown>;
    const models = entry.models as Record<
      string,
      { name: string; options?: Record<string, unknown> }
    >;

    assert.equal(entry.name, 'OpenAI Compatible');
    assert.equal(entry.npm, '@ai-sdk/openai-compatible');
    assert.equal(options.apiKey, 'proxy-key');
    assert.equal(options.baseURL, 'https://proxy.example/v1');
    assert.equal('setCacheKey' in options, false);
    assert.deepEqual(models['served-model'], {
      name: 'served-model',
      options: { temperature: 0 },
    });
  });

  it('embeds a custom provider selected only for auxiliary sessions', () => {
    const config = buildConfig('openai', 'gpt-5', 'openai-key', undefined, true, [
      {
        providerID: 'openai-compatible',
        modelID: 'aux-model',
        apiKey: 'aux-key',
        baseURL: 'https://aux.example/v1',
        promptCache: false,
      },
    ]);
    const entry = providerEntry(config, 'openai-compatible');
    const options = entry.options as Record<string, unknown>;

    assert.equal(options.apiKey, 'aux-key');
    assert.equal(options.baseURL, 'https://aux.example/v1');
    assert.equal('setCacheKey' in options, false);
    assert.deepEqual(entry.models, { 'aux-model': { name: 'aux-model' } });
  });

  it('rejects incomplete custom entries before starting OpenCode', () => {
    assert.throws(
      () => buildConfig('openai-compatible', 'model', 'key', undefined, false),
      /Missing base URL for custom provider/,
    );
    assert.throws(
      () =>
        buildConfig('openai', 'gpt-5', 'openai-key', undefined, true, [
          {
            providerID: 'openai-compatible',
            apiKey: 'aux-key',
            baseURL: 'https://aux.example/v1',
            promptCache: false,
          },
        ]),
      /Missing model for custom provider/,
    );
  });
});
