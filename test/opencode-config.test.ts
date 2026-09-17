import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAIN_AGENT,
  PLAIN_AGENT,
  REVIEWER_AGENT,
  VERIFY_VARIANT,
  WRAPUP_AGENT,
  buildConfig,
  permissionRules,
  providerKeyVariables,
  sessionEnvironment,
} from '../src/shared/opencode-config.ts';

describe('permissionRules', () => {
  it('leads with the shell catch-all, denies edits, external directories and questions, never asks', () => {
    const rules = permissionRules();
    assert.deepEqual(rules[0], { action: 'shell', resource: '*', effect: 'allow' });
    assert.ok(
      rules.some((r) => r.action === 'shell' && r.resource === 'git commit*' && r.effect === 'deny'),
    );
    assert.deepEqual(rules.slice(-3), [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '*', effect: 'deny' },
      { action: 'question', resource: '*', effect: 'deny' },
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
    assert.equal(config.plugins, undefined);
    assert.deepEqual(
      Object.keys(config.agents).sort(),
      [PLAIN_AGENT, REVIEWER_AGENT, WRAPUP_AGENT].sort(),
    );
    assert.deepEqual(config.agents[WRAPUP_AGENT].permissions, [
      { action: '*', resource: '*', effect: 'deny' },
    ]);
    assert.equal(config.agents[REVIEWER_AGENT].system, 'Review only.');
    assert.equal(config.providers, undefined);
    assert.equal(MAIN_AGENT, 'plan');
  });

  it('writes main options as model settings and verifier options as the jbot-verify variant', () => {
    const config = buildConfig({
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
    assert.deepEqual(config.providers, {
      openai: {
        settings: { setCacheKey: true },
        models: {
          'gpt-5': {
            settings: { reasoningEffort: 'medium' },
            variants: [{ id: VERIFY_VARIANT, settings: { reasoningEffort: 'low' } }],
          },
        },
      },
    });
  });

  it('emits a full custom provider entry with the key in config', () => {
    const config = buildConfig({
      models: [
        {
          providerID: 'openai-compatible',
          modelID: 'm1',
          apiKey: 'secret',
          baseURL: 'https://llm.example/v1',
          promptCache: false,
        },
      ],
      reviewerSystem: 's',
    });
    assert.deepEqual(config.providers['openai-compatible'], {
      name: 'OpenAI Compatible',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'https://llm.example/v1', apiKey: 'secret' },
      models: {
        m1: {
          name: 'm1',
          modelID: 'm1',
          capabilities: { tools: true, input: ['text'], output: ['text'] },
          limit: { context: 200_000, output: 32_000 },
        },
      },
    });
  });

  it('rejects a custom provider without a base URL', () => {
    assert.throws(
      () =>
        buildConfig({
          models: [
            { providerID: 'openai-compatible', modelID: 'm1', apiKey: 'k', promptCache: false },
          ],
          reviewerSystem: 's',
        }),
      /base URL/,
    );
  });

  it('merges a second model of the same provider instead of replacing it', () => {
    const config = buildConfig({
      models: [
        {
          providerID: 'openai',
          modelID: 'gpt-5',
          apiKey: 'k',
          promptCache: false,
          modelOptions: { reasoningEffort: 'high' },
        },
        {
          providerID: 'openai',
          modelID: 'gpt-5-mini',
          apiKey: 'k',
          promptCache: false,
          modelOptions: { reasoningEffort: 'low' },
        },
      ],
      reviewerSystem: 's',
    });
    assert.deepEqual(Object.keys(config.providers.openai.models), ['gpt-5', 'gpt-5-mini']);
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
  });

  it('rejects two providers that share an env var with different keys', () => {
    assert.throws(
      () =>
        providerKeyVariables([
          { providerID: 'opencode', apiKey: 'a' },
          { providerID: 'opencode-go', apiKey: 'b' },
        ]),
      /OPENCODE_API_KEY/,
    );
  });

  it('names an unknown provider instead of booting a server that cannot see its key', () => {
    assert.throws(() => providerKeyVariables([{ providerID: 'nope', apiKey: 'a' }]), /"nope"/);
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
    });
    assert.deepEqual(env, { PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'j' });
  });
});
