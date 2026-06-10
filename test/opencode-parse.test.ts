import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseReview } from '../src/shared/opencode.ts';

const noLog = (): void => undefined;

describe('parseReview', () => {
  it('accepts both camelCase and snake_case addressed-commit keys', () => {
    const raw = JSON.stringify({
      summary: 'ok',
      findings: [],
      addressedPriorComments: [
        { id: 'PRRT_1', addressedByCommit: 'abc1234', note: 'fixed' },
        { id: 'PRRT_2', addressed_by_commit: 'def5678', note: 'also fixed' },
      ],
    });

    const result = parseReview(raw, 'test', noLog);

    assert.deepEqual(result.addressedPriorComments, [
      { id: 'PRRT_1', addressedByCommit: 'abc1234', note: 'fixed' },
      { id: 'PRRT_2', addressedByCommit: 'def5678', note: 'also fixed' },
    ]);
  });

  it('parses a valid review object', () => {
    const raw = JSON.stringify({
      summary: 'One issue found.',
      findings: [
        {
          path: 'src/a.ts',
          line: 12,
          severity: 'P1',
          kind: 'bug',
          confidence: 'high',
          title: 'Off-by-one',
          body: 'Loop bound excludes the last element.',
        },
      ],
    });

    const result = parseReview(raw, 'test', noLog, { strict: true });

    assert.equal(result.summary, 'One issue found.');
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, 'P1');
    assert.equal(result.findings[0].kind, 'bug');
  });

  it('extracts JSON from a fenced code block', () => {
    const raw = '```json\n{"summary": "fenced", "findings": []}\n```';

    const result = parseReview(raw, 'test', noLog, { strict: true });

    assert.equal(result.summary, 'fenced');
  });

  it('extracts a balanced JSON object embedded in prose', () => {
    const raw = 'Here is my review:\n{"summary": "embedded", "findings": []}\nThanks!';

    const result = parseReview(raw, 'test', noLog, { strict: true });

    assert.equal(result.summary, 'embedded');
  });

  it('drops findings with an invalid severity', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [
        {
          path: 'src/a.ts',
          line: 1,
          severity: 'P0" | "P1',
          title: 'union syntax leak',
          body: 'b',
        },
      ],
    });

    const result = parseReview(raw, 'test', noLog);

    assert.equal(result.findings.length, 0);
  });

  it('throws in strict mode on unparseable output', () => {
    assert.throws(
      () => parseReview('not json at all', 'review', noLog, { strict: true }),
      /unparseable JSON/,
    );
  });

  it('returns a fallback result in non-strict mode', () => {
    const result = parseReview('not json at all', 'aux', noLog);

    assert.equal(result.summary, 'The reviewer returned an unparseable response.');
    assert.deepEqual(result.findings, []);
  });
});
