import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildKiloCliArgs,
  buildKiloPromptInput,
  isKiloProvider,
} from '../src/shared/kilo.ts';

describe('Kilo CLI provider helpers', () => {
  it('matches only the kilo provider id', () => {
    assert.equal(isKiloProvider('kilo'), true);
    assert.equal(isKiloProvider('Kilo'), false);
    assert.equal(isKiloProvider(' kilo '), false);
    assert.equal(isKiloProvider('kilocode'), false);
  });

  it('maps default to the free gateway model, gateway-prefixed', () => {
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/default' }), [
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
      '--model',
      'kilo/kilo-auto/free',
    ]);
  });

  it('preserves the kilo/ gateway prefix for explicit models', () => {
    // parseModelName strips the leading `kilo/`; buildKiloCliArgs must re-add it,
    // else the bare id 404s ("Model not found") — POC-observed.
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/kilo-auto/free' }).slice(-2), [
      '--model',
      'kilo/kilo-auto/free',
    ]);
    assert.deepEqual(buildKiloCliArgs({ model: 'kilo/anthropic/claude-opus-4.8' }).slice(-2), [
      '--model',
      'kilo/anthropic/claude-opus-4.8',
    ]);
  });

  it('never emits bypass flags (invariant #8)', () => {
    for (const model of ['kilo/default', 'kilo/kilo-auto/free']) {
      const args = buildKiloCliArgs({ model });
      assert.equal(args.includes('--auto'), false);
      assert.equal(args.includes('--dangerously-skip-permissions'), false);
      const agentIdx = args.indexOf('--agent');
      assert.equal(args[agentIdx + 1], 'plan');
    }
  });

  it('prepends the no-tools directive to the prompt input (avoids read-only stall)', () => {
    const input = buildKiloPromptInput('REVIEW BODY');
    assert.match(input, /Use no tools for this review/);
    assert.ok(input.endsWith('\n\nREVIEW BODY'));
  });
});
