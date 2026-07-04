import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseFindingVerdicts, parseReview } from '../src/shared/opencode.ts';

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
      { id: 'PRRT_1', addressedByCommit: 'abc1234' },
      { id: 'PRRT_2', addressedByCommit: 'def5678' },
    ]);
  });

  it('prefers camelCase when both casings are present and trims the value', () => {
    const raw = JSON.stringify({
      summary: 'ok',
      findings: [],
      addressedPriorComments: [
        { id: 'PRRT_3', addressedByCommit: '  camel-wins  ', addressed_by_commit: 'snake-loses' },
      ],
    });

    const result = parseReview(raw, 'test', noLog);

    assert.deepEqual(result.addressedPriorComments, [
      { id: 'PRRT_3', addressedByCommit: 'camel-wins' },
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

  it('accepts the architecture finding kind', () => {
    const raw = JSON.stringify({
      summary: 's',
      findings: [
        {
          path: 'src/a.ts',
          line: 3,
          severity: 'P3',
          kind: 'architecture',
          confidence: 'medium',
          title: 'Duplicates existing helper',
          body: 'See src/shared/util.ts for the existing implementation.',
        },
      ],
    });

    const result = parseReview(raw, 'test', noLog);

    assert.equal(result.findings[0].kind, 'architecture');
  });
});

describe('parseReview line anchors', () => {
  function rawWithLine(line: unknown): string {
    return JSON.stringify({
      summary: 'ok',
      findings: [{ path: 'src/a.ts', line, severity: 'P2', title: 'Title', body: 'Body' }],
    });
  }

  it('accepts line 0 as a file-level anchor', () => {
    const result = parseReview(rawWithLine(0), 'test', noLog);

    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].line, 0);
  });

  it('rejects negative and fractional lines as model noise', () => {
    assert.equal(parseReview(rawWithLine(-1), 'test', noLog).findings.length, 0);
    assert.equal(parseReview(rawWithLine(4.5), 'test', noLog).findings.length, 0);
  });
});

describe('parseReview evidence field (F12)', () => {
  function rawWithEvidence(evidence: unknown): string {
    return JSON.stringify({
      summary: 'ok',
      findings: [{ path: 'src/a.ts', line: 3, severity: 'P2', title: 'T', body: 'B', evidence }],
    });
  }

  it('keeps a verbatim evidence quote when present', () => {
    const result = parseReview(rawWithEvidence('const total = subtotal;'), 'test', noLog);
    assert.equal(result.findings[0].evidence, 'const total = subtotal;');
  });

  it('leaves evidence undefined when absent (backward compatible)', () => {
    const raw = JSON.stringify({
      summary: 'ok',
      findings: [{ path: 'src/a.ts', line: 3, severity: 'P2', title: 'T', body: 'B' }],
    });
    assert.equal(parseReview(raw, 'test', noLog).findings[0].evidence, undefined);
  });

  it('truncates an oversized evidence quote to the cap', () => {
    const result = parseReview(rawWithEvidence('x'.repeat(500)), 'test', noLog);
    assert.equal(result.findings[0].evidence?.length, 200);
  });

  it('ignores a blank or non-string evidence value', () => {
    assert.equal(
      parseReview(rawWithEvidence('   '), 'test', noLog).findings[0].evidence,
      undefined,
    );
    assert.equal(parseReview(rawWithEvidence(42), 'test', noLog).findings[0].evidence, undefined);
  });
});

describe('parseFindingVerdicts', () => {
  it('parses valid verdicts keyed by finding index', () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 0, verdict: 'confirmed', reason: 'traced it' },
        { index: 1, verdict: 'refuted', reason: 'guarded above' },
        { index: 2, verdict: 'uncertain' },
      ],
    });

    const verdicts = parseFindingVerdicts(raw, 3, noLog);

    assert.deepEqual(verdicts, [
      { index: 0, verdict: 'confirmed', reason: 'traced it' },
      { index: 1, verdict: 'refuted', reason: 'guarded above' },
      { index: 2, verdict: 'uncertain', reason: undefined },
    ]);
  });

  it('skips out-of-range, duplicate, and unknown-verdict entries', () => {
    const raw = JSON.stringify({
      verdicts: [
        { index: 5, verdict: 'refuted' },
        { index: 0, verdict: 'maybe' },
        { index: 1, verdict: 'refuted' },
        { index: 1, verdict: 'confirmed' },
      ],
    });

    const verdicts = parseFindingVerdicts(raw, 2, noLog);

    assert.deepEqual(verdicts, [{ index: 1, verdict: 'refuted', reason: undefined }]);
  });

  it('returns undefined (fail-open signal) on unusable responses', () => {
    assert.equal(parseFindingVerdicts('not json at all', 2, noLog), undefined);
    assert.equal(parseFindingVerdicts('{"something": []}', 2, noLog), undefined);
  });

  it('extracts verdicts from fenced output like the review parser does', () => {
    const raw = '```json\n{"verdicts": [{"index": 0, "verdict": "confirmed"}]}\n```';

    const verdicts = parseFindingVerdicts(raw, 1, noLog);

    assert.deepEqual(verdicts, [{ index: 0, verdict: 'confirmed', reason: undefined }]);
  });
});
