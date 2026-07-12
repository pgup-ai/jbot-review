import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertQoderToken,
  buildQoderOptions,
  formatQoderPromptTimeoutMessage,
  isQoderProvider,
  mapQoderUsage,
  qoderEnvForHome,
  qoderModelID,
} from '../src/shared/qoder.ts';

describe('Qoder CLI provider helpers', () => {
  it('matches only the explicit qoder provider id', () => {
    assert.equal(isQoderProvider('qoder'), true);
    assert.equal(isQoderProvider('Qoder'), false);
    assert.equal(isQoderProvider(' qoder '), false);
  });

  it('maps the default model to auto and preserves explicit model tiers', () => {
    assert.equal(qoderModelID('qoder/default'), 'auto');
    assert.equal(qoderModelID('qoder/auto'), 'auto');
    assert.equal(qoderModelID('qoder/ultimate'), 'ultimate');
  });

  it('validates and trims the personal access token', () => {
    assert.equal(assertQoderToken('  qoder-token  '), 'qoder-token');
    assert.throws(() => assertQoderToken('   '), /Missing Qoder personal access token/);
  });

  it('isolates HOME without passing ambient credentials to the CLI', () => {
    const previous = process.env.QODER_PERSONAL_ACCESS_TOKEN;
    const previousOtherSecret = process.env.JBOT_TEST_OTHER_SECRET;
    try {
      process.env.QODER_PERSONAL_ACCESS_TOKEN = 'ambient-token';
      process.env.JBOT_TEST_OTHER_SECRET = 'other-secret';
      const env = qoderEnvForHome('/tmp/jbot-qoder-home');
      assert.equal(env.HOME, '/tmp/jbot-qoder-home');
      assert.equal(env.QODER_MEMORY, '0');
      assert.equal(env.QODER_MEMORY_USER, '0');
      assert.equal(env.QODER_PERSONAL_ACCESS_TOKEN, undefined);
      assert.equal(env.JBOT_TEST_OTHER_SECRET, undefined);
      assert.equal(env.PATH, process.env.PATH);
      assert.equal(process.env.QODER_PERSONAL_ACCESS_TOKEN, 'ambient-token');
    } finally {
      if (previous === undefined) delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
      else process.env.QODER_PERSONAL_ACCESS_TOKEN = previous;
      if (previousOtherSecret === undefined) delete process.env.JBOT_TEST_OTHER_SECRET;
      else process.env.JBOT_TEST_OTHER_SECRET = previousOtherSecret;
    }
  });

  it('builds a fail-closed read-only SDK session', () => {
    const options = buildQoderOptions(
      '/workspace',
      'qoder/performance',
      'qoder-token',
      '/tmp/jbot-qoder-home',
      new AbortController(),
    );
    assert.equal(options.model, 'performance');
    assert.equal(options.permissionMode, 'dontAsk');
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.tools, ['Read', 'Grep', 'Glob']);
    assert.equal(options.allowedTools, undefined);
    assert.equal(options.disallowedTools?.includes('Edit'), true);
    assert.equal(options.disallowedTools?.includes('Write'), true);
    assert.equal(options.disallowedTools?.includes('Bash'), true);
    assert.equal(options.disallowedTools?.includes('mcp__*'), true);

    const settings = options.settings as {
      disableAllHooks?: boolean;
      security?: { disableYoloMode?: boolean };
      permissions?: {
        deny?: string[];
        defaultMode?: string;
        disableBypassPermissionsMode?: string;
      };
      agentsMdExcludes?: string[];
      autoMemoryEnabled?: boolean;
      general?: { enableAutoUpdate?: boolean };
    };
    assert.equal(settings.disableAllHooks, true);
    assert.equal(settings.security?.disableYoloMode, true);
    assert.equal(settings.permissions?.defaultMode, 'dontAsk');
    assert.equal(settings.permissions?.disableBypassPermissionsMode, 'disable');
    assert.equal(settings.permissions?.deny?.includes('Write'), true);
    assert.deepEqual(settings.agentsMdExcludes, [
      '**/AGENTS.md',
      '**/AGENTS.local.md',
      '**/.qoder/rules/**',
    ]);
    assert.equal(settings.autoMemoryEnabled, false);
    assert.equal(settings.general?.enableAutoUpdate, false);
  });

  it('maps Qoder result usage into review telemetry', () => {
    assert.deepEqual(
      mapQoderUsage(
        {
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 40,
          },
          cache_creation_input_tokens: 40,
          cache_read_input_tokens: 30,
          inference_geo: '',
          input_tokens: 100,
          iterations: [],
          output_tokens: 20,
          server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
          service_tier: '',
          speed: '',
        },
        0.25,
      ),
      {
        input: 100,
        output: 20,
        reasoning: 0,
        cacheRead: 30,
        cacheWrite: 40,
        costUsd: 0.25,
      },
    );
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatQoderPromptTimeoutMessage('finding-verification', 'qoder/auto', 1200_000),
      'qoder finding-verification prompt timed out after 1200s (model=qoder/auto)',
    );
  });
});
