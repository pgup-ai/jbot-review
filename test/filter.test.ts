import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyFindingVerdicts,
  dedupeFindings,
  demoteLowConfidenceBlockingFindings,
  isNoiseFile,
  selectBlockingFindingIndexes,
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

describe('dedupeFindings with file-level (line 0) anchors', () => {
  it('keeps two DIFFERENT file-level findings on the same file', () => {
    const merged = dedupeFindings(
      [finding({ line: 0, title: 'Missing provider options wiring in subagent runner' })],
      [finding({ line: 0, title: 'Duplicate groups beyond cap are unretrievable' })],
    );

    assert.equal(merged.length, 2);
  });

  it('does not merge short missing-* file-level findings only because they share one word', () => {
    const merged = dedupeFindings(
      [finding({ line: 0, title: 'Missing provider options wiring' })],
      [finding({ line: 0, title: 'Missing validation coverage' })],
    );

    assert.equal(merged.length, 2);
  });

  it('dedupes file-level findings describing the same issue, keeping the stronger', () => {
    const merged = dedupeFindings(
      [
        finding({
          line: 0,
          severity: 'P2',
          title: 'Provider options not wired into subagent runner',
        }),
      ],
      [
        finding({
          line: 0,
          severity: 'P1',
          title: 'Subagent runner provider options wiring missing',
        }),
      ],
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].severity, 'P1');
  });

  it('never collides a file-level finding with a line-anchored one', () => {
    const merged = dedupeFindings(
      [finding({ line: 0, title: 'Same words here' })],
      [finding({ line: 12, title: 'Same words here' })],
    );

    assert.equal(merged.length, 2);
  });
});

describe('selectBlockingFindingIndexes', () => {
  it('selects blocking findings most-severe-first with original indexes', () => {
    const findings = [
      finding({ severity: 'P3' }),
      finding({ severity: 'P2' }),
      finding({ severity: 'nit' }),
      finding({ severity: 'P0' }),
      finding({ severity: 'P1' }),
    ];

    assert.deepEqual(selectBlockingFindingIndexes(findings, 10), [3, 4, 1]);
  });

  it('caps the selection and never selects advisory findings', () => {
    const findings = [
      finding({ severity: 'P2' }),
      finding({ severity: 'P2' }),
      finding({ severity: 'P3' }),
    ];

    assert.deepEqual(selectBlockingFindingIndexes(findings, 1), [0]);
    assert.deepEqual(selectBlockingFindingIndexes([finding({ severity: 'P3' })], 10), []);
  });
});

describe('applyFindingVerdicts', () => {
  // Non-blocking findings interleaved with blocking ones is the case most
  // likely to break the verdict-position -> finding-index translation.
  const findings = [
    finding({ severity: 'P3', title: 'advisory survives untouched' }),
    finding({ severity: 'P1', title: 'refute me' }),
    finding({ severity: 'nit', title: 'nit survives untouched' }),
    finding({ severity: 'P2', title: 'uncertain me' }),
    finding({ severity: 'P2', title: 'confirm me' }),
  ];
  const selected = selectBlockingFindingIndexes(findings, 10); // [1, 3, 4]

  it('maps verdict positions back to the right findings', () => {
    const {
      findings: result,
      dropped,
      demoted,
    } = applyFindingVerdicts(findings, selected, [
      { index: 0, verdict: 'refuted', reason: 'guarded' },
      { index: 1, verdict: 'uncertain' },
      { index: 2, verdict: 'confirmed' },
    ]);

    assert.deepEqual(
      dropped.map(({ finding: f }) => f.title),
      ['refute me'],
    );
    assert.deepEqual(
      demoted.map(({ finding: f }) => f.title),
      ['uncertain me'],
    );
    assert.deepEqual(
      result.map((f) => `${f.title}:${f.severity}`),
      [
        'advisory survives untouched:P3',
        'nit survives untouched:nit',
        'uncertain me:P3',
        'confirm me:P2',
      ],
    );
  });

  it('treats a selected finding with no verdict as confirmed (fail-open)', () => {
    const {
      findings: result,
      dropped,
      demoted,
    } = applyFindingVerdicts(findings, selected, [{ index: 0, verdict: 'refuted' }]);

    assert.equal(dropped.length, 1);
    assert.equal(demoted.length, 0);
    assert.equal(result.length, findings.length - 1);
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

  it('suppresses matching non-Latin titles when the prior thread body contains the same words', () => {
    const { findings, suppressedCount } = suppressPreviouslyReported(
      [finding({ line: 10, title: 'Ошибка обработки платежа' })],
      [
        {
          path: 'src/example.ts',
          line: 10,
          body: '**P2** — Ошибка обработки платежа при повторе',
        },
      ],
    );

    assert.equal(suppressedCount, 1);
    assert.equal(findings.length, 0);
  });

  it('is a no-op without prior threads', () => {
    const input = [finding({})];
    const { findings, suppressedCount } = suppressPreviouslyReported(input, []);

    assert.equal(suppressedCount, 0);
    assert.equal(findings, input);
  });

  it('never suppresses against a RESOLVED thread: a re-detection is a regression signal', () => {
    const resolvedThread = { ...thread, isResolved: true };
    const { findings, suppressedCount } = suppressPreviouslyReported(
      [finding({ line: 11, title: 'Refund amount uses pre-tax subtotal' })],
      [resolvedThread],
    );

    assert.equal(suppressedCount, 0);
    assert.equal(findings.length, 1);
  });
});
