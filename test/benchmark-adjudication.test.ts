import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  adjudicateHistoricalCandidates,
  blindAdjudicationCase,
  classifyHistoricalOutcome,
  importHistoricalFinding,
} from '../src/shared/benchmark-adjudication.ts';

const hash = `sha256:${'a'.repeat(64)}`;
const signal = {
  findingId: 'finding-1',
  sourceHash: hash,
  caseId: 'clean-treatment-case-1',
  severity: 'P1' as const,
  pathHash: hash,
  line: 10,
  findingText: 'The shared finalizer can terminate another active review session.',
  evidenceText: 'releaseSession(sessionId) runs before the shared owner count reaches zero.',
};

describe('historical benchmark adjudication', () => {
  it('uses only explicit outcomes and keeps neutral replies unresolved', () => {
    assert.equal(classifyHistoricalOutcome({ resolved: true }), 'positive-candidate');
    assert.equal(classifyHistoricalOutcome({ reactions: ['-1'] }), 'negative-candidate');
    assert.equal(
      classifyHistoricalOutcome({ resolved: true, reactions: ['confused'] }),
      'conflicting-signals',
    );
    assert.equal(classifyHistoricalOutcome({ humanReplyCount: 3 }), 'adjudication-required');
  });

  it('emits a blind record without treatment identity or reply text', () => {
    const candidate = importHistoricalFinding({ ...signal, humanReplyCount: 1 });
    const blind = blindAdjudicationCase(candidate);
    assert.equal(blind.findingText, signal.findingText);
    assert.equal(blind.evidenceText, signal.evidenceText);
    assert.equal('sourceHash' in blind, false);
    assert.equal('outcomeCandidate' in blind, false);
    assert.equal('caseId' in blind, false);
    assert.equal(candidate.outcomeCandidate, 'adjudication-required');
  });

  it('requires two independent labels and records disagreement separately', () => {
    const candidate = importHistoricalFinding(signal);
    const one = adjudicateHistoricalCandidates(
      [candidate],
      [{ candidateId: candidate.candidateId, adjudicatorId: 'a', decision: 'accepted' }],
    );
    assert.equal(one[0].status, 'pending');
    const disagreement = adjudicateHistoricalCandidates(
      [candidate],
      [
        { candidateId: candidate.candidateId, adjudicatorId: 'a', decision: 'accepted' },
        { candidateId: candidate.candidateId, adjudicatorId: 'b', decision: 'rejected' },
      ],
    );
    assert.equal(disagreement[0].status, 'disagreement');
    assert.equal(
      adjudicateHistoricalCandidates(
        [candidate],
        [
          {
            candidateId: candidate.candidateId,
            adjudicatorId: 'a',
            decision: 'accepted',
            expectedFindingId: 'finding-1',
          },
          { candidateId: candidate.candidateId, adjudicatorId: 'b', decision: 'accepted' },
        ],
      )[0].status,
      'disagreement',
    );
    assert.equal(
      adjudicateHistoricalCandidates(
        [candidate],
        [
          {
            candidateId: candidate.candidateId,
            adjudicatorId: 'a',
            decision: 'accepted',
            expectedFindingId: ' finding-1 ',
          },
          {
            candidateId: candidate.candidateId,
            adjudicatorId: 'b',
            decision: 'accepted',
            expectedFindingId: 'finding-1',
          },
        ],
      )[0].expectedFindingId,
      'finding-1',
    );
    assert.deepEqual(
      adjudicateHistoricalCandidates(
        [candidate],
        [
          {
            candidateId: candidate.candidateId,
            adjudicatorId: 'a',
            decision: 'rejected',
            expectedFindingId: 'finding-1',
          },
          { candidateId: candidate.candidateId, adjudicatorId: 'b', decision: 'rejected' },
        ],
      )[0],
      {
        candidateId: candidate.candidateId,
        status: 'adjudicated',
        decision: 'rejected',
        labelCount: 2,
      },
    );
    assert.throws(
      () =>
        adjudicateHistoricalCandidates(
          [candidate],
          [
            { candidateId: candidate.candidateId, adjudicatorId: 'a', decision: 'accepted' },
            { candidateId: candidate.candidateId, adjudicatorId: 'a', decision: 'accepted' },
          ],
        ),
      /duplicated/,
    );
    assert.throws(
      () => importHistoricalFinding({ ...signal, findingId: 1 as unknown as string }),
      /invalid/,
    );
    assert.throws(
      () =>
        adjudicateHistoricalCandidates(
          [candidate],
          [
            {
              candidateId: candidate.candidateId,
              adjudicatorId: 1 as unknown as string,
              decision: 'accepted',
            },
          ],
        ),
      /invalid/,
    );
  });
});
