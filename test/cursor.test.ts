import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCursorCliArgs,
  cursorEnvForKey,
  formatCursorPromptTimeoutMessage,
  isCursorProvider,
} from '../src/shared/cursor.ts';

describe('Cursor CLI provider helpers', () => {
  it('matches only the explicit cursor provider id', () => {
    assert.equal(isCursorProvider('cursor'), true);
    assert.equal(isCursorProvider('Cursor'), false);
    assert.equal(isCursorProvider(' cursor '), false);
  });

  it('omits --model for the default Cursor model', () => {
    assert.deepEqual(buildCursorCliArgs({ model: 'cursor/default' }), [
      '-p',
      '--output-format',
      'text',
      '--trust',
      '--mode',
      'plan',
    ]);
  });

  it('passes explicit Cursor model ids without the provider prefix', () => {
    assert.deepEqual(buildCursorCliArgs({ model: 'cursor/gpt-5' }), [
      '-p',
      '--output-format',
      'text',
      '--trust',
      '--mode',
      'plan',
      '--model',
      'gpt-5',
    ]);
  });

  it('passes a parameterized Cursor model id through verbatim', () => {
    assert.deepEqual(
      buildCursorCliArgs({ model: 'cursor/claude-opus-4-8[context=1m,effort=high]' }),
      [
        '-p',
        '--output-format',
        'text',
        '--trust',
        '--mode',
        'plan',
        '--model',
        'claude-opus-4-8[context=1m,effort=high]',
      ],
    );
  });

  it('always runs read-only and never force-allows write/shell tools', () => {
    // Invariant #8: the review must never mutate the workspace. `--mode plan`
    // is Cursor's read-only mode; `--force`/`--yolo`/`-f` would defeat it.
    for (const model of ['cursor/default', 'cursor/sonnet-4-thinking']) {
      const args = buildCursorCliArgs({ model });
      assert.equal(args.includes('--force'), false);
      assert.equal(args.includes('--yolo'), false);
      assert.equal(args.includes('-f'), false);
      const modeIndex = args.indexOf('--mode');
      assert.notEqual(modeIndex, -1);
      assert.equal(args[modeIndex + 1], 'plan');
    }
  });

  it('injects the key into the child env and overrides ambient state', () => {
    const previousKey = process.env.CURSOR_API_KEY;
    try {
      process.env.CURSOR_API_KEY = 'ambient-stale-key';
      const env = cursorEnvForKey('  cursor-real-key  ');
      assert.equal(env.CURSOR_API_KEY, 'cursor-real-key');
      assert.equal(env.NO_OPEN_BROWSER, '1');
      // The ambient process env must be left untouched.
      assert.equal(process.env.CURSOR_API_KEY, 'ambient-stale-key');
    } finally {
      if (previousKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousKey;
    }
  });

  it('rejects a blank Cursor API key', () => {
    assert.throws(() => cursorEnvForKey('   '), /Missing Cursor API key/);
  });

  it('labels prompt timeouts with the session and model', () => {
    assert.equal(
      formatCursorPromptTimeoutMessage('finding-verification', 'cursor/gpt-5', 1200_000),
      'cursor finding-verification prompt timed out after 1200s (model=cursor/gpt-5)',
    );
  });
});
