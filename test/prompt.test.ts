import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADDRESSED_PRIOR_COMMENTS_PROMPT,
  GUIDELINE_COMPLIANCE_OUTPUT_REMINDER,
  GUIDELINE_COMPLIANCE_PROMPT,
  REVIEW_OUTPUT_REMINDER,
  REVIEW_PROMPT,
  assembleAddressedPriorCommentsPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
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

describe('REVIEW_PROMPT bug archetypes', () => {
  it('enumerates high-recall failure archetypes to actively check', () => {
    assert.match(REVIEW_PROMPT, /## Bug archetypes to actively check/);
    assert.match(REVIEW_PROMPT, /Map or record writes inside a loop/);
    assert.match(REVIEW_PROMPT, /first-write-wins/);
    assert.match(REVIEW_PROMPT, /Snapshots of mutable objects/);
    assert.match(REVIEW_PROMPT, /Duplicate or aliased inputs/);
  });

  it('preserves the concrete-trigger-path bar while prompting hypotheses', () => {
    assert.match(REVIEW_PROMPT, /concrete-trigger-path bar/);
  });

  it('warns that tests are not proof of correctness', () => {
    assert.match(REVIEW_PROMPT, /Tests are not proof of correctness/);
  });
});
