import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  PROVIDERS,
  auxModelOptionsFor,
  defaultModelOptions,
  modelSupportsPromptCache,
  needsAuxOpencodeConfig,
  providerConfig,
  providerCredentialSources,
  resolvePoolCredentials,
  resolveProviderBaseURL,
  resolveProviderCredential,
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

describe('poolside', () => {
  it('registers the unlisted Laguna S 2.1 model with provider-default reasoning', () => {
    const provider = PROVIDERS.poolside;
    assert.equal(provider.defaultModel, 'poolside/laguna-s-2.1');
    assert.equal(provider.keyEnv, 'POOLSIDE_API_KEY');
    assert.equal(provider.keyInput, 'poolside-api-key');
    assert.equal(provider.custom, undefined);
    assert.deepEqual(provider.models?.['laguna-s-2.1'], { promptCache: false });
    assert.equal(modelSupportsPromptCache('poolside', 'laguna-s-2.1'), false);
    assert.deepEqual(defaultModelOptions('poolside'), { reasoningEffort: 'default' });
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

describe('provider configuration resolution', () => {
  it('looks providers up by id and names the model an unknown id came from', () => {
    assert.equal(providerConfig('openai'), PROVIDERS.openai);
    assert.throws(() => providerConfig('nope'), /Unknown provider "nope"\. Supported: opencode/);
    assert.throws(
      () => providerConfig('nope', 'nope/m'),
      /Unknown provider "nope" derived from model "nope\/m"/,
    );
  });

  it('rejects malformed base URLs as non-absolute', () => {
    assert.throws(
      () => resolveProviderBaseURL('openai-compatible', PROVIDERS['openai-compatible'], () => 'x'),
      /expected an absolute URL/,
    );
  });

  it('leaves Action model options unset for provider-aware defaults', () => {
    const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    const input = action.split('\n  model-options:\n')[1]?.split('\n  prompt-cache:\n')[0];

    assert.ok(input);
    assert.doesNotMatch(input, /^\s+default:/m);
  });

  it('exposes SDK routing as an Action input without masking the env fallback', () => {
    const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    const workflow = readFileSync(
      new URL('../.github/workflows/jbot-review.yml', import.meta.url),
      'utf8',
    );
    const input = action.split('\n  sdk-engine:\n')[1]?.split('\n  opencode-api-key:\n')[0];

    assert.ok(input);
    assert.match(input, /default: ''/);
    assert.match(action, /INPUT_SDK-ENGINE: \$\{\{ inputs\.sdk-engine \}\}/);
    assert.match(workflow, /sdk-engine: \$\{\{ vars\.JBOT_SDK_ENGINE \|\| '' \}\}/);
  });

  it('keeps auto approval off unless the Action input is explicitly enabled', () => {
    const action = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    const workflow = readFileSync(
      new URL('../.github/workflows/jbot-review.yml', import.meta.url),
      'utf8',
    );
    const input = action.split('\n  auto-approve:\n')[1]?.split('\n  max-findings:\n')[0];

    assert.ok(input);
    assert.match(input, /default: 'false'/);
    assert.match(action, /INPUT_AUTO-APPROVE: \$\{\{ inputs\.auto-approve \}\}/);
    assert.match(workflow, /auto_approve: \$\{\{ steps\.cmd\.outputs\.auto_approve \}\}/);
    assert.match(
      workflow,
      /auto-approve: \$\{\{ needs\.command\.outputs\.auto_approve \|\| vars\.JBOT_AUTO_APPROVE \|\| 'false' \}\}/,
    );
  });

  it('gives the aux model its own options unless it shares the main entry', () => {
    // Identity is provider-scoped: same id on another provider is routed
    // separately, so it still needs its own effort.
    assert.equal(auxModelOptionsFor('openai', 'gpt-5', 'openai', 'gpt-5'), undefined);
    assert.deepEqual(auxModelOptionsFor('openai', 'gpt-5', 'openai', 'gpt-5-mini'), {
      reasoningEffort: 'low',
    });
    assert.deepEqual(auxModelOptionsFor('openai', 'gpt-5', 'openrouter', 'gpt-5'), {
      reasoningEffort: 'low',
    });
    // Provider guards still apply to the aux default.
    assert.deepEqual(auxModelOptionsFor('openai', 'm', 'poolside', 'laguna-s-2.1'), {
      reasoningEffort: 'default',
    });
    assert.deepEqual(auxModelOptionsFor('openai', 'm', 'openai-compatible', 'x'), {});
  });

  it('registers cross-provider config and distinct models on a shared custom provider', () => {
    assert.equal(needsAuxOpencodeConfig('openai', 'gpt-5', 'openrouter', 'gpt-5'), true);
    assert.equal(
      needsAuxOpencodeConfig('openai-compatible', 'main', 'openai-compatible', 'aux'),
      true,
    );
    assert.equal(needsAuxOpencodeConfig('openai', 'gpt-5', 'openai', 'gpt-5-mini'), false);
    assert.equal(
      needsAuxOpencodeConfig('openai-compatible', 'main', 'openai-compatible', 'main'),
      false,
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
    assert.deepEqual(defaultModelOptions('openai-compatible'), {});
    assert.deepEqual(defaultModelOptions('openai'), { reasoningEffort: 'medium' });
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

  it('registers distinct main and auxiliary models on the same custom endpoint', () => {
    const config = buildConfig(
      'openai-compatible',
      'main-model',
      'proxy-key',
      { temperature: 0 },
      false,
      [
        {
          providerID: 'openai-compatible',
          modelID: 'aux-model',
          apiKey: 'proxy-key',
          baseURL: 'https://proxy.example/v1',
          promptCache: false,
        },
      ],
      'https://proxy.example/v1',
    );
    const entry = providerEntry(config, 'openai-compatible');

    assert.deepEqual(entry.models, {
      'main-model': { name: 'main-model', options: { temperature: 0 } },
      'aux-model': { name: 'aux-model' },
    });
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

describe('resolvePoolCredentials', () => {
  const keys =
    (present: string[]) =>
    ({ env }: { env: string }) =>
      present.includes(env) ? `${env}-value` : undefined;

  it('resolves one credential per provider a mixed pool draws on', () => {
    const credentials = resolvePoolCredentials(
      ['opencode/a', 'opencode/b', 'deepseek/c'],
      keys(['OPENCODE_API_KEY', 'DEEPSEEK_API_KEY']),
    );

    assert.deepEqual([...credentials.keys()], ['opencode', 'deepseek']);
    assert.equal(credentials.get('deepseek')?.apiKey, 'DEEPSEEK_API_KEY-value');
    // Only providers with a custom endpoint carry one.
    assert.equal(credentials.get('opencode')?.baseURL, undefined);
  });

  it('names the provider, the model that required it, and how to set it', () => {
    assert.throws(
      () => resolvePoolCredentials(['opencode/a', 'deepseek/c'], keys(['OPENCODE_API_KEY'])),
      /Missing key for provider "deepseek", required by pooled model "deepseek\/c"\. Pass "deepseek-api-key" or DEEPSEEK_API_KEY\./,
    );
  });

  it('appends a caller hint, so local review can say no GitHub token is needed', () => {
    assert.throws(
      () => resolvePoolCredentials(['deepseek/c'], keys([]), ' Set it in .env.'),
      /DEEPSEEK_API_KEY\. Set it in \.env\./,
    );
  });

  it("carries a custom provider's base URL, and rejects a missing one", () => {
    const custom = keys(['JBOT_OPENAI_COMPATIBLE_API_KEY', 'JBOT_OPENAI_COMPATIBLE_BASE_URL']);
    assert.equal(
      resolvePoolCredentials(['openai-compatible/m'], ({ env }) =>
        env === 'JBOT_OPENAI_COMPATIBLE_BASE_URL' ? 'https://proxy.example/v1' : custom({ env }),
      ).get('openai-compatible')?.baseURL,
      'https://proxy.example/v1',
    );
    assert.throws(
      () =>
        resolvePoolCredentials(['openai-compatible/m'], keys(['JBOT_OPENAI_COMPATIBLE_API_KEY'])),
      /Missing base URL for provider "openai-compatible"/,
    );
  });
});
