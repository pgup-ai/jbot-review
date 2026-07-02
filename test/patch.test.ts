import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAddedLines } from '../src/shared/patch.ts';

describe('parseAddedLines', () => {
  it('collects added new-side lines across hunks', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' a',
      '+b',
      ' c',
      ' d',
      '@@ -10,2 +11,3 @@',
      ' x',
      '+y',
      '+z',
    ].join('\n');
    assert.deepEqual(parseAddedLines(patch), new Set([2, 12, 13]));
  });

  it('returns an empty set for undefined or hunk-less patches', () => {
    assert.deepEqual(parseAddedLines(undefined), new Set());
    assert.deepEqual(parseAddedLines('not a diff'), new Set());
  });

  // "\ No newline at end of file" annotates the PRECEDING line and exists on
  // neither side of the diff. Counting it as context shifted every added line
  // after a mid-hunk marker one line too high, so valid inline anchors were
  // rejected by the addable-line gate and findings were demoted.
  it('does not count a mid-hunk no-newline marker as a context line', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' context',
      '-old',
      '\\ No newline at end of file',
      '+old2',
    ].join('\n');
    assert.deepEqual(parseAddedLines(patch), new Set([2]));
  });

  it('keeps later added lines aligned after a mid-hunk marker', () => {
    const patch = [
      '@@ -1,2 +1,3 @@',
      ' a',
      '-b',
      '\\ No newline at end of file',
      '+b2',
      '+c',
      '\\ No newline at end of file',
    ].join('\n');
    assert.deepEqual(parseAddedLines(patch), new Set([2, 3]));
  });

  it('is unaffected by a trailing marker after the last added line', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' context',
      '-old',
      '+old2',
      '\\ No newline at end of file',
    ].join('\n');
    assert.deepEqual(parseAddedLines(patch), new Set([2]));
  });
});
