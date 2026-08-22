import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  abortOpencodeSessionsByLabel,
  buildConfig,
  observedAssistantParts,
  parseChangesSinceLastReviewSummary,
  recordOpencodeToolParts,
  sessionEnvDenyKeys,
  registerOpencodeSessionForAbort,
  takeOpencodeProxyEnv,
  type OpencodeClient,
} from '../src/shared/opencode.ts';
import { BASH_PERMISSIONS } from '../src/shared/shell-policy.ts';
import { createTelemetryRecorder } from '../src/shared/telemetry.ts';
import { createToolTelemetryAccumulator } from '../src/shared/tool-telemetry.ts';

const noop = () => {};

describe('OpenCode tool telemetry', () => {
  it('reads terminal SDK tool parts without retaining their input or output', () => {
    const recorder = createTelemetryRecorder(true);
    const telemetry = createToolTelemetryAccumulator(recorder, 'salt');
    recordOpencodeToolParts(telemetry, 'review', [
      {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: { path: 'secret.ts' },
          output: 'private source',
          time: { start: 10, end: 25 },
        },
      },
      {
        type: 'tool',
        tool: 'git_diff',
        state: {
          status: 'completed',
          input: {},
          output: 'private diff',
          time: { start: 20, end: 30 },
        },
      },
      { type: 'step-finish' },
    ] as never);

    const jsonl = recorder.toJsonl();
    assert.doesNotMatch(jsonl, /secret\.ts|private source|salt/);
    const rows = jsonl.split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.find((row) => row.kind === 'tool').durationMs, 15);
    assert.equal(
      rows.find((row) => row.kind === 'tool' && row.toolClass === 'diff-recovery').diffScope,
      'whole',
    );
    assert.equal(rows.find((row) => row.kind === 'exploration').turnCount, 1);

    const messages = [
      { info: { id: 'old' }, parts: [{ type: 'step-finish' }] },
      { info: { id: 'new' }, parts: [{ type: 'step-finish' }] },
    ] as never;
    assert.equal(observedAssistantParts(messages).length, 2);
    assert.equal(observedAssistantParts(messages, 'old').length, 1);
    assert.deepEqual(observedAssistantParts(messages, 'missing'), []);
  });
});

describe('parseChangesSinceLastReviewSummary', () => {
  it('extracts the summary string from a valid object', () => {
    const out = parseChangesSinceLastReviewSummary(
      '{"summary":"- did a thing"}',
      'changes-since',
      noop,
    );
    assert.equal(out, '- did a thing');
  });

  it('returns empty string on unparseable output (fail open, omit the block)', () => {
    const out = parseChangesSinceLastReviewSummary('not json at all', 'changes-since', noop);
    assert.equal(out, '');
  });

  it('returns empty string when summary is missing or not a string', () => {
    assert.equal(parseChangesSinceLastReviewSummary('{"findings":[]}', 'changes-since', noop), '');
    assert.equal(parseChangesSinceLastReviewSummary('{"summary":42}', 'changes-since', noop), '');
  });
});

describe('sessionEnvDenyKeys', () => {
  it('strips action inputs, GitHub tokens, and credential-suffixed vars — nothing else', () => {
    const keys = [
      'INPUT_GITHUB-TOKEN',
      'INPUT_MODEL',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'OPENROUTER_API_KEY',
      'KILO_AUTH_CONTENT',
      'CODEX_AUTH_JSON',
      'COMMANDCODE_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'APP_WEBHOOK_SECRET',
      'GITHUB_APP_PRIVATE_KEY',
      'SERVICE_PASSWORD',
      // Credential-bearing names that no fixed suffix list catches.
      'STRIPE_SECRET_KEY',
      'API_KEY',
      'DATABASE_DSN',
      'GCP_CREDENTIALS',
      'PATH',
      'HOME',
      'JBOT_OPENCODE_PORT',
      // Ends in a credential WORD only as a prefix — must survive.
      'TOKENIZERS_PARALLELISM',
      'KEYCHAIN_PATH',
    ];
    assert.deepEqual(sessionEnvDenyKeys(keys), [
      'INPUT_GITHUB-TOKEN',
      'INPUT_MODEL',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'OPENROUTER_API_KEY',
      'KILO_AUTH_CONTENT',
      'CODEX_AUTH_JSON',
      'COMMANDCODE_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'APP_WEBHOOK_SECRET',
      'GITHUB_APP_PRIVATE_KEY',
      'SERVICE_PASSWORD',
      'STRIPE_SECRET_KEY',
      'API_KEY',
      'DATABASE_DSN',
      'GCP_CREDENTIALS',
    ]);
  });
});

describe('takeOpencodeProxyEnv', () => {
  it('removes the internal values and returns only the OpenCode child environment', () => {
    const env = {
      JBOT_OPENCODE_HTTPS_PROXY: ' http://proxy.example:50100 ',
      JBOT_OPENCODE_NO_PROXY: ' localhost,127.0.0.1 ',
      PATH: '/bin',
    };
    assert.deepEqual(takeOpencodeProxyEnv(env), {
      HTTPS_PROXY: 'http://proxy.example:50100',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    assert.deepEqual(env, { PATH: '/bin' });
    const defaultBypass = { JBOT_OPENCODE_HTTPS_PROXY: 'http://proxy.example:50100' };
    assert.deepEqual(takeOpencodeProxyEnv(defaultBypass), {
      HTTPS_PROXY: 'http://proxy.example:50100',
      NO_PROXY: 'localhost,127.0.0.1',
    });
    assert.deepEqual(defaultBypass, {});
    assert.deepEqual(takeOpencodeProxyEnv({}), {});
  });
});

describe('grace-abandon session abort (TASK-076)', () => {
  it('aborts registered sessions by label and ignores unknown labels', async () => {
    const aborted: string[] = [];
    const client = {
      session: {
        abort: async ({ path }: { path: { id: string } }) => void aborted.push(path.id),
      },
    } as unknown as OpencodeClient;

    registerOpencodeSessionForAbort(client, 'guideline-compliance', 'sess-1');
    abortOpencodeSessionsByLabel(client, 'guideline-compliance', () => {});
    abortOpencodeSessionsByLabel(client, 'no-such-label', () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(aborted, ['sess-1']);
  });
});

describe('buildConfig bash permissions', () => {
  it('wires the shared accident filter into the session config', () => {
    const bash = buildConfig('deepseek', 'deepseek-v4-flash', 'key')?.permission?.bash;
    assert.deepEqual(bash, BASH_PERMISSIONS);
  });
});

describe('aux model options', () => {
  it('scopes a lower reasoning effort to the aux model alone', () => {
    // Same provider, different models: the aux entry exists only to carry its
    // own options, since the provider entry has no model-level scope for it.
    const config = buildConfig('opencode', 'main-model', 'k', { reasoningEffort: 'medium' }, true, [
      {
        providerID: 'opencode',
        apiKey: 'k',
        modelID: 'aux-model',
        modelOptions: { reasoningEffort: 'low' },
      },
    ]);
    const models = (config as { provider: Record<string, { models: Record<string, unknown> }> })
      .provider.opencode.models;

    assert.deepEqual(models, {
      'main-model': { options: { reasoningEffort: 'medium' } },
      'aux-model': { options: { reasoningEffort: 'low' } },
    });
  });

  it('clamps a rejected reasoning effort on the main and the aux entry alike', () => {
    // x-preview-f-free hard-400s on `medium`. The aux entry is assembled
    // outside buildProviderEntry, so it needs the same clamp (TASK-157): the
    // nearest supported tier reaches the provider, ties resolving upward.
    const aux = buildConfig('opencode', 'deepseek-v4-flash-free', 'k', undefined, true, [
      {
        providerID: 'opencode',
        apiKey: 'k',
        modelID: 'x-preview-f-free',
        modelOptions: { reasoningEffort: 'medium' },
      },
    ]);
    assert.deepEqual(
      (aux as { provider: Record<string, { models?: Record<string, unknown> }> }).provider.opencode
        .models,
      { 'x-preview-f-free': { options: { reasoningEffort: 'high' } } },
    );

    // The main entry is built by buildProviderEntry, which clamps the same way.
    const main = buildConfig(
      'opencode',
      'x-preview-f-free',
      'k',
      { reasoningEffort: 'medium' },
      true,
    );
    assert.deepEqual(
      (main as { provider: Record<string, { models?: Record<string, unknown> }> }).provider.opencode
        .models,
      { 'x-preview-f-free': { options: { reasoningEffort: 'high' } } },
    );

    // A supported effort passes through untouched.
    const kept = buildConfig('opencode', 'deepseek-v4-flash-free', 'k', undefined, true, [
      {
        providerID: 'opencode',
        apiKey: 'k',
        modelID: 'x-preview-f-free',
        modelOptions: { reasoningEffort: 'low' },
      },
    ]);
    assert.deepEqual(
      (kept as { provider: Record<string, { models: Record<string, unknown> }> }).provider.opencode
        .models,
      { 'x-preview-f-free': { options: { reasoningEffort: 'low' } } },
    );
  });

  it('registers a verifier alias entry carrying the floored effort (TASK-157)', () => {
    // Per-session model options don't exist in the opencode prompt API, so the
    // verifier's floored effort rides a config-time model alias whose `id`
    // points back at the real model (probe-verified against the live gateway).
    const config = buildConfig('opencode', 'main-model', 'k', { reasoningEffort: 'medium' }, true, [
      {
        providerID: 'opencode',
        apiKey: 'k',
        modelID: 'aux-model',
        modelOptions: { reasoningEffort: 'low' },
        verificationModelOptions: { reasoningEffort: 'medium' },
      },
    ]);
    const models = (config as { provider: Record<string, { models: Record<string, unknown> }> })
      .provider.opencode.models;
    assert.deepEqual(models, {
      'main-model': { options: { reasoningEffort: 'medium' } },
      'aux-model': { options: { reasoningEffort: 'low' } },
      'aux-model--jbot-verify': { id: 'aux-model', options: { reasoningEffort: 'medium' } },
    });

    // Root-entry variant: when the opencode server's root model IS the aux
    // model (main runs on another engine), the alias hangs off the root entry.
    const root = buildConfig(
      'opencode',
      'aux-model',
      'k',
      { reasoningEffort: 'low' },
      true,
      [],
      undefined,
      { reasoningEffort: 'medium' },
    );
    assert.deepEqual(
      (root as { provider: Record<string, { models: Record<string, unknown> }> }).provider.opencode
        .models,
      {
        'aux-model': { options: { reasoningEffort: 'low' } },
        'aux-model--jbot-verify': { id: 'aux-model', options: { reasoningEffort: 'medium' } },
      },
    );
  });

  it('adds no entry for a same-provider aux model with nothing of its own', () => {
    const config = buildConfig('opencode', 'main-model', 'k', undefined, true, [
      { providerID: 'opencode', apiKey: 'k', modelID: 'aux-model' },
    ]);
    const entry = (config as { provider: Record<string, { models?: unknown }> }).provider.opencode;

    assert.equal(entry.models, undefined);
  });
});
