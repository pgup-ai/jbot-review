import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROVIDERS,
  modelSupportsPromptCache,
  resolvePromptCachePolicy,
} from '../src/shared/config.ts';
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

  it('resolves Devin CLI model ids against the devin provider', () => {
    assert.deepEqual(resolveModelName('devin', 'glm-5.2'), {
      providerID: 'devin',
      modelID: 'glm-5.2',
    });
  });

  it('resolves CommandCode CLI model ids against the commandcode provider', () => {
    assert.deepEqual(resolveModelName('commandcode', 'Qwen/Qwen3.7-Max'), {
      providerID: 'commandcode',
      modelID: 'Qwen/Qwen3.7-Max',
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
      models: {
        'glm-5': { promptCache: false },
        'glm-5.1': { promptCache: false },
        'glm-5.2': { promptCache: false },
      },
    });
  });

  it('configures Gemini with the direct Gemini key surface', () => {
    assert.deepEqual(PROVIDERS.google, {
      defaultModel: 'google/gemini-2.5-flash',
      keyEnv: 'GEMINI_API_KEY',
      keyInput: 'gemini-api-key',
    });
  });

  it('configures Devin with the Windsurf key surface', () => {
    assert.deepEqual(PROVIDERS.devin, {
      defaultModel: 'devin/default',
      keyEnv: 'DEVIN_WINDSURF_API_KEY',
      keyInput: 'devin-windsurf-api-key',
      models: {
        default: { promptCache: false },
      },
    });
  });

  it('configures CommandCode with the CLI access-key surface', () => {
    assert.deepEqual(PROVIDERS.commandcode, {
      defaultModel: 'commandcode/default',
      keyEnv: 'COMMANDCODE_ACCESS_KEY',
      keyInput: 'commandcode-access-key',
      models: {
        default: { promptCache: false },
      },
    });
  });

  it('configures Grok Build separately from the xAI API provider', () => {
    assert.deepEqual(PROVIDERS.grok, {
      defaultModel: 'grok/default',
      keyEnv: 'GROK_AUTH_JSON',
      keyInput: 'grok-auth',
      models: {
        default: { promptCache: false },
      },
    });
    assert.equal(PROVIDERS.xai.keyEnv, 'XAI_API_KEY');
    assert.equal(PROVIDERS.xai.keyInput, 'xai-api-key');
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
    assert.equal(modelSupportsPromptCache('zai-coding-plan', 'glm-5.2'), false);
    assert.equal(modelSupportsPromptCache('opencode-go', 'deepseek-v4-flash'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'kimi-k2.6'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'minimax-m3'), true);
    assert.equal(modelSupportsPromptCache('opencode-go', 'qwen3.6-plus'), true);
    assert.equal(modelSupportsPromptCache('devin', 'default'), false);
    assert.equal(modelSupportsPromptCache('devin', 'codex'), false);
    assert.equal(modelSupportsPromptCache('commandcode', 'default'), false);
    assert.equal(modelSupportsPromptCache('commandcode', 'Qwen/Qwen3.7-Max'), false);
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
