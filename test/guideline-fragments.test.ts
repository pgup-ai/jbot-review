import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildFairGuidelineFragments,
  buildGuidelineFragments,
  selectGuidelineFragments,
} from '../src/shared/guideline-fragments.ts';

describe('guideline fragments', () => {
  it('splits on UTF-8 boundaries within the byte cap', () => {
    const text = `heading\n${' \n'.repeat(20)}${'世界'.repeat(20)}`;
    const fragments = buildGuidelineFragments([{ id: 'a', label: 'A', text, relevance: 1 }], 17);

    assert.ok(fragments.length > 1);
    assert.ok(fragments.every((fragment) => Buffer.byteLength(fragment.text, 'utf8') <= 17));
    const reconstructed = fragments.map((fragment) => fragment.text).join('');
    assert.equal(reconstructed, text);
    assert.throws(
      () => buildGuidelineFragments([{ id: 'a', label: 'A', text: '世', relevance: 1 }], 3),
      /at least 4/,
    );
    assert.deepEqual(
      buildFairGuidelineFragments(
        [{ id: 'a', label: 'A', text: '世界', relevance: 1 }],
        1,
        4096,
      ).map((fragment) => fragment.text),
      ['世', '界'],
    );
  });

  it('round-robins equal-relevance sources independent of input order', () => {
    const sources = [
      { id: 'b', label: 'B', text: 'b'.repeat(20), relevance: 2 },
      { id: 'a', label: 'A', text: 'a'.repeat(20), relevance: 2 },
    ];
    const labels = (input: typeof sources) =>
      buildGuidelineFragments(input, 10).map((fragment) => fragment.label);

    assert.deepEqual(labels(sources), [
      'A [part 1/2]',
      'B [part 1/2]',
      'A [part 2/2]',
      'B [part 2/2]',
    ]);
    assert.deepEqual(labels([...sources].reverse()), labels(sources));
  });

  it('finishes higher-relevance tiers before lower ones', () => {
    const fragments = buildGuidelineFragments(
      [
        { id: 'low', label: 'Low', text: 'l'.repeat(20), relevance: 1 },
        { id: 'high', label: 'High', text: 'h'.repeat(20), relevance: 3 },
      ],
      10,
    );

    assert.deepEqual(
      fragments.map((fragment) => fragment.label),
      ['High [part 1/2]', 'High [part 2/2]', 'Low [part 1/2]', 'Low [part 2/2]'],
    );
  });

  it('reports a source when only its prefix fits', () => {
    const fragments = buildGuidelineFragments(
      [{ id: 'a', label: 'A', text: 'a'.repeat(20), relevance: 1 }],
      10,
    );
    const plan = selectGuidelineFragments(fragments, 10, (fragment) => fragment.text);

    assert.deepEqual(
      plan.selected.map((fragment) => fragment.part),
      [1],
    );
    assert.deepEqual(plan.omittedSourceLabels, ['A']);
  });
});
