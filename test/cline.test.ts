import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildClineCliArgs,
  clampGuidelinesForArgv,
  CLINE_STRIPPED_ENV_KEYS,
  clineEnvForHome,
  clineProvidersPath,
  formatClinePromptTimeoutMessage,
  isClineProvider,
  parseClineFinalMessage,
  writeClineAuth,
} from '../src/shared/cline.ts';

describe('Cline CLI provider helpers', () => {
  it('matches only the explicit cline provider id', () => {
    assert.equal(isClineProvider('cline'), true);
    assert.equal(isClineProvider('Cline'), false);
    assert.equal(isClineProvider(' cline '), false);
  });

  it('omits --model for the default Cline model and runs read-only', () => {
    assert.deepEqual(buildClineCliArgs({ model: 'cline/default' }), [
      '--json',
      '--plan',
      '--auto-approve',
      'false',
    ]);
  });

  it('passes explicit Cline model ids without the provider prefix', () => {
    assert.deepEqual(buildClineCliArgs({ model: 'cline/deepseek-v4-flash' }).slice(-2), [
      '--model',
      'deepseek-v4-flash',
    ]);
  });

  it('never auto-approves tools or enables yolo (invariant #8)', () => {
    for (const model of ['cline/default', 'cline/deepseek-v4-flash']) {
      const args = buildClineCliArgs({ model });
      assert.equal(args.includes('--yolo'), false);
      const approveIndex = args.indexOf('--auto-approve');
      assert.notEqual(approveIndex, -1);
      assert.equal(args[approveIndex + 1], 'false');
    }
  });

  it('writes providers.json from the raw JSON secret with 0600 perms', () => {
    const home = mkdtempSync(join(tmpdir(), 'jbot-cline-home-'));
    try {
      const auth = JSON.stringify({ lastUsedProvider: 'cline', providers: {} }, null, 2);
      const path = writeClineAuth(auth, home);

      assert.equal(path, clineProvidersPath(home));
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(auth));
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

  it('passes short guidelines through and caps long ones with an omission note', () => {
    assert.equal(clampGuidelinesForArgv('short rules', 1000), 'short rules');
    assert.equal(clampGuidelinesForArgv('', 1000), '');

    const long = Array.from({ length: 500 }, (_, i) => `guideline line ${i}`).join('\n');
    const capped = clampGuidelinesForArgv(long, 1024);
    assert.ok(Buffer.byteLength(capped, 'utf8') <= 1024);
    assert.match(capped, /omitted to fit/i);
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatClinePromptTimeoutMessage('finding-verification', 'cline/default', 1200_000),
      'cline finding-verification prompt timed out after 1200s (model=cline/default)',
    );
  });
});
