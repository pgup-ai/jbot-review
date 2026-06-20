import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDERS, modelSupportsPromptCache } from '../src/shared/config.ts';
import {
  formatModelName,
  parseModelName,
  resolveAuxModelName,
  resolveModelName,
} from '../src/shared/model.ts';

describe('parseModelName', () => {
  it('keeps the first segment as provider and the remaining path as model id', () => {
    assert.deepEqual(parseModelName('openrouter/google/gemini-2.5-flash'), {
      providerID: 'openrouter',
      modelID: 'google/gemini-2.5-flash',
    });
  });
});

describe('resolveModelName', () => {
  it('treats an unprefixed model as belonging to the selected provider', () => {
    assert.deepEqual(resolveModelName('opencode', 'deepseek-v4-flash-free'), {
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
    });
  });

  it('treats an already selected-provider-prefixed model the same way', () => {
    assert.deepEqual(resolveModelName('opencode', 'opencode/deepseek-v4-flash-free'), {
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
    });
  });

  it('allows provider catalog model ids with slash-containing publisher prefixes', () => {
    assert.deepEqual(resolveModelName('nvidia', 'moonshotai/kimi-k2.6'), {
      providerID: 'nvidia',
      modelID: 'moonshotai/kimi-k2.6',
    });
  });

  it('formats resolved models into the canonical provider/model id string', () => {
    assert.equal(
      formatModelName(resolveModelName('nvidia', 'moonshotai/kimi-k2.6')),
      'nvidia/moonshotai/kimi-k2.6',
    );
  });

  it('normalizes every configured provider default without changing provider selection', () => {
    for (const [providerID, cfg] of Object.entries(PROVIDERS)) {
      const resolved = resolveModelName(providerID, cfg.defaultModel);

      assert.equal(resolved.providerID, providerID);
      assert.notEqual(resolved.modelID, '');
      assert.equal(formatModelName(resolved), cfg.defaultModel);
    }
  });

  it('configures Z.AI Coding Plan with the direct Z.AI key surface', () => {
    assert.deepEqual(PROVIDERS['zai-coding-plan'], {
      defaultModel: 'zai-coding-plan/glm-5.2',
      keyEnv: 'ZAI_API_KEY',
      keyInput: 'zai-api-key',
    });
  });

  it('configures Gemini with the direct Gemini key surface', () => {
    assert.deepEqual(PROVIDERS.google, {
      defaultModel: 'google/gemini-2.5-flash',
      keyEnv: 'GEMINI_API_KEY',
      keyInput: 'gemini-api-key',
    });
  });

  it('rejects an empty selected-provider-prefixed model id', () => {
    assert.throws(() => resolveModelName('opencode', 'opencode/'), /expected a non-empty model id/);
  });
});

describe('resolveAuxModelName', () => {
  it('defaults aux models to the main provider', () => {
    assert.equal(resolveAuxModelName('openai', 'gpt-5.4-mini'), 'openai/gpt-5.4-mini');
  });

  it('uses an explicit aux provider when present', () => {
    assert.equal(
      resolveAuxModelName('openai', 'google/gemini-2.5-flash', 'openrouter'),
      'openrouter/google/gemini-2.5-flash',
    );
  });
});

describe('modelSupportsPromptCache', () => {
  it('disables prompt caching only for models explicitly marked unsupported', () => {
    assert.equal(modelSupportsPromptCache('opencode-go', 'glm-5.2'), false);
    assert.equal(modelSupportsPromptCache('opencode-go', 'deepseek-v4-flash'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'kimi-k2.6'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'minimax-m3'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'qwen3.6-plus'), true);
    assert.equal(modelSupportsPromptCache('unknown-provider', 'unknown-model'), true);
  });
});
