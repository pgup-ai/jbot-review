import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  anchorFindings,
  applyFindingVerdicts,
  mergeVerdictsByLocation,
  dedupeFindings,
  demoteLowConfidenceBlockingFindings,
  isNoiseFile,
  isPrCleanAfterRun,
  openFindingThreadIds,
  resolveFindingAnchors,
  selectBlockingFindingIndexes,
  shouldPostReviewComment,
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

describe('mergeVerdictsByLocation (TASK-079/080)', () => {
  // Verdicts re-attach to the (possibly larger) final list by location;
  // blocking stragglers pass through unverified and are counted.
  const targets = [
    finding({ path: 'a.ts', line: 1, severity: 'P1', title: 'refute me' }),
    finding({ path: 'b.ts', line: 2, severity: 'P2', title: 'uncertain me' }),
    finding({ path: 'c.ts', line: 3, severity: 'P2', title: 'confirm me' }),
  ];
  const straggler = finding({ path: 'late.ts', line: 9, severity: 'P1', title: 'late blocking' });
  const lateAdvisory = finding({
    path: 'late.ts',
    line: 10,
    severity: 'P3',
    title: 'late advisory',
  });
  const finalFindings = [targets[0], targets[1], targets[2], straggler, lateAdvisory];

  it('re-attaches verdicts by location and counts late blocking findings as unverified', () => {
    const { findings, dropped, demoted, lateUnverified } = mergeVerdictsByLocation(
      finalFindings,
      targets,
      [
        { index: 0, verdict: 'refuted', reason: 'guarded' },
        { index: 1, verdict: 'uncertain' },
        { index: 2, verdict: 'confirmed' },
      ],
      targets,
    );

    assert.deepEqual(
      dropped.map(({ finding: f }) => f.title),
      ['refute me'],
    );
    assert.deepEqual(
      demoted.map(({ finding: f }) => f.title),
      ['uncertain me'],
    );
    assert.deepEqual(
      findings.map((f) => `${f.title}:${f.severity}`),
      ['uncertain me:P3', 'confirm me:P2', 'late blocking:P1', 'late advisory:P3'],
    );
    // Only BLOCKING stragglers count: advisories were never verification targets.
    assert.deepEqual(
      lateUnverified.map((f) => f.title),
      ['late blocking'],
    );
  });

  it('never applies a verdict to a finding the verifier did not judge', () => {
    // Two shapes of the same hazard: dedupe keeps distinct file-level (line 0)
    // findings on one file, and a stronger LATE finding can replace the
    // verified one at the same nonzero line. The title joins the key, so both
    // stay unjudged and count as late instead of inheriting the verdict.
    const targetZero = finding({ path: 'app.ts', line: 0, severity: 'P1', title: 'wiring gap' });
    const twinZero = finding({ path: 'app.ts', line: 0, severity: 'P1', title: 'cap unreachable' });
    const { findings, dropped, lateUnverified } = mergeVerdictsByLocation(
      [targetZero, twinZero],
      [targetZero],
      [{ index: 0, verdict: 'refuted' }],
      [targetZero],
    );

    assert.deepEqual(
      dropped.map(({ finding: f }) => f.title),
      ['wiring gap'],
    );
    assert.deepEqual(
      findings.map((f) => f.title),
      ['cap unreachable'],
    );
    assert.deepEqual(
      lateUnverified.map((f) => f.title),
      ['cap unreachable'],
    );

    // Same-line replacement: the late stronger finding at refuted a.ts:1 has a
    // different title, so the old verdict must not drop it.
    const replacement = finding({ path: 'a.ts', line: 1, severity: 'P0', title: 'worse bug' });
    const replaced = mergeVerdictsByLocation(
      [replacement],
      targets,
      [{ index: 0, verdict: 'refuted' }],
      targets,
    );
    assert.deepEqual(
      replaced.findings.map((f) => f.title),
      ['worse bug'],
    );
    assert.deepEqual(
      replaced.lateUnverified.map((f) => f.title),
      ['worse bug'],
    );
  });

  it('never lets delimiter-bearing fields forge another finding identity', () => {
    // "a:1" + line 2 + "x" must not collide with "a" + line 1 + "2:x".
    const target = finding({ path: 'a:1', line: 2, severity: 'P1', title: 'x' });
    const lookalike = finding({ path: 'a', line: 1, severity: 'P1', title: '2:x' });
    const { findings, lateUnverified } = mergeVerdictsByLocation(
      [lookalike],
      [target],
      [{ index: 0, verdict: 'refuted' }],
      [target],
    );
    assert.deepEqual(
      findings.map((f) => f.title),
      ['2:x'],
    );
    assert.deepEqual(
      lateUnverified.map((f) => f.title),
      ['2:x'],
    );
  });

  it('fails open per finding: no verdict for a target means confirmed', () => {
    const { findings, lateUnverified } = mergeVerdictsByLocation(
      finalFindings,
      targets,
      [{ index: 0, verdict: 'refuted' }],
      targets,
    );
    assert.equal(findings.length, finalFindings.length - 1);
    assert.deepEqual(
      lateUnverified.map((f) => f.title),
      ['late blocking'],
    );
  });

  it('never counts snapshot findings the verification cap left unselected as late', () => {
    // MAX_VERIFIED_FINDINGS bounds the targets; an unselected snapshot finding
    // was not "late" — inflating the TASK-080 signal would reject the arm on
    // noise.
    const capped = finding({ path: 'd.ts', line: 4, severity: 'P2', title: 'over the cap' });
    const { findings, lateUnverified } = mergeVerdictsByLocation(
      [...targets, capped],
      targets,
      [{ index: 2, verdict: 'confirmed' }],
      [...targets, capped],
    );
    assert.equal(findings.length, 4);
    assert.deepEqual(lateUnverified, []);
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

  it('matches a changed-file anchor miss against its prior file-level thread', () => {
    const fileLevelThread = { path: 'src/example.ts', body: 'Missing provider options wiring' };
    const addable = new Map([['src/example.ts', new Set([5])]]);
    const { findings, suppressedCount } = suppressPreviouslyReported(
      [finding({ line: 99, title: 'Missing provider options wiring' })],
      [fileLevelThread],
      addable,
    );

    assert.equal(suppressedCount, 1);
    assert.equal(findings.length, 0);
  });

  it('does not treat a valid inline anchor as a file-level fallback', () => {
    const fileLevelThread = { path: 'src/example.ts', body: 'Missing provider options wiring' };
    const addable = new Map([['src/example.ts', new Set([5])]]);
    const { findings } = suppressPreviouslyReported(
      [finding({ line: 5, title: 'Missing provider options wiring' })],
      [fileLevelThread],
      addable,
    );

    assert.equal(findings.length, 1);
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

describe('shouldPostReviewComment', () => {
  it('always posts the first visible run, clean or not', () => {
    assert.equal(shouldPostReviewComment(0, 0), true);
    assert.equal(shouldPostReviewComment(0, 3), true);
  });

  it('posts a re-run only when it has findings', () => {
    assert.equal(shouldPostReviewComment(2, 0), false);
    assert.equal(shouldPostReviewComment(2, 1), true);
  });
});

describe('isPrCleanAfterRun', () => {
  it('is clean only with known thread state, no new findings, and no open threads', () => {
    assert.equal(isPrCleanAfterRun(0, 0, true), true);
    assert.equal(isPrCleanAfterRun(2, 0, true), false); // this run posted findings
    assert.equal(isPrCleanAfterRun(0, 1, true), false); // a finding thread is still open
    assert.equal(isPrCleanAfterRun(0, 0, false), false); // thread state could not be verified
  });
});

describe('openFindingThreadIds', () => {
  it('counts threads not already resolved and not resolved this run', () => {
    const threads = [
      { id: 't1', isResolved: false },
      { id: 't2', isResolved: false },
      { id: 't3', isResolved: true }, // resolved earlier / by a human → closed
    ];
    assert.deepEqual(openFindingThreadIds(threads, []), ['t1', 't2']);
    assert.deepEqual(openFindingThreadIds(threads, ['t1']), ['t2']);
    assert.deepEqual(openFindingThreadIds(threads, ['t1', 't2']), []);
  });

  it('keeps a thread open when its resolve failed (id not in resolvedThisRun)', () => {
    // The model claimed t1 addressed but the reply/resolve post failed, so t1
    // is NOT in resolvedThisRun → it stays open and blocks the 🚀.
    const threads = [{ id: 't1', isResolved: false }];
    assert.deepEqual(openFindingThreadIds(threads, []), ['t1']);
  });

  it('treats an already-resolved thread as closed regardless of this run', () => {
    assert.deepEqual(openFindingThreadIds([{ id: 't1', isResolved: true }], []), []);
  });
});

describe('resolveFindingAnchors', () => {
  const patch = [
    '@@ -1,1 +1,3 @@',
    ' const a = 1;',
    '+const total = order.total;',
    '+return total;',
  ].join('\n');
  const addable = new Map([['a.ts', new Set([2, 3])]]);
  const patchByPath = new Map([['a.ts', patch]]);

  it('moves only the findings whose line cannot anchor, in place', () => {
    const bogus = finding({ path: 'a.ts', line: 99, evidence: 'return total;' });
    const valid = finding({ path: 'a.ts', line: 2, evidence: 'const total = order.total;' });
    const declared = finding({ path: 'a.ts', line: 0, evidence: 'return total;' });
    const noEvidence = finding({ path: 'a.ts', line: 99 });

    const moved = resolveFindingAnchors(
      [bogus, valid, declared, noEvidence],
      addable,
      patchByPath,
      true,
    );

    assert.deepEqual(moved, [bogus]);
    assert.equal(bogus.line, 3, 're-anchored in place so every consumer agrees');
    assert.equal(valid.line, 2, 'an anchor corroborated by its evidence is left alone');
    assert.equal(declared.line, 0, 'line 0 stays an explicit file-level signal');
    assert.equal(noEvidence.line, 99, 'nothing to match without evidence');

    const off = finding({ path: 'a.ts', line: 99, evidence: 'return total;' });
    assert.deepEqual(resolveFindingAnchors([off], addable, patchByPath, false), []);
    assert.equal(off.line, 99, 'inert when evidence quotes are disabled');
  });

  it('leaves a finding alone when nothing matches its quote', () => {
    const unmatched = finding({ path: 'a.ts', line: 99, evidence: 'never appears' });
    const noPatch = finding({ path: 'other.ts', line: 99, evidence: 'return total;' });

    assert.deepEqual(resolveFindingAnchors([unmatched, noPatch], addable, patchByPath, true), []);
    assert.equal(unmatched.line, 99, 'an unmatched quote must not move the finding');
    assert.equal(noPatch.line, 99, 'nor may a path with no patch');
  });

  it('re-anchors an addable line its evidence contradicts, keeping corroborated ones', () => {
    // The claimed line parses as a valid anchor, but the quote uniquely lives
    // elsewhere — trusting the quote is the evidence contract's whole point.
    const wrong = finding({ path: 'a.ts', line: 2, evidence: 'return total;' });
    const insideWindow = finding({
      path: 'a.ts',
      line: 3,
      evidence: 'const total = order.total;\nreturn total;',
    });

    const moved = resolveFindingAnchors([wrong, insideWindow], addable, patchByPath, true);

    assert.deepEqual(moved, [wrong]);
    assert.equal(wrong.line, 3, 'moved to the line the evidence identifies');
    assert.equal(
      insideWindow.line,
      3,
      'a claimed line inside the evidence window is corroborated, not churned to the window anchor',
    );

    // Ambiguity fails closed exactly as it does for unanchorable lines.
    const ambiguousPatch = ['@@ -0,0 +1,3 @@', '+return x;', '+const y = 1;', '+return x;'].join(
      '\n',
    );
    const ambiguous = finding({ path: 'b.ts', line: 2, evidence: 'return x;' });
    resolveFindingAnchors(
      [ambiguous],
      new Map([['b.ts', new Set([1, 2, 3])]]),
      new Map([['b.ts', ambiguousPatch]]),
      true,
    );
    assert.equal(ambiguous.line, 2, 'ambiguous evidence leaves an addable claim untouched');

    // A context/added duplicate is still ambiguous: the added copy must not
    // win by being the only rescuable one.
    const mixedPatch = ['@@ -1,2 +1,3 @@', ' return x;', '+const z = 2;', '+return x;'].join('\n');
    const mixed = finding({ path: 'c.ts', line: 2, evidence: 'return x;' });
    resolveFindingAnchors(
      [mixed],
      new Map([['c.ts', new Set([2, 3])]]),
      new Map([['c.ts', mixedPatch]]),
      true,
    );
    assert.equal(mixed.line, 2, 'a context+added duplicate never moves an addable claim');
  });

  it('lets dedupe collapse one issue the model anchored to two different wrong lines', () => {
    // Why this runs before dedupe and suppression: both compare path:line, so a
    // finding left on a bad line escapes the collision it should have had.
    const a = finding({ path: 'a.ts', line: 40, evidence: 'return total;' });
    const b = finding({ path: 'a.ts', line: 99, evidence: 'return total;' });

    resolveFindingAnchors([a, b], addable, patchByPath, true);

    assert.equal(dedupeFindings([a], [b]).length, 1);
  });
});

describe('anchorFindings', () => {
  const addable = new Map([['a.ts', new Set([1, 2])]]);

  it('splits findings into inline, file-level, and orphaned buckets', () => {
    const fallback = finding({ path: 'a.ts', line: 99 });
    const out = anchorFindings(
      [
        finding({ path: 'a.ts', line: 1 }),
        finding({ path: 'a.ts', line: 0 }),
        fallback,
        finding({ path: 'outside.ts', line: 99 }),
      ],
      addable,
      true,
    );
    assert.deepEqual([out.inline.length, out.fileLevel.length, out.orphaned.length], [1, 2, 1]);
    assert.equal(fallback.line, 0);
    assert.deepEqual(out.anchorMissed, [fallback], 'a model-declared line 0 is not an anchor miss');
  });

  it('keeps findings outside the changed-file set in the review body', () => {
    const f = finding({ path: 'outside.ts', line: 99 });
    assert.equal(anchorFindings([f], addable, true).orphaned[0], f);
  });

  it('does not create a file-level route without a review head', () => {
    const f = finding({ path: 'a.ts', line: 99 });
    const out = anchorFindings([f], addable, false);
    assert.equal(out.orphaned[0], f);
    assert.equal(f.line, 99);
  });
});
