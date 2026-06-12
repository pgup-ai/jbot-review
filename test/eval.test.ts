import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateScores,
  matchFindings,
  scoreCase,
  type ActualFinding,
  type ExpectedFinding,
} from '../src/shared/eval.ts';

function actual(overrides: Partial<ActualFinding>): ActualFinding {
  return {
    path: 'src/a.ts',
    line: 42,
    severity: 'P1',
    title: 'Normalization drops non-Latin names',
    body: 'The ASCII regex empties CJK names so duplicates are skipped.',
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedFinding>): ExpectedFinding {
  return {
    path: 'src/a.ts',
    lineStart: 40,
    lineEnd: 44,
    category: 'data-integrity',
    mustFind: true,
    description: 'ASCII-only normalization silently drops non-Latin duplicates',
    keywords: ['non-latin', 'ascii', 'cjk'],
    ...overrides,
  };
}

describe('matchFindings', () => {
  it('matches on path, fuzzy line range, and any keyword', () => {
    const result = matchFindings([expected({})], [actual({ line: 45 })]);

    assert.equal(result.matched.length, 1);
    assert.equal(result.missed.length, 0);
    assert.equal(result.unmatchedActuals.length, 0);
  });

  it('misses when the finding is outside the tolerance window', () => {
    const result = matchFindings([expected({})], [actual({ line: 60 })]);

    assert.equal(result.matched.length, 0);
    assert.equal(result.missed.length, 1);
    assert.equal(result.unmatchedActuals.length, 1);
  });

  it('misses when no keyword appears in the finding text', () => {
    const result = matchFindings(
      [expected({})],
      [actual({ title: 'Something unrelated', body: 'No relevant words here.' })],
    );

    assert.equal(result.missed.length, 1);
  });

  it('lets a file-level actual (line 0) match a ranged expectation', () => {
    const result = matchFindings([expected({})], [actual({ line: 0 })]);

    assert.equal(result.matched.length, 1);
  });

  it('consumes each actual at most once', () => {
    const result = matchFindings(
      [expected({}), expected({ description: 'same bug labeled twice' })],
      [actual({})],
    );

    assert.equal(result.matched.length, 1);
    assert.equal(result.missed.length, 1);
  });
});

describe('scoreCase / aggregateScores', () => {
  it('computes recall over mustFind labels only', () => {
    const score = scoreCase(
      'case-1',
      {
        findings: [
          expected({}),
          expected({ mustFind: false, description: 'nice to have', path: 'src/b.ts' }),
        ],
      },
      [actual({})],
    );

    assert.equal(score.mustFindCount, 1);
    assert.equal(score.mustFindMatched, 1);
    assert.equal(score.missed.length, 0);
  });

  it('aggregates recall, exhaustive precision, and per-category counts', () => {
    const matchedCase = scoreCase('hit', { exhaustive: true, findings: [expected({})] }, [
      actual({}),
      actual({ path: 'src/noise.ts', title: 'Spurious', body: 'noise' }),
    ]);
    const missedCase = scoreCase(
      'miss',
      { findings: [expected({ category: 'logic', keywords: ['gate'] })] },
      [],
    );

    const aggregate = aggregateScores([matchedCase, missedCase]);

    assert.equal(aggregate.recall, 0.5);
    assert.equal(aggregate.precision, 0.5);
    assert.equal(aggregate.noisePerCase, 1);
    assert.deepEqual(aggregate.perCategory['data-integrity'], { expected: 1, matched: 1 });
    assert.deepEqual(aggregate.perCategory.logic, { expected: 1, matched: 0 });
  });

  it('reports a clean PR with zero expectations as recall n/a, noise counted', () => {
    const clean = scoreCase('clean', { exhaustive: true, findings: [] }, [
      actual({ path: 'src/noise.ts' }),
    ]);

    const aggregate = aggregateScores([clean]);

    assert.equal(aggregate.recall, undefined);
    assert.equal(aggregate.precision, 0);
    assert.equal(aggregate.noisePerCase, 1);
  });
});
