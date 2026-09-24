import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  PROVIDERS,
  auxModelOptionsFor,
  clampReasoningEffort,
  credentialSecretValues,
  defaultModelOptions,
  modelSupportsPromptCache,
  supportedModelOptions,
  needsAuxOpencodeConfig,
  providerConfig,
  providerCredentialSources,
  providerSessionConcurrency,
  resolvePoolCredentials,
  resolveProviderBaseURL,
  resolveProviderCredential,
  verificationModelOptions,
  resolvePromptCachePolicy,
} from '../src/shared/config.ts';
import { buildConfig } from '../src/shared/opencode-config.ts';

describe('tokenrouter (native Models.dev provider)', () => {
  it('registers the router with no custom def and prompt caching off', () => {
    const p = PROVIDERS['tokenrouter'];
    assert.equal(p.defaultModel, 'tokenrouter/z-ai/glm-5.3-free');
    assert.equal(p.keyEnv, 'TOKENROUTER_API_KEY');
    assert.equal(p.keyInput, 'tokenrouter-api-key');
    // V2's catalog lacks the router, so it is a custom endpoint with a default base URL.
    assert.equal(p.custom?.baseURL.default, 'https://api.tokenrouter.com/v1');
    // The router is unverified for opencode's promptCacheKey.
    assert.equal(modelSupportsPromptCache('tokenrouter', 'z-ai/glm-5.3-free'), false);
  });

  it('emits a custom entry carrying the key and clamps efforts to the glm-5.3 ladder', () => {
    const config = buildConfig({
      models: [
        {
          providerID: 'tokenrouter',
          modelID: 'z-ai/glm-5.3-free',
          apiKey: 'tr-abc',
          baseURL: 'https://api.tokenrouter.com/v1',
          promptCache: false,
        },
      ],
      reviewerSystem: 's',
    });
    const entry = config.providers.tokenrouter;
    assert.equal(entry.settings.apiKey, 'tr-abc');
    assert.equal(entry.settings.baseURL, 'https://api.tokenrouter.com/v1');
    assert.equal('setCacheKey' in entry.settings, false, 'prompt cache off for this provider');
    // The default main effort `medium` is off the declared ladder; `-free`
    // normalizes to the bare model key and the tie resolves upward.
    assert.deepEqual(
      supportedModelOptions('tokenrouter', 'z-ai/glm-5.3-free', { reasoningEffort: 'medium' }),
      { reasoningEffort: 'high' },
    );
  });
});

describe('xiaomi-token-plan-sgp (native Models.dev provider)', () => {
  it('registers the Singapore Token Plan provider with no custom def', () => {
    const p = PROVIDERS['xiaomi-token-plan-sgp'];
    assert.equal(p.defaultModel, 'xiaomi-token-plan-sgp/mimo-v2.5-pro');
    assert.equal(p.keyEnv, 'MIMO_API_KEY');
    assert.equal(p.keyInput, 'mimo-api-key');
    // Models.dev supplies the base URL + model catalog; we pin only the key.
    assert.equal('custom' in p, false);
  });

  it('disables prompt caching for mimo (unverified endpoint), keeps it for other providers', () => {
    assert.equal(modelSupportsPromptCache('xiaomi-token-plan-sgp', 'mimo-v2.5-pro'), false);
    assert.equal(modelSupportsPromptCache('openai', 'gpt-5.4-nano'), true);
    // Either Zen route, and `-free` normalizes to the bare key.
    assert.equal(modelSupportsPromptCache('opencode', 'glm-5-free'), false);
  });

  it('clamps a reasoning effort the model would reject to the nearest tier', () => {
    // The provider 400s non-retryably on unsupported efforts; ties resolve UP
    // so a ladder without `medium` cannot quietly reinstate a lower tier.
    assert.deepEqual(
      supportedModelOptions('opencode', 'x-preview-f-free', { reasoningEffort: 'medium' }),
      { reasoningEffort: 'high' },
    );
    assert.deepEqual(
      supportedModelOptions('opencode-go', 'x-preview-f', { reasoningEffort: 'medium' }),
      { reasoningEffort: 'high' },
    );
    assert.deepEqual(
      supportedModelOptions('opencode-go', 'ox-alpha-free', { reasoningEffort: 'medium' }),
      { reasoningEffort: 'high' },
    );
    assert.deepEqual(
      supportedModelOptions('opencode-go', 'omen-alpha', { reasoningEffort: 'medium' }),
      { reasoningEffort: 'high' },
    );
    assert.deepEqual(
      supportedModelOptions('nvidia', 'moonshotai/kimi-k3', { reasoningEffort: 'medium' }),
      { reasoningEffort: 'high' },
    );
    // mimo collapses below medium (probed 2026-08-22): the aux default `low`
    // must clamp up on every delivery path, the pi aux level included.
    assert.deepEqual(
      supportedModelOptions('opencode', 'mimo-v2.5-free', { reasoningEffort: 'low' }),
      { reasoningEffort: 'medium' },
    );
    assert.deepEqual(
      supportedModelOptions('opencode', 'x-preview-f-free', {
        reasoningEffort: 'high',
        temperature: 0,
      }),
      { reasoningEffort: 'high', temperature: 0 },
    );
    // Provider-managed values (poolside's 'default') stay outside the order and drop.
    assert.deepEqual(
      supportedModelOptions('opencode', 'x-preview-f-free', {
        reasoningEffort: 'default',
        temperature: 0,
      }),
      { temperature: 0 },
    );
    // Models without a declared list keep whatever they were given.
    assert.deepEqual(
      supportedModelOptions('openai', 'gpt-5.4-nano', { reasoningEffort: 'medium' }),
      {
        reasoningEffort: 'medium',
      },
    );
    assert.equal(supportedModelOptions('opencode', 'x-preview-f-free', undefined), undefined);
  });

  it('clamps out-of-range efforts to the ladder end and ignores unrankable ladder entries', () => {
    assert.equal(clampReasoningEffort('minimal', ['low', 'high', 'max']), 'low');
    assert.equal(clampReasoningEffort('max', ['minimal', 'low']), 'low');
    assert.equal(clampReasoningEffort('medium', ['low', 'high', 'max']), 'high');
    assert.equal(clampReasoningEffort('medium', ['low', 'high', 'max'], 'down'), 'low');
    assert.equal(clampReasoningEffort('medium', ['high', 'max'], 'down'), 'high');
    assert.equal(clampReasoningEffort('high', ['low', 'high']), 'high');
    // Unrankable entries can't be chosen; an all-unrankable ladder means no clamp.
    assert.equal(clampReasoningEffort('medium', ['low', 'turbo']), 'low');
    assert.equal(clampReasoningEffort('medium', ['default']), undefined);
    assert.equal(clampReasoningEffort('default', ['low', 'high']), undefined);
    // pi's xhigh is rankable (between high and max), so an xhigh finder gets a
    // high verifier and an xhigh request clamps upward on ladders without it.
    assert.deepEqual(
      verificationModelOptions({ reasoningEffort: 'xhigh' }, { reasoningEffort: 'low' }),
      { reasoningEffort: 'high' },
    );
    assert.equal(clampReasoningEffort('xhigh', ['low', 'high', 'max']), 'max');
  });
});

describe('verification effort: one tier below the finder', () => {
  it('steps the verifier one tier down from the main effort, never below low', () => {
    // Aux already sits one below: identity, so no alias entry is built.
    const low = { reasoningEffort: 'low' };
    assert.equal(verificationModelOptions({ reasoningEffort: 'medium' }, low), low);
    // Aux shares the main entry: the verifier gets its own lowered options.
    assert.deepEqual(verificationModelOptions({ reasoningEffort: 'medium' }, undefined), low);
    assert.equal(verificationModelOptions({ reasoningEffort: 'low' }, undefined), undefined);
    assert.deepEqual(verificationModelOptions({ reasoningEffort: 'high' }, low), {
      reasoningEffort: 'medium',
    });
    assert.deepEqual(
      verificationModelOptions({ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }),
      low,
    );
    assert.deepEqual(verificationModelOptions({ reasoningEffort: 'minimal' }, low), {
      reasoningEffort: 'minimal',
    });
    // Custom providers carry no effort; the aux entry rides unchanged.
    assert.equal(verificationModelOptions({}, low), low);
    // Provider-managed efforts ('default') sit outside the order on either side.
    assert.equal(verificationModelOptions({ reasoningEffort: 'default' }, low), low);
    const managed = { reasoningEffort: 'default' };
    assert.equal(verificationModelOptions({ reasoningEffort: 'medium' }, managed), managed);
    // Effort-less aux entries stay effort-less: custom providers ({}) omit the
    // key BY POLICY — arbitrary endpoints may reject provider-specific options.
    const bare = { temperature: 0 };
    assert.equal(verificationModelOptions({ reasoningEffort: 'medium' }, bare), bare);
    const empty = {};
    assert.equal(verificationModelOptions({ reasoningEffort: 'medium' }, empty), empty);
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
    assert.deepEqual(defaultModelOptions('poolside', 'laguna-s-2.1'), {
      reasoningEffort: 'default',
    });
  });
});

describe('provider credentials', () => {
  it('expands key lists for redaction without shredding JSON auth blobs', () => {
    // Exact-match redaction only ever sees what it is handed, so a list must
    // yield the individual keys too.
    assert.deepEqual(credentialSecretValues('oc_sk_aaaaaaaaaaaaaaaa,oc_sk_bbbbbbbbbbbbbbbb'), [
      'oc_sk_aaaaaaaaaaaaaaaa,oc_sk_bbbbbbbbbbbbbbbb',
      'oc_sk_aaaaaaaaaaaaaaaa',
      'oc_sk_bbbbbbbbbbbbbbbb',
    ]);
    // A lone key that the selectors would strip is registered in its used form.
    assert.deepEqual(credentialSecretValues('oc_sk_aaaaaaaaaaaaaaaa,'), [
      'oc_sk_aaaaaaaaaaaaaaaa,',
      'oc_sk_aaaaaaaaaaaaaaaa',
    ]);
    // A trailing comma still expands: the selectors drop empty segments too.
    assert.deepEqual(credentialSecretValues('oc_sk_aaaaaaaaaaaaaaaa,oc_sk_bbbbbbbbbbbbbbbb,'), [
      'oc_sk_aaaaaaaaaaaaaaaa,oc_sk_bbbbbbbbbbbbbbbb,',
      'oc_sk_aaaaaaaaaaaaaaaa',
      'oc_sk_bbbbbbbbbbbbbbbb',
    ]);
    assert.deepEqual(credentialSecretValues(' key-with-spaces-around , second-key-value '), [
      ' key-with-spaces-around , second-key-value ',
      'key-with-spaces-around',
      'second-key-value',
    ]);
    // A comma inside a JSON blob, a short fragment, or a base URL must not
    // become a mask pattern: masking `"type"` would redact ordinary log text.
    for (const value of [
      '{"type":"oauth","token":"aaaaaaaaaaaaaaaaaaaa"}',
      'oc_sk_aaaaaaaaaaaaaaaa,short',
      ',,',
      'https://proxy.example/v1,https://other.example/v1',
      'single-key-value-long-enough',
    ]) {
      assert.deepEqual(credentialSecretValues(value), [value]);
    }
  });

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

  it('resolves provider-owned session caps independently', () => {
    assert.equal(providerSessionConcurrency('openai'), undefined);
    assert.equal(providerSessionConcurrency('nvidia'), 1);
    assert.equal(providerSessionConcurrency('devin'), undefined);
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

  it('exposes SDK routing as an Action input and preserves the env fallback', () => {
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

describe('Kimi For Coding (native Models.dev providers)', () => {
  it('shares one key surface across both sign-up domains, each on its own K3', () => {
    for (const providerID of ['kimi-code-plan-global', 'kimi-code-plan-cn']) {
      assert.deepEqual(PROVIDERS[providerID], {
        defaultModel: `${providerID}/k3`,
        keyEnv: 'KIMI_API_KEY',
        keyInput: 'kimi-api-key',
        promptCache: false,
      });
    }
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
    assert.deepEqual(defaultModelOptions('openai-compatible', 'x'), {});
    for (const providerID of ['openai', 'tokenrouter', 'opencode', 'commandcode']) {
      assert.deepEqual(defaultModelOptions(providerID, 'm'), { reasoningEffort: 'low' });
    }
    for (const providerID of ['opencode', 'opencode-go'])
      assert.deepEqual(defaultModelOptions(providerID, 'space-bunny-free'), {
        reasoningEffort: 'high',
      });
    assert.deepEqual(auxModelOptionsFor('opencode', 'm', 'opencode', 'space-bunny-free'), {
      reasoningEffort: 'high',
    });
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
    const config = buildConfig({
      models: [
        {
          providerID: 'openai-compatible',
          modelID: 'served-model',
          apiKey: 'proxy-key',
          baseURL: 'https://proxy.example/v1',
          promptCache: false,
          modelOptions: { temperature: 0 },
        },
      ],
      reviewerSystem: 's',
    });
    const entry = config.providers['openai-compatible'];
    assert.equal(entry.name, 'OpenAI Compatible');
    assert.equal(entry.package, '@opencode/ai/providers/openai-compatible');
    assert.equal(entry.settings.apiKey, 'proxy-key');
    assert.equal(entry.settings.baseURL, 'https://proxy.example/v1');
    assert.equal('setCacheKey' in entry.settings, false);
    assert.equal(entry.models['served-model'].modelID, 'served-model');
    assert.equal('settings' in entry.models['served-model'], false, 'options go per session');
  });

  it('embeds a custom provider selected only for auxiliary sessions', () => {
    const config = buildConfig({
      models: [
        { providerID: 'openai', modelID: 'gpt-5', apiKey: 'openai-key', promptCache: true },
        {
          providerID: 'openai-compatible',
          modelID: 'aux-model',
          apiKey: 'aux-key',
          baseURL: 'https://aux.example/v1',
          promptCache: false,
        },
      ],
      reviewerSystem: 's',
    });
    const entry = config.providers['openai-compatible'];
    assert.equal(entry.settings.apiKey, 'aux-key');
    assert.equal(entry.settings.baseURL, 'https://aux.example/v1');
    assert.equal('setCacheKey' in entry.settings, false);
    assert.deepEqual(Object.keys(entry.models), ['aux-model']);
    assert.deepEqual(config.providers.openai, { settings: { setCacheKey: true } });
  });
  it('registers distinct main and auxiliary models on the same custom endpoint', () => {
    const config = buildConfig({
      models: [
        {
          providerID: 'openai-compatible',
          modelID: 'main-model',
          apiKey: 'proxy-key',
          baseURL: 'https://proxy.example/v1',
          promptCache: false,
          modelOptions: { temperature: 0 },
        },
        {
          providerID: 'openai-compatible',
          modelID: 'aux-model',
          apiKey: 'proxy-key',
          baseURL: 'https://proxy.example/v1',
          promptCache: false,
        },
      ],
      reviewerSystem: 's',
    });
    const models = config.providers['openai-compatible'].models;
    assert.deepEqual(Object.keys(models), ['main-model', 'aux-model']);
  });

  it('rejects incomplete custom entries before starting OpenCode', () => {
    assert.throws(
      () =>
        buildConfig({
          models: [
            {
              providerID: 'openai-compatible',
              modelID: 'model',
              apiKey: 'key',
              promptCache: false,
            },
          ],
          reviewerSystem: 's',
        }),
      /Missing base URL for custom provider/,
    );
    assert.throws(
      () =>
        buildConfig({
          models: [
            {
              providerID: 'openai-compatible',
              modelID: '',
              apiKey: 'aux-key',
              baseURL: 'https://aux.example/v1',
              promptCache: false,
            },
          ],
          reviewerSystem: 's',
        }),
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

  it('requires local keys only for providers that do not route to the gateway', () => {
    const names = ['JBOT_ACP_GATEWAY_URL', 'JBOT_ACP_GATEWAY_TOKEN', 'JBOT_ACP_GATEWAY_ENDPOINT'];
    const previous = names.map((name) => process.env[name]);
    process.env.JBOT_ACP_GATEWAY_URL = 'https://gateway.example';
    try {
      delete process.env.JBOT_ACP_GATEWAY_TOKEN;
      delete process.env.JBOT_ACP_GATEWAY_ENDPOINT;
      assert.doesNotThrow(() => resolvePoolCredentials(['deepseek/e'], keys(['DEEPSEEK_API_KEY'])));
      assert.throws(
        () => resolvePoolCredentials(['cursor/a'], keys([])),
        /also set JBOT_ACP_GATEWAY_TOKEN and JBOT_ACP_GATEWAY_ENDPOINT/,
      );
      process.env.JBOT_ACP_GATEWAY_TOKEN = 'test-token';
      assert.throws(
        () => resolvePoolCredentials(['cursor/a'], keys([])),
        /also set JBOT_ACP_GATEWAY_ENDPOINT/,
      );
      process.env.JBOT_ACP_GATEWAY_ENDPOINT = 'test-endpoint';
      const credentials = resolvePoolCredentials(
        ['cursor/a', 'codex/b', 'kilo/c', 'devin/d', 'deepseek/e'],
        keys(['DEEPSEEK_API_KEY']),
      );
      for (const provider of ['cursor', 'codex', 'kilo', 'devin']) {
        assert.deepEqual(credentials.get(provider), { apiKey: '' });
      }
      assert.throws(() => resolvePoolCredentials(['deepseek/e'], keys([])), /Missing key/);
      delete process.env.JBOT_ACP_GATEWAY_URL;
      assert.throws(() => resolvePoolCredentials(['cursor/a'], keys([])), /Missing key/);
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
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

describe('resolvePromptCachePolicy', () => {
  it('scopes the cache diagnostics to the roles the opencode server actually serves', () => {
    const input = {
      promptCache: true,
      mainModel: 'commandcode/meta/muse-spark-1.3-contributor',
      mainProviderID: 'commandcode',
      mainModelID: 'meta/muse-spark-1.3-contributor',
      auxModel: 'opencode/muse-spark-1.3-contributor-free',
      auxProviderID: 'opencode',
      auxModelID: 'muse-spark-1.3-contributor-free',
    };
    assert.deepEqual(resolvePromptCachePolicy(input).disabledPromptCacheModels, [
      'commandcode/meta/muse-spark-1.3-contributor',
    ]);
    // The CLI talks to its own gateway; opencode's promptCacheKey never reaches it.
    assert.deepEqual(
      resolvePromptCachePolicy({ ...input, servedByOpencode: (role) => role !== 'main' })
        .disabledPromptCacheModels,
      [],
    );
    // Same provider, but the aux model runs elsewhere (pi): the server still
    // caches for main, and nothing is disabled for the provider on aux's behalf.
    const split = {
      promptCache: true,
      mainModel: 'opencode/big-pickle',
      mainProviderID: 'opencode',
      mainModelID: 'big-pickle',
      auxModel: 'opencode/glm-5.2',
      auxProviderID: 'opencode',
      auxModelID: 'glm-5.2',
    };
    assert.equal(resolvePromptCachePolicy(split).sharedProviderCacheDisabled, true);
    const auxOnPi = resolvePromptCachePolicy({
      ...split,
      servedByOpencode: (role) => role === 'main',
    });
    assert.equal(auxOnPi.providerPromptCache, true);
    assert.equal(auxOnPi.sharedProviderCacheDisabled, false);
    assert.deepEqual(auxOnPi.disabledPromptCacheModels, []);
  });
});
