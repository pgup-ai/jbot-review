import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cursorEnvForKey, isCursorProvider, parseCursorModelList } from '../src/shared/cursor.ts';

describe('Cursor CLI provider helpers', () => {
  it('matches only the explicit cursor provider id', () => {
    assert.equal(isCursorProvider('cursor'), true);
    assert.equal(isCursorProvider('Cursor'), false);
    assert.equal(isCursorProvider(' cursor '), false);
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

  it('parses model ids from cursor-agent models output', () => {
    assert.deepEqual(
      parseCursorModelList(
        [
          'Available models',
          '',
          'auto - Auto',
          'composer-2.5 - Composer 2.5',
          'gpt-5.2-codex-high - Codex 5.2 High',
          'claude-opus-4-8-thinking-high - Opus 4.8 1M Thinking',
          'composer-2.5-fast - Composer 2.5 Fast (default)',
          '',
          'Tip: use --model <id> (or /model <id> in interactive mode) to switch.',
        ].join('\n'),
      ),
      [
        'auto',
        'composer-2.5',
        'gpt-5.2-codex-high',
        'claude-opus-4-8-thinking-high',
        'composer-2.5-fast',
      ],
    );
  });
});
