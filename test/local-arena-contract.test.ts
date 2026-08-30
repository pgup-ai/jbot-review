import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateArenaUsage,
  arenaArtifactName,
  classifyJbotArenaFailure,
  emptyArenaUsage,
  parseArenaAuthJson,
  parseComparisonManifestJson,
  sanitizeArenaFailureMessage,
  selectArenaModel,
  validateComparisonManifest,
  validateJbotArenaOutput,
  type ComparisonManifestV1,
  type JbotArenaOutputV1,
} from '../src/local/arena-contract.ts';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const JBOT_SHA = '3'.repeat(40);
const IMAGE_DIGEST = `sha256:${'4'.repeat(64)}`;

function manifest(): ComparisonManifestV1 {
  const models = ['openrouter/openai/gpt-oss:free', 'kilo/zai/glm-5.2'].map((model, index) => ({
    index,
    model,
    provider: model.split('/')[0]!,
    artifactName: arenaArtifactName(index, model),
  }));
  return {
    schemaVersion: 1,
    comparisonId: 'pgup-ai/jbot-arena:pr-1:comment-99',
    arena: {
      repository: 'pgup-ai/jbot-arena',
      prNumber: 1,
      commandCommentId: 99,
      workflowRunId: 123,
      runAttempt: 1,
    },
    target: {
      url: 'https://github.com/acme/widget/pull/7',
      owner: 'acme',
      repository: 'widget',
      prNumber: 7,
      title: 'Target title',
      body: 'Target body',
      base: {
        repository: 'acme/widget',
        cloneUrl: 'https://github.com/acme/widget.git',
        ref: 'main',
        sha: BASE_SHA,
      },
      head: {
        repository: 'contributor/widget',
        cloneUrl: 'https://github.com/contributor/widget.git',
        ref: 'feature',
        sha: HEAD_SHA,
      },
    },
    jbot: {
      imageRef: 'ghcr.io/pgup-ai/jbot-review:latest',
      imageDigest: IMAGE_DIGEST,
    },
    reviewConfig: {
      enhancedContext: true,
      dryRun: true,
      autoApprove: false,
      maxFindings: 0,
      minSeverity: 'nit',
      includePriorComments: false,
      context7Mode: 'auto',
      guidelinePass: true,
      shardCache: false,
      scrubSessionEnv: true,
      auxModelMode: 'same-as-main',
      sdkEngine: 'auto',
      reviewPasses: 1,
      verifyFindings: true,
      timeBudgetMinutes: 30,
      reviewShards: 0,
      dynamicFanout: true,
      modelOptions: null,
      promptCache: true,
      skipDocOnly: true,
      maxConcurrentSessions: 3,
      reviewTelemetry: true,
      evidenceQuotes: true,
      contextTrim: false,
      embeddedFirstPrompt: true,
      guidelineWiden: 'auto',
      verifierSlimContext: false,
      verifyOverlapGrace: false,
    },
    models,
  };
}

function completedOutput(): JbotArenaOutputV1 {
  return {
    schemaVersion: 1,
    status: 'completed',
    backend: 'opencode',
    sdkEngine: 'opencode',
    resolvedModelOptions: { reasoningEffort: 'medium' },
    reviewMs: 1234,
    usage: emptyArenaUsage(),
    review: {
      summary: 'Summary',
      findings: [
        {
          path: 'src/a.ts',
          line: 3,
          severity: 'P2',
          kind: 'bug',
          confidence: 'high',
          title: 'Finding',
          body: 'Body',
          evidence: 'line',
        },
      ],
    },
    failure: null,
  };
}

describe('comparison manifest validation', () => {
  it('accepts the complete v1 contract, including a fork head', () => {
    assert.deepEqual(validateComparisonManifest(manifest()), manifest());
    const legacy = manifest();
    const parsedLegacy = validateComparisonManifest({
      ...legacy,
      jbot: {
        commitSha: JBOT_SHA,
        imageRef: `ghcr.io/pgup-ai/jbot-review:${JBOT_SHA}`,
        imageDigest: legacy.jbot.imageDigest,
      },
    });
    assert.equal(parsedLegacy.jbot.imageRef, `ghcr.io/pgup-ai/jbot-review:${JBOT_SHA}`);
    assert.ok(!('commitSha' in parsedLegacy.jbot));
  });

  it('rejects incompatible identity, immutable refs, fixed config, and model artifacts', () => {
    const cases: Array<[string, (value: ComparisonManifestV1) => void, RegExp]> = [
      ['schema', (value) => Object.assign(value, { schemaVersion: 2 }), /schemaVersion/],
      ['comparison id', (value) => (value.comparisonId = 'wrong'), /comparisonId/],
      ['target URL', (value) => (value.target.url += '?x=1'), /canonical public GitHub PR URL/],
      [
        'base repository',
        (value) => {
          value.target.base.repository = 'other/repository';
          value.target.base.cloneUrl = 'https://github.com/other/repository.git';
        },
        /base\.repository must match/,
      ],
      ['base SHA', (value) => (value.target.base.sha = 'ABC'), /40-character SHA/],
      ['clone URL', (value) => (value.target.head.cloneUrl = 'git@example:x/y'), /canonical/],
      ['write mode', (value) => Object.assign(value.reviewConfig, { dryRun: false }), /dryRun/],
      [
        'SDK engine',
        (value) => Object.assign(value.reviewConfig, { sdkEngine: 'pi' }),
        /sdkEngine/,
      ],
      ['index', (value) => (value.models[1]!.index = 3), /models\[1\]\.index/],
      ['provider', (value) => (value.models[0]!.provider = 'kilo'), /provider/],
      ['artifact', (value) => (value.models[0]!.artifactName = '../unsafe'), /artifactName/],
      [
        'image ref',
        (value) =>
          Object.assign(value.jbot, {
            commitSha: JBOT_SHA,
            imageRef: `ghcr.io/attacker/image:${JBOT_SHA}`,
          }),
        /canonical J-Bot image/,
      ],
      [
        'duplicate',
        (value) => {
          value.models[1]!.model = value.models[0]!.model;
          value.models[1]!.provider = value.models[0]!.provider;
          value.models[1]!.artifactName = arenaArtifactName(1, value.models[1]!.model);
        },
        /unique/,
      ],
    ];
    for (const [label, mutate, expected] of cases) {
      const value = structuredClone(manifest());
      mutate(value);
      assert.throws(() => validateComparisonManifest(value), expected, label);
    }
  });

  it('bounds the JSON context and target prose before use', () => {
    assert.throws(() => parseComparisonManifestJson('x'.repeat(256 * 1024 + 1)), /exceeds/);
    assert.throws(() => parseComparisonManifestJson('{bad'), /Could not parse/);
    const value = manifest();
    value.target.body = '😀'.repeat(20_000);
    assert.throws(() => validateComparisonManifest(value), /target.body exceeds/);
  });

  it('requires one selected model that exists in the manifest', () => {
    const value = manifest();
    assert.equal(selectArenaModel(value, [value.models[1]!.model]).index, 1);
    assert.throws(() => selectArenaModel(value, []), /exactly one/);
    assert.throws(
      () =>
        selectArenaModel(
          value,
          value.models.map(({ model }) => model),
        ),
      /exactly one/,
    );
    assert.throws(() => selectArenaModel(value, ['openrouter/not-requested']), /not present/);
  });
});

describe('arena auth bundle', () => {
  it('accepts future credential names and rejects malformed entries', () => {
    assert.deepEqual(
      parseArenaAuthJson(
        '{"NVIDIA_API_KEY":"key","FUTURE_PROVIDER_TOKEN":"token","_INTERNAL_TOKEN":"unused"}',
      ),
      { NVIDIA_API_KEY: 'key', FUTURE_PROVIDER_TOKEN: 'token', _INTERNAL_TOKEN: 'unused' },
    );
    assert.throws(() => parseArenaAuthJson('{'), /valid JSON/);
    assert.throws(() => parseArenaAuthJson('[]'), /must be an object/);
    assert.throws(() => parseArenaAuthJson('{"github_token":"token"}'), /invalid entry/);
  });
});

describe('arena telemetry aggregation', () => {
  it('tracks session and metric completeness, preferring provider cost', () => {
    const telemetry = [
      JSON.stringify({ kind: 'phase', scope: 'session', phase: 'main-execution' }),
      JSON.stringify({
        kind: 'session',
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.25,
        estimatedCostUsd: 9,
      }),
      JSON.stringify({ kind: 'phase', scope: 'session', phase: 'auxiliary-execution' }),
      JSON.stringify({
        kind: 'session',
        inputTokens: 20,
        reasoningTokens: 8,
        cacheReadTokens: 7,
        estimatedCostUsd: 0.1,
      }),
      JSON.stringify({ kind: 'phase', scope: 'session', phase: 'auxiliary-execution' }),
      JSON.stringify({ kind: 'finding', inputTokens: 999 }),
      '{bad json',
    ].join('\n');
    assert.deepEqual(aggregateArenaUsage(telemetry), {
      sessions: 3,
      inputTokens: { value: 30, reportingSessions: 2 },
      outputTokens: { value: 4, reportingSessions: 1 },
      reasoningTokens: { value: 8, reportingSessions: 1 },
      cacheReadTokens: { value: 7, reportingSessions: 1 },
      cost: { usd: 0.35, source: 'mixed', reportingSessions: 2 },
    });
    assert.deepEqual(aggregateArenaUsage(undefined), emptyArenaUsage());
  });
});

describe('J-Bot arena output', () => {
  it('validates status-specific review/failure invariants', () => {
    assert.deepEqual(validateJbotArenaOutput(completedOutput()), completedOutput());
    assert.throws(
      () => validateJbotArenaOutput({ ...completedOutput(), status: 'skipped' }),
      /Skipped arena output/,
    );
    assert.deepEqual(
      validateJbotArenaOutput({
        ...completedOutput(),
        status: 'failed',
        backend: null,
        sdkEngine: null,
        resolvedModelOptions: null,
        reviewMs: null,
        review: null,
        failure: { class: 'provider', message: 'rate limited' },
      }).status,
      'failed',
    );
  });

  it('classifies failures and scrubs bounded one-line messages', () => {
    assert.equal(classifyJbotArenaFailure(new Error('request timed out')), 'timeout');
    assert.equal(classifyJbotArenaFailure(new Error('invalid JSON schema')), 'parse');
    assert.equal(classifyJbotArenaFailure(new Error('HTTP 429 rate limit')), 'provider');
    assert.equal(classifyJbotArenaFailure(new Error('boom')), 'unknown');
    const secret = 'super-secret-value';
    const sanitized = sanitizeArenaFailureMessage(
      new Error(
        `Bearer bearer-token Basic basic-token\nurl=https://user:pass@example.com?q=1&api_key=query-key token=plain-token password: plain-password secret=${secret} {"credential":"json-secret"} ${'😀'.repeat(200)}`,
      ),
      [secret],
    );
    assert.doesNotMatch(
      sanitized,
      /bearer-token|basic-token|user:pass|query-key|plain-token|plain-password|super-secret-value|json-secret/,
    );
    assert.doesNotMatch(sanitized, /[\r\n]/);
    assert.ok(Buffer.byteLength(sanitized, 'utf8') <= 512);
  });
});
