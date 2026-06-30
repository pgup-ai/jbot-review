import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildClineCliArgs,
  CLINE_STRIPPED_ENV_KEYS,
  clineEnvForHome,
  clineProvidersPath,
  formatClinePromptTimeoutMessage,
  isClineProvider,
  parseClineFinalMessage,
  stripClineModelReasoning,
  writeClineAuth,
} from '../src/shared/cline.ts';

describe('Cline CLI provider helpers', () => {
  it('matches both cline billing-mode provider ids', () => {
    assert.equal(isClineProvider('cline'), true);
    assert.equal(isClineProvider('cline-pass'), true);
    assert.equal(isClineProvider('Cline'), false);
    assert.equal(isClineProvider(' cline '), false);
  });

  it('sets --provider to the billing mode and omits --model for default', () => {
    assert.deepEqual(buildClineCliArgs({ model: 'cline-pass/default' }), [
      '--json',
      '--plan',
      '--auto-approve',
      'false',
      '--provider',
      'cline-pass',
    ]);
    assert.deepEqual(buildClineCliArgs({ model: 'cline/default' }).slice(-2), [
      '--provider',
      'cline',
    ]);
  });

  it('builds --model as modelType/model per mode', () => {
    // cline-pass models are namespaced under the provider.
    assert.deepEqual(buildClineCliArgs({ model: 'cline-pass/glm-5.2' }).slice(-2), [
      '--model',
      'cline-pass/glm-5.2',
    ]);
    // pay-as-you-go cline models already carry their type.
    assert.deepEqual(buildClineCliArgs({ model: 'cline/deepseek/deepseek-v4-flash' }).slice(-2), [
      '--model',
      'deepseek/deepseek-v4-flash',
    ]);
  });

  it('never auto-approves tools or enables yolo (invariant #8)', () => {
    for (const model of ['cline/default', 'cline-pass/glm-5.2']) {
      const args = buildClineCliArgs({ model });
      assert.equal(args.includes('--yolo'), false);
      const approveIndex = args.indexOf('--auto-approve');
      assert.notEqual(approveIndex, -1);
      assert.equal(args[approveIndex + 1], 'false');
    }
  });

  it('strips model/reasoning but keeps the auth token', () => {
    const src = JSON.stringify({
      lastUsedProvider: 'cline-pass',
      providers: {
        'cline-pass': {
          settings: {
            provider: 'cline-pass',
            auth: { accessToken: 'tok' },
            model: 'x',
            reasoning: { effort: 'high' },
          },
        },
      },
    });
    const stripped = JSON.parse(stripClineModelReasoning(src));
    assert.equal(stripped.providers['cline-pass'].settings.model, undefined);
    assert.equal(stripped.providers['cline-pass'].settings.reasoning, undefined);
    assert.deepEqual(stripped.providers['cline-pass'].settings.auth, { accessToken: 'tok' });
    assert.equal(stripped.lastUsedProvider, 'cline-pass');
  });

  it('writes providers.json with 0600 perms, stripped to the auth token', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-cline-home-'));
    try {
      const auth = JSON.stringify({
        lastUsedProvider: 'cline-pass',
        providers: {
          'cline-pass': { settings: { auth: { accessToken: 'tok' }, model: 'x', reasoning: {} } },
        },
      });
      const path = writeClineAuth(auth, home);

      assert.equal(path, clineProvidersPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const written = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(written.providers['cline-pass'].settings.model, undefined);
      assert.equal(written.providers['cline-pass'].settings.reasoning, undefined);
      assert.deepEqual(written.providers['cline-pass'].settings.auth, { accessToken: 'tok' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a blank or non-JSON Cline secret', () => {
    assert.throws(() => writeClineAuth('   ', '/tmp/x'), /Missing Cline auth/);
    assert.throws(() => writeClineAuth('not json', '/tmp/x'), /Invalid CLINE_AUTH_JSON/);
  });

  it('sets HOME and strips every provider api-key env so carried auth wins', () => {
    const previous = new Map(CLINE_STRIPPED_ENV_KEYS.map((k) => [k, process.env[k]] as const));
    try {
      for (const key of CLINE_STRIPPED_ENV_KEYS) process.env[key] = `ambient-${key}`;

      const env = clineEnvForHome('/tmp/jbot-cline-home-test');

      assert.equal(env.HOME, '/tmp/jbot-cline-home-test');
      for (const key of CLINE_STRIPPED_ENV_KEYS) {
        assert.equal(env[key], undefined, `${key} must be stripped from the child env`);
        // The ambient process env must be left untouched.
        assert.equal(process.env[key], `ambient-${key}`, `${key} ambient env must be intact`);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects a blank Cline home', () => {
    assert.throws(() => clineEnvForHome('   '), /Missing Cline home/);
  });

  it('extracts the final message from the run_result NDJSON event', () => {
    const ndjson = [
      '{"type":"hook_event","event":{}}',
      '{"type":"agent_event","event":{"type":"content_start","text":"{\\"findings\\":[]}"}}',
      'not json — ignored',
      '{"type":"run_result","finishReason":"completed","text":"{\\"findings\\":[]}"}',
    ].join('\n');
    assert.equal(parseClineFinalMessage(ndjson), '{"findings":[]}');
  });

  it('returns empty when no run_result message is present', () => {
    assert.equal(parseClineFinalMessage('{"type":"agent_event","event":{}}'), '');
    assert.equal(parseClineFinalMessage('garbage\nlines'), '');
    assert.equal(parseClineFinalMessage('{"type":"run_result","text":""}'), '');
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatClinePromptTimeoutMessage('finding-verification', 'cline/default', 1200_000),
      'cline finding-verification prompt timed out after 1200s (model=cline/default)',
    );
  });
});
