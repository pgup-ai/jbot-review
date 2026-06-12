import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dedupeFindings,
  demoteLowConfidenceBlockingFindings,
  isNoiseFile,
  suppressPreviouslyReported,
} from '../src/shared/filter.ts';
import type { Finding } from '../src/shared/types.ts';

function finding(overrides: Partial<Finding>): Finding {
  return {
    path: 'src/example.ts',
    line: 10,
    severity: 'P2',
    title: 'Example finding',
    body: 'Example body',
    ...overrides,
  };
}

describe('demoteLowConfidenceBlockingFindings', () => {
  it('demotes low-confidence P0/P1/P2 findings to P3', () => {
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings([
      finding({ severity: 'P0', confidence: 'low' }),
      finding({ severity: 'P1', confidence: 'low' }),
      finding({ severity: 'P2', confidence: 'low' }),
    ]);

    assert.equal(demotedCount, 3);
    assert.deepEqual(
      findings.map((f) => f.severity),
      ['P3', 'P3', 'P3'],
    );
  });

  it('keeps high/medium confidence blocking findings unchanged', () => {
    const input = [
      finding({ severity: 'P0', confidence: 'high' }),
      finding({ severity: 'P1', confidence: 'medium' }),
    ];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.deepEqual(findings, input);
  });

  it('does not demote findings without a confidence field', () => {
    const input = [finding({ severity: 'P0' })];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.equal(findings[0].severity, 'P0');
  });

  it('leaves low-confidence advisory findings (P3/nit) unchanged', () => {
    const input = [
      finding({ severity: 'P3', confidence: 'low' }),
      finding({ severity: 'nit', confidence: 'low' }),
    ];
    const { findings, demotedCount } = demoteLowConfidenceBlockingFindings(input);

    assert.equal(demotedCount, 0);
    assert.deepEqual(findings, input);
  });
});

describe('isNoiseFile', () => {
  it('still filters lockfiles', () => {
    assert.equal(isNoiseFile('package-lock.json'), true);
    assert.equal(isNoiseFile('src/app.ts'), false);
  });
});

describe('dedupeFindings', () => {
  it('keeps the first finding on a path:line collision', () => {
    const main = [finding({ line: 5, title: 'main wins' })];
    const compliance = [
      finding({ line: 5, title: 'duplicate from compliance' }),
      finding({ line: 9, title: 'unique compliance finding' }),
    ];

    const merged = dedupeFindings(main, compliance);

    assert.deepEqual(
      merged.map((f) => f.title),
      ['main wins', 'unique compliance finding'],
    );
  });

  it('does not collide findings in different files', () => {
    const merged = dedupeFindings(
      [finding({ path: 'a.ts', line: 5 })],
      [finding({ path: 'b.ts', line: 5 })],
    );

    assert.equal(merged.length, 2);
  });

  it('keeps the more severe finding on a collision regardless of input order', () => {
    const main = [finding({ line: 5, severity: 'P3', title: 'weaker main' })];
    const compliance = [finding({ line: 5, severity: 'P2', title: 'stronger compliance' })];

    const merged = dedupeFindings(main, compliance);

    assert.deepEqual(
      merged.map((f) => f.title),
      ['stronger compliance'],
    );
  });

  it('breaks severity ties by confidence', () => {
    const main = [finding({ line: 5, severity: 'P2', confidence: 'low', title: 'low main' })];
    const compliance = [
      finding({ line: 5, severity: 'P2', confidence: 'high', title: 'high compliance' }),
    ];

    const merged = dedupeFindings(main, compliance);

    assert.deepEqual(
      merged.map((f) => f.title),
      ['high compliance'],
    );
  });

  it('keeps the earlier list on a full tie and preserves first-seen position', () => {
    const main = [
      finding({ line: 5, severity: 'P2', confidence: 'high', title: 'main wins' }),
      finding({ line: 9, severity: 'P3', title: 'main only' }),
    ];
    const compliance = [
      finding({ line: 5, severity: 'P2', confidence: 'high', title: 'compliance tie' }),
    ];

    const merged = dedupeFindings(main, compliance);

    assert.deepEqual(
      merged.map((f) => f.title),
      ['main wins', 'main only'],
    );
  });
});

describe('suppressPreviouslyReported', () => {
  const thread = {
    path: 'src/example.ts',
    line: 10,
    body: '**P2 (bug, high)** — Refund amount uses pre-tax subtotal\n\nDetails about the subtotal bug.',
  };

  it('suppresses a re-detected finding at the same location with matching title words', () => {
    const { findings, suppressedCount } = suppressPreviouslyReported(
      [finding({ line: 11, title: 'Refund amount uses pre-tax subtotal' })],
      [thread],
    );

    assert.equal(suppressedCount, 1);
    assert.equal(findings.length, 0);
  });

  it('keeps a different issue near the same lines', () => {
    const { findings, suppressedCount } = suppressPreviouslyReported(
      [finding({ line: 11, title: 'Unhandled rejection when webhook delivery times out' })],
      [thread],
    );

    assert.equal(suppressedCount, 0);
    assert.equal(findings.length, 1);
  });

  it('keeps a similar issue outside the line tolerance', () => {
    const { findings } = suppressPreviouslyReported(
      [finding({ line: 20, title: 'Refund amount uses pre-tax subtotal' })],
      [thread],
    );

    assert.equal(findings.length, 1);
  });

  it('keeps findings in other files', () => {
    const { findings } = suppressPreviouslyReported(
      [finding({ path: 'src/other.ts', line: 10, title: 'Refund amount uses pre-tax subtotal' })],
      [thread],
    );

    assert.equal(findings.length, 1);
  });

  it('matches file-level findings only against file-level threads', () => {
    const fileLevelThread = { path: 'src/example.ts', body: 'Missing provider options wiring' };
    const { findings, suppressedCount } = suppressPreviouslyReported(
      [
        finding({ line: 0, title: 'Missing provider options wiring' }),
        finding({ line: 0, title: 'Refund amount uses pre-tax subtotal' }),
      ],
      [fileLevelThread, thread],
    );

    assert.equal(suppressedCount, 1);
    assert.deepEqual(
      findings.map((f) => f.title),
      ['Refund amount uses pre-tax subtotal'],
    );
  });

  it('never suppresses when a title has no significant words to compare', () => {
    const { findings } = suppressPreviouslyReported(
      [finding({ line: 10, title: 'fix it' })],
      [thread],
    );

    assert.equal(findings.length, 1);
  });

  it('is a no-op without prior threads', () => {
    const input = [finding({})];
    const { findings, suppressedCount } = suppressPreviouslyReported(input, []);

    assert.equal(suppressedCount, 0);
    assert.equal(findings, input);
  });
});
