import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROVIDERS,
  modelSupportsPromptCache,
  resolvePromptCachePolicy,
} from '../src/shared/config.ts';
import { parseModelName } from '@symma/protocol';
import {
  pickAuxModel,
  pickReviewModels,
  removedAuxInputWarnings,
  pickPooledModel,
  resolveModelSelection,
} from '../src/shared/model.ts';

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
    assert.deepEqual(resolveModelSelection('kilo/zai/glm-5.2'), ['kilo/zai/glm-5.2']);
    assert.deepEqual(resolveModelSelection('devin/glm-5.2'), ['devin/glm-5.2']);
  });

  it('resolves a comma-separated pool of same-provider refs', () => {
    assert.deepEqual(resolveModelSelection(' opencode/a , opencode/b/c ,, opencode/d '), [
      'opencode/a',
      'opencode/b/c',
      'opencode/d',
    ]);
  });

  it('accepts a pool that spans providers', () => {
    // One candidate runs per PR and each provider carries its own credential,
    // so a pool has no reason to be single-provider.
    assert.deepEqual(resolveModelSelection('opencode/a, devin/b, deepseek/c'), [
      'opencode/a',
      'devin/b',
      'deepseek/c',
    ]);
    // An unqualified candidate still takes the default provider.
    assert.deepEqual(resolveModelSelection('devin/glm-5.2, glm-5.2'), [
      'devin/glm-5.2',
      'opencode/glm-5.2',
    ]);
  });

  it('names the offending model when the derived provider is unknown', () => {
    assert.throws(
      () => resolveModelSelection('moonshotai/kimi-k2.6'),
      /Unknown provider "moonshotai" derived from model "moonshotai\/kimi-k2\.6"/,
    );
  });

  it('falls back to the default provider for a ref that names none', () => {
    assert.deepEqual(resolveModelSelection('deepseek-v4-flash-free'), [
      'opencode/deepseek-v4-flash-free',
    ]);
  });

  it('uses the provider catalog default when no model is given', () => {
    assert.deepEqual(resolveModelSelection(), ['opencode/deepseek-v4-flash-free']);
    assert.deepEqual(resolveModelSelection('', 'devin'), ['devin/default']);
    assert.throws(
      () => resolveModelSelection('', 'openai-compatible'),
      /Missing model for provider "openai-compatible"/,
    );
  });

  it('rejects malformed refs on both the derived and pinned paths', () => {
    assert.throws(() => resolveModelSelection('opencode/'), /expected "provider\/model"/);
    assert.throws(() => resolveModelSelection(' , '), /expected at least one model/);
    // A pin must not absorb a leading slash into the model id as `opencode//x`.
    assert.throws(() => resolveModelSelection('/deepseek'), /a non-empty model id/);
    assert.throws(() => resolveModelSelection('/deepseek', 'opencode'), /a non-empty model id/);
    assert.throws(() => resolveModelSelection('opencode/', 'opencode'), /a non-empty model id/);
  });

  it('leaves every configured provider default naming its own provider', () => {
    for (const cfg of Object.values(PROVIDERS)) {
      if (!cfg.defaultModel) continue;
      assert.deepEqual(resolveModelSelection(cfg.defaultModel), [cfg.defaultModel]);
    }
  });
});

describe('resolveModelSelection with a legacy provider input', () => {
  it('pins the provider and absorbs one matching prefix', () => {
    assert.deepEqual(resolveModelSelection('deepseek-v4-flash-free, opencode/b', 'opencode'), [
      'opencode/deepseek-v4-flash-free',
      'opencode/b',
    ]);
  });

  it('keeps a non-matching slash prefix inside the model id', () => {
    // Catalog ids carry publisher prefixes; a pin stops them reading as providers.
    assert.deepEqual(resolveModelSelection('moonshotai/kimi-k2.6', 'nvidia'), [
      'nvidia/moonshotai/kimi-k2.6',
    ]);
  });

  it('rejects an unknown pinned provider', () => {
    assert.throws(() => resolveModelSelection('a', 'nope'), /Unknown provider "nope"\. Supported:/);
  });
});

describe('pickPooledModel', () => {
  it('picks a stable first entry, advances on later attempts, and spreads across seeds', () => {
    const pool = ['opencode/a', 'opencode/b', 'opencode/c'];
    const seed = 'e3f0c1a9b7d24e6f8a0b1c2d3e4f5a6b7c8d9e0f';
    const first = pickPooledModel(pool, seed);

    assert.equal(first, 'opencode/b');
    assert.equal(first, pickPooledModel(pool, seed, 1));
    assert.equal(pickPooledModel(pool, seed, 2), 'opencode/c');
    assert.equal(pickPooledModel(pool, seed, pool.length + 1), first);
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

describe('removedAuxInputWarnings', () => {
  it('warns per removed input that a config still sets', () => {
    const set = (inputs: Record<string, string>) => (input: string) => inputs[input] ?? '';
    assert.deepEqual(removedAuxInputWarnings(set({})), []);
    assert.deepEqual(removedAuxInputWarnings(set({ 'aux-model': 'openai/gpt-5' })), [
      '`aux-model` was removed and is ignored: both roles draw from `model`.',
    ]);
    assert.equal(
      removedAuxInputWarnings(set({ 'aux-model': 'a', 'aux-provider': 'openai' })).length,
      2,
    );
  });
});

describe('pickReviewModels', () => {
  it('draws both roles from one pool, salting the aux pick', () => {
    const pool = ['openai/gpt-5', 'google/gemini-2.5-flash', 'opencode/glm-5.2'];
    const seed = 'head-sha';
    assert.deepEqual(pickReviewModels(pool, seed), {
      model: pickPooledModel(pool, seed),
      auxModel: pickAuxModel(pool, seed),
    });
    // Retries advance the main pick past a failing candidate; aux fails open, so it holds.
    assert.equal(pickReviewModels(pool, seed, 2).model, pickPooledModel(pool, seed, 2));
    assert.equal(pickReviewModels(pool, seed, 2).auxModel, pickAuxModel(pool, seed));
    // One entry leaves nothing to differ on: aux shares the main model, and its effort.
    assert.deepEqual(pickReviewModels(['openai/gpt-5'], seed), {
      model: 'openai/gpt-5',
      auxModel: 'openai/gpt-5',
    });
  });
});

describe('pickAuxModel', () => {
  it('salts the seed so an aux pool is not locked to the main pool index', () => {
    const pool = ['opencode/a', 'opencode/b', 'opencode/c'];
    // A seed the salt actually moves: on a third of seeds both land together,
    // and those cannot tell a salted pick from an unsalted one.
    const seed = 'deadbeef';

    assert.equal(pickAuxModel(pool, seed), pickPooledModel(pool, `aux:${seed}`));
    assert.notEqual(pickAuxModel(pool, seed), pickPooledModel(pool, seed));
    assert.equal(pickAuxModel([], seed), '');
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
