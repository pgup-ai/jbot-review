import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDERS, modelSupportsPromptCache } from '../src/shared/config.ts';

describe('mimo custom provider', () => {
  it('registers the Europe Token Plan cluster, the api-key header, and the model', () => {
    const mimo = PROVIDERS.mimo;
    assert.equal(mimo.defaultModel, 'mimo/mimo-v2.5-pro');
    assert.equal(mimo.keyEnv, 'MIMO_API_KEY');
    assert.equal(mimo.keyInput, 'mimo-api-key');
    assert.equal(mimo.custom?.npm, '@ai-sdk/openai-compatible');
    assert.equal(mimo.custom?.baseURL, 'https://token-plan-ams.xiaomimimo.com/v1');
    assert.equal(mimo.custom?.apiKeyHeader, 'api-key');
    assert.ok(mimo.custom?.models['mimo-v2.5-pro']);
  });

  it('disables prompt caching for custom providers, keeps it for Models.dev ones', () => {
    // Custom OpenAI-compatible endpoints are unverified for promptCacheKey, so off.
    assert.equal(modelSupportsPromptCache('mimo', 'mimo-v2.5-pro'), false);
    assert.equal(modelSupportsPromptCache('openai', 'gpt-5.4-nano'), true);
  });
});
