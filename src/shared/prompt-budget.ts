import type { ReviewBackend } from './session-concurrency.ts';
import { measureReviewPrompt, type ReviewPromptBudget } from './review-plan.ts';
import {
  assembleReviewPrompt,
  assembleGuidelineCompliancePrompt,
  assembleFindingVerificationPrompt,
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
} from './prompt.ts';

export function budgetReviewBackend(
  backend: ReviewBackend,
  budget: ReviewPromptBudget,
): ReviewBackend {
  const check = (prompt: string) => {
    const measured = measureReviewPrompt(prompt, budget);
    if (!measured.fits)
      throw new Error(
        `Incomplete review: assembled prompt (${measured.promptBytes} bytes) exceeds the input-token or transport budget.`,
      );
  };
  return {
    ...backend,
    async runReview(model, context, guidelines, log, options) {
      check(
        assembleReviewPrompt(
          context,
          guidelines,
          options?.lensAddendum,
          options?.evidenceQuotes,
          options?.embeddedFirstPrompt,
          { toolsAvailable: backend.canReadWorkspace, contextFirst: options?.contextFirst },
        ),
      );
      return backend.runReview(model, context, guidelines, log, options);
    },
    async runGuidelineComplianceCheck(model, context, guidelines, ...rest) {
      check(assembleGuidelineCompliancePrompt(context, guidelines));
      return backend.runGuidelineComplianceCheck(model, context, guidelines, ...rest);
    },
    async runFindingVerification(model, context, findings, ...rest) {
      check(assembleFindingVerificationPrompt(context, findings));
      return backend.runFindingVerification(model, context, findings, ...rest);
    },
    async runAddressedPriorCommentsCheck(model, context, ...rest) {
      check(assembleAddressedPriorCommentsPrompt(context));
      return backend.runAddressedPriorCommentsCheck(model, context, ...rest);
    },
    async runChangesSinceLastReview(model, context, ...rest) {
      check(assembleChangesSinceLastReviewPrompt(context));
      return backend.runChangesSinceLastReview(model, context, ...rest);
    },
  };
}
