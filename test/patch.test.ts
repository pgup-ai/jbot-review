import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAddedLines, rescueAnchorByEvidence } from '../src/shared/patch.ts';

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

describe('rescueAnchorByEvidence (F12 orphan rescue)', () => {
  const patch = [
    '@@ -1,3 +1,5 @@',
    ' function refund(order) {',
    '-  return order.subtotal;',
    '+  return order.subtotal; // BUG: pre-tax',
    '+  const tax = order.tax;',
    ' }',
  ].join('\n');

  it('re-anchors to the unique added line whose content contains the quote', () => {
    // Model quoted the added line (whitespace-trimmed); rescue finds its new-side number.
    assert.equal(rescueAnchorByEvidence(patch, 'return order.subtotal; // BUG: pre-tax'), 2);
    assert.equal(rescueAnchorByEvidence(patch, 'const tax = order.tax;'), 3);
  });

  it('does not rescue when the quote is absent from any added line', () => {
    assert.equal(rescueAnchorByEvidence(patch, 'order.total'), undefined);
  });

  it('does not rescue an ambiguous quote that matches multiple added lines', () => {
    const dup = ['@@ -1,0 +1,2 @@', '+  x = 1;', '+  x = 1;'].join('\n');
    assert.equal(rescueAnchorByEvidence(dup, 'x = 1;'), undefined);
  });

  it('ignores a blank quote or missing patch', () => {
    assert.equal(rescueAnchorByEvidence(patch, '   '), undefined);
    assert.equal(rescueAnchorByEvidence(undefined, 'anything'), undefined);
  });

  it('only matches added lines, never context or removed lines', () => {
    // "function refund" is a context line and "order.subtotal;" (bare) is removed.
    assert.equal(rescueAnchorByEvidence(patch, 'function refund(order) {'), undefined);
  });
});
