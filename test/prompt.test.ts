import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADDRESSED_PRIOR_COMMENTS_PROMPT,
  FINDING_VERIFICATION_PROMPT,
  GUIDELINE_COMPLIANCE_OUTPUT_REMINDER,
  GUIDELINE_COMPLIANCE_PROMPT,
  REVIEW_LENSES,
  REVIEW_OUTPUT_REMINDER,
  REVIEW_PROMPT,
  VERIFICATION_OUTPUT_REMINDER,
  assembleAddressedPriorCommentsPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  formatFindingsForVerification,
  selectLensKeys,
} from '../src/shared/prompt.ts';

describe('REVIEW_PROMPT', () => {
  it('uses a concrete example instead of union syntax in the schema', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /"P0" \| "P1"/);
    assert.doesNotMatch(REVIEW_PROMPT, /"high" \| "medium"/);
    assert.match(REVIEW_PROMPT, /Field constraints:/);
    assert.match(REVIEW_PROMPT, /"severity": "P1"/);
  });

  it('does not ask the main review for addressed prior comments', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /addressedPriorComments/);
    assert.doesNotMatch(REVIEW_PROMPT, /addressed_by_commit/);
  });

  it('defers prior-thread handling to the canonical rules block', () => {
    // The detailed declined-thread rules live in formatPriorJbotThreadsForPrompt,
    // stated exactly once next to the thread data.
    assert.doesNotMatch(REVIEW_PROMPT, /intentionally declined/);
    assert.doesNotMatch(REVIEW_PROMPT, /Not applied/);
    assert.match(REVIEW_PROMPT, /canonical rules/i);
  });

  it('explains how the wrapper uses the output', () => {
    assert.match(REVIEW_PROMPT, /## How your output is used/);
    assert.match(REVIEW_PROMPT, /validated against the PR diff/);
  });

  it('keeps the line rule next to the field it governs', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /## Rules for lines/);
    assert.match(REVIEW_PROMPT, /ADDED by this PR/);
  });

  it('resolves the thoroughness/scope tension with one directive', () => {
    assert.doesNotMatch(REVIEW_PROMPT, /shortest context/);
    assert.match(REVIEW_PROMPT, /Do not explore code unrelated to the diff/);
  });

  it('tells the model to escape newlines inside JSON string values', () => {
    assert.match(REVIEW_PROMPT, /escape newlines inside string values as \\n/);
  });

  it('reviews architecture as a first-class dimension', () => {
    assert.match(REVIEW_PROMPT, /## Architecture and design/);
    assert.match(REVIEW_PROMPT, /"architecture"/);
    assert.match(REVIEW_PROMPT, /Architecture notes/);
  });

  it('demands full-PR scope on every run, never delta-only review', () => {
    assert.match(REVIEW_PROMPT, /ALWAYS review the COMPLETE pull request/);
    assert.match(REVIEW_PROMPT, /Never limit your\s+review to the most recent commit/);
    assert.match(REVIEW_PROMPT, /governs the "summary" field ONLY/);
    assert.doesNotMatch(REVIEW_PROMPT, /only add comments when new commits/);
  });

  it('includes a mandatory per-file coverage protocol', () => {
    assert.match(REVIEW_PROMPT, /## Mandatory coverage protocol/);
    assert.match(REVIEW_PROMPT, /UNCHANGED code elsewhere in the file or repo/);
    assert.match(REVIEW_PROMPT, /non-ASCII\s+input/);
  });

  it('verifies the PR description and docs against the implementation', () => {
    assert.match(REVIEW_PROMPT, /## Verify the PR's own claims/);
    assert.match(REVIEW_PROMPT, /documented behavior that the code does not implement/);
  });

  it('teaches the missed-bug shapes via calibration examples', () => {
    // Structural: five numbered examples exist, including at least one
    // negative example (a non-finding). Avoids pinning example prose.
    const section = REVIEW_PROMPT.split('## Calibration examples')[1]?.split('\n## ')[0] ?? '';
    const numberedExamples = section.match(/^\d+\.\s/gm) ?? [];
    assert.equal(numberedExamples.length, 5);
    assert.match(section, /→ no finding/);
  });

  it('allows line 0 for file-level findings on changed files', () => {
    assert.match(REVIEW_PROMPT, /or 0 for a\s+file-level finding on a changed file/);
  });

  it('mentions the embedded diff hunks as a starting point', () => {
    assert.match(REVIEW_PROMPT, /"Diff hunks" section/);
    assert.match(REVIEW_PROMPT, /not the boundary of your\s+investigation/);
  });
});

describe('REVIEW_LENSES', () => {
  it('provides interaction and integrity lenses that narrow attention, not scope', () => {
    assert.ok(Object.keys(REVIEW_LENSES).includes('interactions'));
    assert.ok(Object.keys(REVIEW_LENSES).includes('integrity'));
    for (const lens of Object.values(REVIEW_LENSES)) {
      assert.match(lens, /## Review lens for this pass/);
      assert.match(lens, /Still report any other clear bug/);
    }
  });

  it('is placed after the PR context and before the output reminder', () => {
    // Tail placement keeps the prompt prefix identical across parallel
    // passes (prefix-cache reuse) and puts the lens in the recency window.
    const prompt = assembleReviewPrompt('PR_CONTEXT_SENTINEL', '', REVIEW_LENSES.interactions);

    assert.ok(prompt.startsWith(REVIEW_PROMPT));
    const lensIndex = prompt.indexOf('## Review lens for this pass');
    assert.ok(lensIndex > prompt.indexOf('PR_CONTEXT_SENTINEL'));
    assert.ok(lensIndex < prompt.indexOf('## Final output reminder'));
  });
});

describe('selectLensKeys', () => {
  it('maps total passes to extra lens keys in declared order', () => {
    assert.deepEqual(selectLensKeys(1), []);
    assert.deepEqual(selectLensKeys(2), ['interactions']);
    assert.deepEqual(selectLensKeys(3), ['interactions', 'integrity']);
  });

  it('is safe at the extremes', () => {
    assert.deepEqual(selectLensKeys(0), []);
    assert.deepEqual(selectLensKeys(-5), []);
    assert.deepEqual(selectLensKeys(99), Object.keys(REVIEW_LENSES));
  });
});

describe('FINDING_VERIFICATION_PROMPT', () => {
  it('frames the verifier as adversarial with a refute-by-default stance', () => {
    assert.match(FINDING_VERIFICATION_PROMPT, /default position is\s+that each finding is WRONG/);
    assert.match(FINDING_VERIFICATION_PROMPT, /Do not propose new findings/);
  });

  it('uses concrete example verdicts instead of union syntax in the schema', () => {
    assert.doesNotMatch(FINDING_VERIFICATION_PROMPT, /"confirmed" \| "refuted"/);
    assert.match(FINDING_VERIFICATION_PROMPT, /"verdict": "confirmed"/);
    assert.match(FINDING_VERIFICATION_PROMPT, /Field constraints:/);
  });

  it('routes uncertain verdicts to advisory severity, not silence', () => {
    assert.match(FINDING_VERIFICATION_PROMPT, /posted as advisory/);
  });
});

describe('assembleFindingVerificationPrompt', () => {
  const findings = [
    { path: 'src/a.ts', line: 12, severity: 'P1', title: 'Title A', body: 'Body A' },
    { path: 'src/b.ts', line: 0, severity: 'P2', title: 'Title B', body: 'Body B' },
  ];

  it('numbers findings by index and places the reminder last', () => {
    const prompt = assembleFindingVerificationPrompt('PR_CONTEXT_SENTINEL', findings);

    assert.ok(prompt.startsWith(FINDING_VERIFICATION_PROMPT));
    assert.ok(prompt.endsWith(VERIFICATION_OUTPUT_REMINDER));
    assert.match(prompt, /### Finding 0/);
    assert.match(prompt, /### Finding 1/);
    assert.ok(prompt.indexOf('PR_CONTEXT_SENTINEL') < prompt.indexOf('### Finding 0'));
  });

  it('renders line-0 findings as file-level locations', () => {
    const block = formatFindingsForVerification(findings);

    assert.match(block, /Location: src\/a\.ts:12/);
    assert.match(block, /Location: src\/b\.ts\n/);
  });
});

describe('assembleReviewPrompt', () => {
  it('places the output reminder after all dynamic context', () => {
    const prompt = assembleReviewPrompt('PR_CONTEXT_SENTINEL', 'GUIDELINES_SENTINEL');

    assert.ok(prompt.startsWith(REVIEW_PROMPT));
    assert.ok(prompt.endsWith(REVIEW_OUTPUT_REMINDER));
    assert.ok(prompt.indexOf('GUIDELINES_SENTINEL') < prompt.indexOf('PR_CONTEXT_SENTINEL'));
    assert.ok(prompt.indexOf('PR_CONTEXT_SENTINEL') < prompt.indexOf('## Final output reminder'));
  });

  it('omits the guidelines section when guidelines are empty', () => {
    const prompt = assembleReviewPrompt('PR_CONTEXT_SENTINEL', '');

    assert.doesNotMatch(prompt, /## Repository review guidelines/);
  });
});

describe('assembleAddressedPriorCommentsPrompt', () => {
  it('places its own output reminder last', () => {
    const prompt = assembleAddressedPriorCommentsPrompt('PR_CONTEXT_SENTINEL');

    assert.ok(prompt.startsWith(ADDRESSED_PRIOR_COMMENTS_PROMPT));
    assert.match(prompt, /## Final output reminder/);
    assert.ok(prompt.indexOf('PR_CONTEXT_SENTINEL') < prompt.indexOf('## Final output reminder'));
  });
});

describe('ADDRESSED_PRIOR_COMMENTS_PROMPT', () => {
  it('uses camelCase schema keys consistently', () => {
    assert.match(ADDRESSED_PRIOR_COMMENTS_PROMPT, /"addressedByCommit"/);
    assert.doesNotMatch(ADDRESSED_PRIOR_COMMENTS_PROMPT, /addressed_by_commit/);
  });
});

describe('GUIDELINE_COMPLIANCE_PROMPT', () => {
  it('requires citing the violated rule in every finding', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /MUST name or quote the specific written rule/);
  });

  it('forbids P0 and nit severities for compliance findings', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /Do not use "P0" or "nit"/);
  });

  it('forbids inventing rules that are not written down', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /Do not invent rules/);
  });

  it('tells the auditor to read listed referenced docs', () => {
    assert.match(GUIDELINE_COMPLIANCE_PROMPT, /read every listed doc/);
  });
});

describe('assembleGuidelineCompliancePrompt', () => {
  it('places guidelines before context and the reminder last', () => {
    const prompt = assembleGuidelineCompliancePrompt('PR_CONTEXT_SENTINEL', 'GUIDELINES_SENTINEL');

    assert.ok(prompt.startsWith(GUIDELINE_COMPLIANCE_PROMPT));
    assert.ok(prompt.endsWith(GUIDELINE_COMPLIANCE_OUTPUT_REMINDER));
    assert.ok(prompt.indexOf('GUIDELINES_SENTINEL') < prompt.indexOf('PR_CONTEXT_SENTINEL'));
  });

  it('omits the guidelines section when they are embedded in the context', () => {
    const prompt = assembleGuidelineCompliancePrompt('PR_CONTEXT_SENTINEL', '');

    assert.doesNotMatch(prompt, /## Repository review guidelines/);
  });
});
