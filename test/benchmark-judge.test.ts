import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createJudge,
  judgeMetrics,
  matchComments,
  scoreCases,
  type JudgeComment,
} from '../src/shared/benchmark-judge.ts';

const comment = (path: string, from: number | null, note: string, side?: 'left' | 'right') => ({
  path,
  fromLine: from,
  toLine: from,
  note,
  ...(side ? { side } : {}),
});
const sameNote = async (reference: string, generated: string) => reference === generated;

describe('matchComments', () => {
  it('only judges candidates on the same path and, when both are set, the same side', async () => {
    const asked: string[] = [];
    const judge = async (reference: string, generated: string) => {
      asked.push(generated);
      return reference === generated;
    };
    const result = await matchComments(
      [comment('a.ts', 10, 'x', 'right')],
      [comment('b.ts', 10, 'x'), comment('a.ts', 10, 'x', 'left'), comment('a.ts', 10, 'x')],
      judge,
    );
    assert.deepEqual(asked, ['x']);
    assert.deepEqual(result.matchedGenerated, [2]);
  });

  it('accepts lines within the window and skips the line stage when a bound is null', async () => {
    const refs = [comment('a.ts', 10, 'x')];
    assert.deepEqual(
      (await matchComments(refs, [comment('a.ts', 11, 'x')], sameNote)).matchedGenerated,
      [0],
    );
    assert.deepEqual(
      (await matchComments(refs, [comment('a.ts', 12, 'x')], sameNote)).matchedGenerated,
      [null],
    );
    const fileLevel = await matchComments(refs, [comment('a.ts', null, 'x')], sameNote);
    assert.deepEqual(fileLevel, { lineMatched: [true], matchedGenerated: [0] });
  });

  it('lets one generated comment satisfy at most one reference', async () => {
    const result = await matchComments(
      [comment('a.ts', 10, 'x'), comment('a.ts', 10, 'x')],
      [comment('a.ts', 10, 'x')],
      sameNote,
    );
    assert.deepEqual(result, { lineMatched: [true, false], matchedGenerated: [0, null] });
  });

  it('stops scanning a reference at its first semantic match', async () => {
    let calls = 0;
    const judge = async () => {
      calls += 1;
      return true;
    };
    await matchComments(
      [comment('a.ts', 10, 'x')],
      [comment('a.ts', 10, 'y'), comment('a.ts', 10, 'z')],
      judge,
    );
    assert.equal(calls, 1);
  });

  it('ignores thinking blocks and empty notes', async () => {
    const result = await matchComments(
      [comment('a.ts', 10, '<details>trace</details>x'), comment('a.ts', 10, '')],
      [comment('a.ts', 10, 'x')],
      sameNote,
    );
    assert.deepEqual(result.matchedGenerated, [0, null]);
  });
});

describe('judgeMetrics', () => {
  it('computes precision, recall and F1 from rounded rates, like the official summary', () => {
    assert.deepEqual(
      judgeMetrics({ expected: 7, generated: 3, lineMatched: 2, semanticMatched: 1 }),
      {
        semanticPrecision: 0.333,
        semanticRecall: 0.143,
        semanticF1: 0.2,
        linePrecision: 0.667,
        lineRecall: 0.286,
        lineF1: 0.4,
      },
    );
    assert.equal(
      judgeMetrics({ expected: 0, generated: 0, lineMatched: 0, semanticMatched: 0 }).semanticF1,
      0,
    );
  });
});

describe('scoreCases', () => {
  it('sums counts across cases before computing rates', async () => {
    const ref: JudgeComment = comment('a.ts', 1, 'x');
    const scored = await scoreCases(
      [
        { caseId: 'one', references: [ref, comment('a.ts', 1, 'y')], generated: [ref] },
        { caseId: 'two', references: [ref], generated: [] },
      ],
      sameNote,
    );
    assert.deepEqual(scored.counts, {
      expected: 3,
      generated: 1,
      lineMatched: 1,
      semanticMatched: 1,
    });
    assert.deepEqual(scored.cases[0]!.matches, [{ reference: 0, generated: 0 }]);
    assert.equal(scored.metrics.semanticRecall, 0.333);
  });
});

describe('createJudge', () => {
  it('asks the official question, reads the verdict and counts a failed call as no', async () => {
    const prompts: string[] = [];
    const { sameConcern, stats } = createJudge(async (prompt) => {
      prompts.push(prompt);
      if (prompt.includes('boom')) throw new Error('rate limited');
      return 'Yes';
    });
    assert.equal(await sameConcern('ref', 'gen'), true);
    assert.equal(await sameConcern('ref', 'boom'), false);
    assert.deepEqual([stats.calls, stats.errors], [2, 1]);
    assert.match(prompts[0]!, /Review Comment 1:\nref\n\nReview Comment 2:\ngen/);
  });
});
