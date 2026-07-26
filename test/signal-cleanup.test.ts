import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { onFatalSignal } from '../src/shared/signal-cleanup.ts';

describe('onFatalSignal', () => {
  it('shares one listener per signal and removes it once the last cleanup deregisters', () => {
    const before = process.listenerCount('SIGINT');

    const first = onFatalSignal(() => {});
    assert.equal(process.listenerCount('SIGINT'), before + 1);
    assert.equal(process.listenerCount('SIGTERM'), before + 1);

    // A second registration must not stack another listener, or the first
    // handler to re-raise would cancel the others.
    const second = onFatalSignal(() => {});
    assert.equal(process.listenerCount('SIGINT'), before + 1);

    first();
    assert.equal(process.listenerCount('SIGINT'), before + 1, 'still one cleanup outstanding');

    second();
    assert.equal(process.listenerCount('SIGINT'), before);
    assert.equal(process.listenerCount('SIGHUP'), before);
  });
});
