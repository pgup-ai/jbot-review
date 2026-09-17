import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLAIN_AGENT,
  REVIEWER_AGENT,
  WRAPUP_AGENT,
  buildConfig,
  modelOptionsByModel,
  permissionRules,
  providerKeyVariables,
  sessionEnvironment,
  sessionModelOptions,
} from '../src/shared/opencode-config.ts';

describe('permissionRules', () => {
  it('leads with the shell catch-all, denies edits, external directories and questions, never asks', () => {
    const rules = permissionRules();
    assert.deepEqual(rules[0], { action: 'shell', resource: '*', effect: 'allow' });
    assert.ok(
      rules.some(
        (r) => r.action === 'shell' && r.resource === 'git commit*' && r.effect === 'deny',
      ),
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
    assert.deepEqual(
      Object.keys(config.agents).sort(),
      [PLAIN_AGENT, REVIEWER_AGENT, WRAPUP_AGENT].sort(),
    );
    assert.deepEqual(config.agents[WRAPUP_AGENT].permissions, [
      { action: '*', resource: '*', effect: 'deny' },
    ]);
    assert.equal(config.agents[REVIEWER_AGENT].system, 'Review only.');
    assert.equal(config.providers, undefined);
  });

  it('keeps a catalog provider to its cache setting; options never go through config', () => {
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
    assert.deepEqual(config.providers, { openai: { settings: { setCacheKey: true } } });
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
