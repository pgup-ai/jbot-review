import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROVIDERS,
  modelSupportsPromptCache,
  resolvePromptCachePolicy,
} from '../src/shared/config.ts';
import { parseModelName } from '@symma/protocol';
import { pickPooledModel, resolveAuxModel, resolveModelSelection } from '../src/shared/model.ts';

describe('parseModelName', () => {
  it('keeps the first segment as provider and the remaining path as model id', () => {
    assert.deepEqual(parseModelName('openrouter/google/gemini-2.5-flash'), {
      providerID: 'openrouter',
      modelID: 'google/gemini-2.5-flash',
    });
  });
});

describe('resolveModelSelection', () => {
  it('derives the provider from the first segment and keeps the rest as the model id', () => {
    // Only the first segment routes, so these stay distinct routes to what may
    // be the same underlying model.
    assert.deepEqual(resolveModelSelection('kilo/zai/glm-5.2'), {
      providerID: 'kilo',
      pool: ['kilo/zai/glm-5.2'],
    });
    assert.deepEqual(resolveModelSelection('devin/glm-5.2'), {
      providerID: 'devin',
      pool: ['devin/glm-5.2'],
    });
  });

  it('resolves a comma-separated pool of same-provider refs', () => {
    assert.deepEqual(resolveModelSelection(' opencode/a , opencode/b/c ,, opencode/d '), {
      providerID: 'opencode',
      pool: ['opencode/a', 'opencode/b/c', 'opencode/d'],
    });
  });

  it('rejects a pool that spans providers', () => {
    assert.throws(
      () => resolveModelSelection('opencode/a, devin/b'),
      /mixes providers "opencode" and "devin"/,
    );
  });

  it('names the offending model when the derived provider is unknown', () => {
    assert.throws(
      () => resolveModelSelection('moonshotai/kimi-k2.6'),
      /Unknown provider "moonshotai" derived from model "moonshotai\/kimi-k2\.6"/,
    );
  });

  it('falls back to the default provider for a ref that names none', () => {
    assert.deepEqual(resolveModelSelection('deepseek-v4-flash-free'), {
      providerID: 'opencode',
      pool: ['opencode/deepseek-v4-flash-free'],
    });
  });

  it('uses the provider catalog default when no model is given', () => {
    assert.deepEqual(resolveModelSelection(), {
      providerID: 'opencode',
      pool: ['opencode/deepseek-v4-flash-free'],
    });
    assert.deepEqual(resolveModelSelection('', 'devin'), {
      providerID: 'devin',
      pool: ['devin/default'],
    });
    assert.throws(
      () => resolveModelSelection('', 'openai-compatible'),
      /Missing model for provider "openai-compatible"/,
    );
  });

  it('rejects malformed refs', () => {
    assert.throws(() => resolveModelSelection('opencode/'), /expected a non-empty model id/);
    assert.throws(() => resolveModelSelection('/deepseek'), /expected a non-empty model id/);
    assert.throws(() => resolveModelSelection(' , '), /expected at least one model/);
  });

  it('leaves every configured provider default naming its own provider', () => {
    for (const [providerID, cfg] of Object.entries(PROVIDERS)) {
      if (!cfg.defaultModel) continue;
      assert.deepEqual(resolveModelSelection(cfg.defaultModel), {
        providerID,
        pool: [cfg.defaultModel],
      });
    }
  });
});

describe('resolveModelSelection with a legacy provider input', () => {
  it('pins the provider and absorbs one matching prefix', () => {
    assert.deepEqual(resolveModelSelection('deepseek-v4-flash-free, opencode/b', 'opencode'), {
      providerID: 'opencode',
      pool: ['opencode/deepseek-v4-flash-free', 'opencode/b'],
    });
  });

  it('keeps a non-matching slash prefix inside the model id', () => {
    // Catalog ids carry publisher prefixes; a pin stops them reading as providers.
    assert.deepEqual(resolveModelSelection('moonshotai/kimi-k2.6', 'nvidia'), {
      providerID: 'nvidia',
      pool: ['nvidia/moonshotai/kimi-k2.6'],
    });
  });

  it('rejects an unknown pinned provider', () => {
    assert.throws(() => resolveModelSelection('a', 'nope'), /Unknown provider "nope"\. Supported:/);
  });
});

describe('pickPooledModel', () => {
  it('picks one entry per seed, stable for that seed and spread across seeds', () => {
    const pool = ['opencode/a', 'opencode/b', 'opencode/c'];
    const seed = 'e3f0c1a9b7d24e6f8a0b1c2d3e4f5a6b7c8d9e0f';

    assert.equal(pickPooledModel(pool, seed), pickPooledModel(pool, seed));
    assert.deepEqual(
      [
        ...new Set(Array.from({ length: 60 }, (_, i) => pickPooledModel(pool, `${seed}${i}`))),
      ].sort(),
      pool,
    );
  });

  it('returns the only entry of a single-model pool', () => {
    assert.equal(pickPooledModel(['opencode/solo'], 'any-seed'), 'opencode/solo');
  });
});

describe('resolveAuxModel', () => {
  it('keeps an unqualified aux model on the main provider', () => {
    assert.deepEqual(resolveAuxModel('gpt-5.4-mini', 'openai'), {
      model: 'openai/gpt-5.4-mini',
      providerID: 'openai',
    });
  });

  it('reports the main provider when no aux model is set', () => {
    // Callers compare this against the main provider to decide whether the aux
    // sessions need their own credential.
    assert.deepEqual(resolveAuxModel(undefined, 'openai'), { model: '', providerID: 'openai' });
    assert.deepEqual(resolveAuxModel('  ', 'openai'), { model: '', providerID: 'openai' });
  });

  it('routes a qualified aux model to the provider it names', () => {
    assert.deepEqual(resolveAuxModel('google/gemini-2.5-flash', 'openai'), {
      model: 'google/gemini-2.5-flash',
      providerID: 'google',
    });
    assert.throws(() => resolveAuxModel('nope/m', 'openai'), /Unknown provider "nope"/);
  });

  it('lets a legacy aux provider pin the model as before', () => {
    // The old resolver always pinned the aux model — to aux-provider, else the
    // main provider — so a legacy pin must still swallow a qualified ref rather
    // than let it route itself. Entries pass `aux-provider || provider` here.
    assert.deepEqual(resolveAuxModel('google/gemini-2.5-flash', 'openai', 'openrouter'), {
      model: 'openrouter/google/gemini-2.5-flash',
      providerID: 'openrouter',
    });
    assert.deepEqual(resolveAuxModel('google/gemini-2.5-flash', 'opencode', 'opencode'), {
      model: 'opencode/google/gemini-2.5-flash',
      providerID: 'opencode',
    });
    assert.throws(() => resolveAuxModel('a', 'openai', 'nope'), /Unknown provider "nope"/);
  });

  it('rejects a pool handed to the single-model aux input', () => {
    assert.throws(() => resolveAuxModel('a, b', 'opencode'), /one model id, not a list/);
  });
});

describe('modelSupportsPromptCache', () => {
  it('disables prompt caching for models and providers marked unsupported', () => {
    assert.equal(modelSupportsPromptCache('opencode-go', 'glm-5.2'), false);
    assert.equal(modelSupportsPromptCache('zai-coding-plan', 'glm-5.2'), false);
    assert.equal(modelSupportsPromptCache('kimi-for-coding', 'k3'), false);
    assert.equal(modelSupportsPromptCache('openai-compatible', 'any-model'), false);
    assert.equal(modelSupportsPromptCache('opencode-go', 'deepseek-v4-flash'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'kimi-k2.6'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'minimax-m3'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'qwen3.6-plus'), true);
    assert.equal(modelSupportsPromptCache('devin', 'default'), false);
    assert.equal(modelSupportsPromptCache('devin', 'codex'), false);
    assert.equal(modelSupportsPromptCache('commandcode', 'default'), false);
    assert.equal(modelSupportsPromptCache('commandcode', 'Qwen/Qwen3.7-Max'), false);
    assert.equal(modelSupportsPromptCache('qoder', 'ultimate'), false);
    assert.equal(modelSupportsPromptCache('grok', 'default'), false);
    assert.equal(
      modelSupportsPromptCache('fireworks-ai', 'accounts/fireworks/models/deepseek-v4-flash'),
      false,
    );
    // Provider-wide: any Fireworks model rejects promptCacheKey, even ones not pre-listed.
    assert.equal(
      modelSupportsPromptCache('fireworks-ai', 'accounts/fireworks/models/glm-5p2'),
      false,
    );
    assert.equal(modelSupportsPromptCache('unknown-provider', 'unknown-model'), true);
  });
});

describe('resolvePromptCachePolicy', () => {
  it('disables prompt caching for an unsupported main model once', () => {
    assert.deepEqual(
      resolvePromptCachePolicy({
        promptCache: true,
        mainModel: 'opencode-go/glm-5.2',
        mainProviderID: 'opencode-go',
        mainModelID: 'glm-5.2',
        auxModel: 'opencode-go/glm-5.2',
        auxProviderID: 'opencode-go',
        auxModelID: 'glm-5.2',
      }),
      {
        providerPromptCache: false,
        auxProviderPromptCache: false,
        disabledPromptCacheModels: ['opencode-go/glm-5.2'],
        sharedProviderCacheDisabled: false,
      },
    );
  });

  it('disables the shared provider cache when only a same-provider aux model is unsupported', () => {
    assert.deepEqual(
      resolvePromptCachePolicy({
        promptCache: true,
        mainModel: 'opencode-go/deepseek-v4-flash',
        mainProviderID: 'opencode-go',
        mainModelID: 'deepseek-v4-flash',
        auxModel: 'opencode-go/glm-5.2',
        auxProviderID: 'opencode-go',
        auxModelID: 'glm-5.2',
      }),
      {
        providerPromptCache: false,
        auxProviderPromptCache: false,
        disabledPromptCacheModels: ['opencode-go/glm-5.2'],
        sharedProviderCacheDisabled: true,
      },
    );
  });

  it('keeps the main provider cache enabled when an unsupported aux model uses another provider', () => {
    assert.deepEqual(
      resolvePromptCachePolicy({
        promptCache: true,
        mainModel: 'openai/gpt-5.4-nano',
        mainProviderID: 'openai',
        mainModelID: 'gpt-5.4-nano',
        auxModel: 'opencode-go/glm-5.2',
        auxProviderID: 'opencode-go',
        auxModelID: 'glm-5.2',
      }),
      {
        providerPromptCache: true,
        auxProviderPromptCache: false,
        disabledPromptCacheModels: ['opencode-go/glm-5.2'],
        sharedProviderCacheDisabled: false,
      },
    );
  });

  it('defaults an omitted prompt-cache flag to enabled', () => {
    assert.deepEqual(
      resolvePromptCachePolicy({
        mainModel: 'openai/gpt-5.4-nano',
        mainProviderID: 'openai',
        mainModelID: 'gpt-5.4-nano',
        auxModel: 'openai/gpt-5.4-nano',
        auxProviderID: 'openai',
        auxModelID: 'gpt-5.4-nano',
      }),
      {
        providerPromptCache: true,
        auxProviderPromptCache: true,
        disabledPromptCacheModels: [],
        sharedProviderCacheDisabled: false,
      },
    );
  });

  it('honors the global prompt-cache off switch without reporting model support warnings', () => {
    assert.deepEqual(
      resolvePromptCachePolicy({
        promptCache: false,
        mainModel: 'openai/gpt-5.4-nano',
        mainProviderID: 'openai',
        mainModelID: 'gpt-5.4-nano',
        auxModel: 'opencode-go/glm-5.2',
        auxProviderID: 'opencode-go',
        auxModelID: 'glm-5.2',
      }),
      {
        providerPromptCache: false,
        auxProviderPromptCache: false,
        disabledPromptCacheModels: [],
        sharedProviderCacheDisabled: false,
      },
    );
  });
});
