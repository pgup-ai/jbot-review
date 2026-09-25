import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliBackendForProvider } from '../src/shared/backend-selection.ts';
import { PROVIDERS } from '../src/shared/config.ts';
import { isPoolsideProvider } from '../src/shared/poolside.ts';
import {
  CLOSED_BOOK_AGENT,
  PLAIN_AGENT,
  REVIEWER_AGENT,
  VERIFY_AGENT,
  WRAPUP_AGENT,
  buildConfig,
  modelOptionsByModel,
  permissionRules,
  providerKeyVariables,
  sessionEnvironment,
  sessionModelOptions,
} from '../src/shared/opencode-config.ts';

describe('permissionRules', () => {
  it('leads with the shell catch-all, denies edits, external directories, questions and skills, never asks', () => {
    const rules = permissionRules();
    assert.deepEqual(rules[0], { action: 'shell', resource: '*', effect: 'allow' });
    assert.ok(
      rules.some(
        (r) => r.action === 'shell' && r.resource === 'git commit*' && r.effect === 'deny',
      ),
    );
    assert.deepEqual(rules.slice(-5), [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'deny' },
      { action: 'question', resource: '*', effect: 'deny' },
      { action: 'subagent', resource: '*', effect: 'deny' },
      { action: 'skill', resource: '*', effect: 'deny' },
    ]);
    assert.ok(
      rules.every((r) => r.effect !== 'ask'),
      'a headless run must never ask',
    );
  });
});

describe('buildConfig', () => {
  it('defines the jbot agents and no providers for a catalog model without options', () => {
    const config = buildConfig({
      models: [{ providerID: 'openai', modelID: 'gpt-5', apiKey: 'k', promptCache: false }],
      reviewerSystem: 'Review only.',
    });
    assert.equal(config.$schema, 'https://opencode.ai/config.json');
    assert.deepEqual(
      Object.keys(config.agents).sort(),
      [CLOSED_BOOK_AGENT, PLAIN_AGENT, REVIEWER_AGENT, VERIFY_AGENT, WRAPUP_AGENT].sort(),
    );
    // Closed-book keeps the tool list a gateway checks for; the plugin denies each call.
    for (const agent of [WRAPUP_AGENT, CLOSED_BOOK_AGENT])
      assert.deepEqual(config.agents[agent].permissions, permissionRules());
    assert.deepEqual(config.agents[PLAIN_AGENT].permissions, [
      { action: '*', resource: '*', effect: 'deny' },
    ]);
    assert.equal(config.agents[REVIEWER_AGENT].system, 'Review only.');
    assert.deepEqual(
      [config.agents[VERIFY_AGENT].system, config.agents[VERIFY_AGENT].steps],
      ['Review only.', 6],
    );
    assert.equal(config.providers, undefined);
    const cached = buildConfig({
      models: [
        {
          providerID: 'openai',
          modelID: 'gpt-5',
          apiKey: 'k',
          promptCache: true,
          modelOptions: { reasoningEffort: 'medium' },
          verificationModelOptions: { reasoningEffort: 'low' },
        },
      ],
      reviewerSystem: 's',
    });
    // options never go through config: they travel per session
    assert.deepEqual(cached.providers, { openai: { settings: { setCacheKey: true } } });
  });
});

describe('modelOptionsByModel', () => {
  it('keys supported options by model and tier; a session falls back to the main tier', () => {
    const byModel = modelOptionsByModel([
      {
        providerID: 'openai',
        modelID: 'gpt-5',
        apiKey: 'k',
        promptCache: false,
        modelOptions: { reasoningEffort: 'medium' },
        verificationModelOptions: { reasoningEffort: 'low' },
      },
      {
        providerID: 'openai',
        modelID: 'gpt-5-mini',
        apiKey: 'k',
        promptCache: false,
        modelOptions: { reasoningEffort: 'high' },
      },
      { providerID: 'opencode', modelID: 'mimo-v2.5-free', apiKey: 'k', promptCache: false },
      {
        providerID: 'opencode',
        modelID: 'x-preview-f-free',
        apiKey: 'k',
        promptCache: false,
        modelOptions: { reasoningEffort: 'medium' },
        verificationModelOptions: { reasoningEffort: 'medium' },
      },
    ]);
    assert.deepEqual(byModel, {
      'openai/gpt-5': { main: { reasoningEffort: 'medium' }, verify: { reasoningEffort: 'low' } },
      'openai/gpt-5-mini': { main: { reasoningEffort: 'high' } },
      // low/high/max ladder: the finder rounds up, the verifier down
      'opencode/x-preview-f-free': {
        main: { reasoningEffort: 'high' },
        verify: { reasoningEffort: 'low' },
      },
    });
    assert.deepEqual(sessionModelOptions(byModel, 'openai/gpt-5', 'verify'), {
      reasoningEffort: 'low',
    });
    assert.deepEqual(sessionModelOptions(byModel, 'openai/gpt-5-mini', 'verify'), {
      reasoningEffort: 'high',
    });
    assert.equal(sessionModelOptions(byModel, 'opencode/mimo-v2.5-free', 'main'), undefined);
  });
});

describe('providerKeyVariables', () => {
  it('maps catalog providers to the env var V2 reads and skips custom providers', () => {
    assert.deepEqual(
      providerKeyVariables([
        { providerID: 'openai', apiKey: 'a' },
        { providerID: 'zai-coding-plan', apiKey: 'b' },
        { providerID: 'openai-compatible', apiKey: 'c' },
      ]),
      { OPENAI_API_KEY: 'a', ZHIPU_API_KEY: 'b' },
    );
    assert.throws(
      () =>
        providerKeyVariables([
          { providerID: 'opencode', apiKey: 'a' },
          { providerID: 'opencode-go', apiKey: 'b' },
        ]),
      /OPENCODE_API_KEY/,
    );
  });
});

describe('providerKeyVariables coverage', () => {
  it('knows the key env var of every provider the opencode engine can serve', () => {
    const served = Object.keys(PROVIDERS).filter(
      (id) => !PROVIDERS[id]?.custom && !cliBackendForProvider(id) && !isPoolsideProvider(id),
    );
    assert.ok(served.length > 0);
    assert.doesNotThrow(() =>
      providerKeyVariables(served.map((providerID) => ({ providerID, apiKey: 'k' }))),
    );
  });
});

describe('sessionEnvironment', () => {
  it('keeps only the allowlist and git identity', () => {
    const env = sessionEnvironment({
      PATH: '/bin',
      HOME: '/h',
      GIT_AUTHOR_NAME: 'j',
      OPENAI_API_KEY: 'leak',
      OPENCODE_CONFIG_CONTENT: '{}',
      INPUT_GITHUB_TOKEN: 'leak',
      HTTPS_PROXY: 'http://user:secret@proxy.local:3128',
      https_proxy: 'http://user:secret@proxy.local:3128',
    });
    assert.deepEqual(env, {
      PATH: '/bin',
      HOME: '/h',
      GIT_AUTHOR_NAME: 'j',
      HTTPS_PROXY: 'http://proxy.local:3128',
      https_proxy: 'http://proxy.local:3128',
    });
  });
});
