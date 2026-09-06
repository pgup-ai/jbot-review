import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeOptions } from '../src/shared/runner.ts';
import {
  effectiveReasoningEffort,
  runConfiguration,
  runIdentity,
  roleTelemetry,
} from '../src/shared/run-telemetry.ts';

test('configuration fingerprints policy changes while excluding credentials and arbitrary model options', () => {
  const options = normalizeOptions({
    modelOptions: { reasoningEffort: 'medium', secret: 'secret-value' },
    auxApiKey: 'secret-value',
    auxBaseURL: 'https://private.example',
    shardCachePath: '/private/cache',
  });
  const first = runConfiguration(options, 'opencode/a', 'devin/b');
  assert.doesNotMatch(JSON.stringify(first), /secret-value|private/);
  assert.equal(
    first.configurationHash,
    runConfiguration(
      {
        ...options,
        auxApiKey: 'different',
        modelOptions: { reasoningEffort: 'medium', secret: 'different' },
      },
      'opencode/a',
      'devin/b',
    ).configurationHash,
  );
  assert.notEqual(
    first.configurationHash,
    runConfiguration({ ...options, contextTrim: true }, 'opencode/a', 'devin/b').configurationHash,
  );
  assert.notEqual(
    first.configurationHash,
    runConfiguration(
      { ...options, auxModelPool: ['devin/b', 'devin/b', 'opencode/a'] },
      'opencode/a',
      'devin/b',
    ).configurationHash,
  );
  assert.equal(
    runConfiguration({ ...options, sdkEngine: 'https://secret.example' }, 'opencode/a', 'devin/b')
      .configuration.sdkEngine,
    'unrecognized',
  );
});

test('attempt identity distinguishes reruns without confusing the reviewed SHA with the reviewer revision', () => {
  const identity = runIdentity({
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'review',
    GITHUB_SHA: 'reviewed-head',
    JBOT_IMAGE_VARIANT: 'slim',
    TOKEN: 'secret',
  });
  assert.deepEqual(identity, {
    reviewerRevision: 'unbundled',
    workflowRunId: '123',
    workflowRunAttempt: 2,
    workflowJob: 'review',
    imageVariant: 'slim',
  });
  assert.deepEqual(
    runIdentity({
      GITHUB_RUN_ID: 'https://private.example',
      GITHUB_RUN_ATTEMPT: 'token',
      GITHUB_JOB: 'secret/value',
      JBOT_IMAGE_VARIANT: 'unknown',
    }),
    { reviewerRevision: 'unbundled' },
  );
});

test('effective effort follows the backend contract rather than claiming every requested option was applied', () => {
  const ctx = {
    auxModel: 'commandcode/zai/glm-5.3-flash',
    mainModelOptions: { reasoningEffort: 'medium' },
    auxModelOptions: { reasoningEffort: 'low' },
    explicit: false,
  };
  assert.equal(
    effectiveReasoningEffort('commandcode', ctx.auxModel, ctx.auxModelOptions, ctx),
    undefined,
  );
  assert.equal(
    effectiveReasoningEffort('acp:devin', 'devin/a', ctx.mainModelOptions, ctx),
    undefined,
  );
  assert.equal(
    effectiveReasoningEffort('pi', 'opencode/a', { reasoningEffort: 'high' }, ctx),
    'high',
  );
  assert.equal(
    effectiveReasoningEffort('opencode', 'opencode/a', { reasoningEffort: 'default' }, ctx),
    undefined,
  );
  assert.equal(effectiveReasoningEffort('opencode', 'opencode/a', ctx.auxModelOptions, ctx), 'low');
  assert.equal(
    roleTelemetry({ name: 'commandcode' }, 'commandcode/a').workspaceAccess,
    'embedded-only',
  );
  assert.equal(
    roleTelemetry({ name: 'opencode', observability: 'enforceable' }, 'opencode/a').workspaceAccess,
    'read-only',
  );
  assert.equal(roleTelemetry(undefined, 'opencode/a', 'low').reasoningEffort, undefined);
  assert.equal(roleTelemetry(undefined, 'opencode/a').workspaceAccess, 'unavailable');
  for (const backend of ['opencode', 'pi']) {
    assert.equal(
      roleTelemetry({ name: backend }, 'opencode/a', 'high', 'verification').workspaceAccess,
      'embedded-only',
    );
  }
});
