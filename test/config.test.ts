import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDERS, modelSupportsPromptCache } from '../src/shared/config.ts';
import { buildConfig } from '../src/shared/opencode.ts';

describe('mimo custom provider', () => {
  it('registers the Singapore Token Plan cluster and the model', () => {
    const mimo = PROVIDERS.mimo;
    assert.equal(mimo.defaultModel, 'mimo/mimo-v2.5-pro');
    assert.equal(mimo.keyEnv, 'MIMO_API_KEY');
    assert.equal(mimo.keyInput, 'mimo-api-key');
    assert.equal(mimo.custom?.npm, '@ai-sdk/openai-compatible');
    assert.equal(mimo.custom?.baseURL, 'https://token-plan-sgp.xiaomimimo.com/v1');
    assert.ok(mimo.custom?.models['mimo-v2.5-pro']);
  });

  // Regression: the SHIPPING config, not a fixture. MiMo's MiFE gateway 401s on an
  // extra api-key header; it wants Authorization: Bearer (opencode's apiKey option).
  it('emits Bearer-only auth (apiKey, no custom header) from the real registry', () => {
    const config = buildConfig(
      'mimo',
      'mimo-v2.5-pro',
      'tp-abc',
      undefined,
      false,
      [],
      PROVIDERS.mimo.custom,
    );
    const { options } = (
      config as { provider: Record<string, { options: Record<string, unknown> }> }
    ).provider.mimo;
    assert.equal(options.apiKey, 'tp-abc');
    assert.equal('headers' in options, false);
  });

  it('disables prompt caching for custom providers, keeps it for Models.dev ones', () => {
    // Custom OpenAI-compatible endpoints are unverified for promptCacheKey, so off.
    assert.equal(modelSupportsPromptCache('mimo', 'mimo-v2.5-pro'), false);
    assert.equal(modelSupportsPromptCache('openai', 'gpt-5.4-nano'), true);
  });
});
