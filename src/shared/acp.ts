/**
 * ACP review backends: turns the protocol engine into the ReviewBackend the
 * runner consumes. Local (spawn) and remote (gateway) share everything here
 * and differ only in the prompt runner they are built with.
 */

import { runLocalAcpPrompt } from '@symma/client';
import type { AcpAgentSpec } from '@symma/protocol';
import {
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
} from './opencode.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairFollowupPrompt,
} from './prompt.ts';
import type { ReviewBackend } from './session-concurrency.ts';
import { makeSessionTee } from './observer.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

// Repair-followup budgets: review policy, not session mechanics.
const ACP_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const ACP_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

/** Delivers one assembled prompt to an agent and returns its final text. */
type AcpPromptRunner = (
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
) => Promise<string>;

export function createAcpBackend(spec: AcpAgentSpec, workspace: string): ReviewBackend {
  return createAcpReviewBackend(`acp:${spec.id}`, (model, prompt, label, log, timeoutMs) =>
    runLocalAcpPrompt(spec, workspace, model, prompt, label, log, {
      timeoutMs,
      tee: makeSessionTee(spec.id, label, model),
    }),
  );
}

/** Every backend method reduces to "send a prompt, parse the reply", so local
 * (spawn) and remote (gateway) backends share this whole surface — prompt
 * assembly, parsing, and the single JSON repair retry — and differ only in the
 * runner they are built with. */
export function createAcpReviewBackend(name: string, run: AcpPromptRunner): ReviewBackend {
  return {
    name,
    async runReview(model, prContext, guidelines, log, options = {}): Promise<ReviewResult> {
      // ACP carries usage in usage_update, but mirror the other CLI backends and skip it.
      void options.onTokenUsage;
      const label = options.label ?? 'review';
      const prompt = assembleReviewPrompt(
        prContext,
        guidelines,
        options.lensAddendum ?? '',
        options.evidenceQuotes ?? false,
      );
      log(
        `Prompt assembled (${label}, ${name}): ${prompt.length} chars, guidelines=${!!guidelines}`,
      );
      const raw = await run(model, prompt, label, log, options.timeoutMs);
      try {
        return parseReview(raw, label, log, { strict: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(
          `${label} response unparseable; sending one JSON repair prompt via ${name}: ${message}`,
        );
        const repaired = await run(
          model,
          buildJsonRepairFollowupPrompt({
            originalPrompt: prompt,
            invalidResponse: raw,
            parseError: message,
            promptBudgetBytes: ACP_REPAIR_PROMPT_BUDGET_BYTES,
            responseBudgetBytes: ACP_REPAIR_RESPONSE_BUDGET_BYTES,
          }),
          `${label}-repair`,
          log,
          options.timeoutMs,
        );
        return parseReview(repaired, `${label}-repair`, log, { strict: true });
      }
    },
    async runAddressedPriorCommentsCheck(
      model,
      prContext,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<AddressedPriorComment[]> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleAddressedPriorCommentsPrompt(prContext),
        'addressed-prior-comments',
        log,
        timeoutMs,
      );
      return parseReview(raw, 'addressed-prior-comments', log).addressedPriorComments;
    },
    async runGuidelineComplianceCheck(
      model,
      prContext,
      guidelines,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<Finding[]> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleGuidelineCompliancePrompt(prContext, guidelines),
        'guideline-compliance',
        log,
        timeoutMs,
      );
      return parseReview(raw, 'guideline-compliance', log).findings;
    },
    async runFindingVerification(
      model,
      prContext,
      findings,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<FindingVerdict[] | undefined> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleFindingVerificationPrompt(prContext, findings),
        'finding-verification',
        log,
        timeoutMs,
      );
      return parseFindingVerdicts(raw, findings.length, log);
    },
    async runChangesSinceLastReview(
      model,
      prContext,
      deltaContext,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<string> {
      void onTokenUsage;
      const raw = await run(
        model,
        assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
        'changes-since-last-review',
        log,
        timeoutMs,
      );
      return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
    },
  };
}

// No cline spec: its ACP prompt loop returns end_turn with no output
// (cline/cline#11015, reproduced on 3.0.34 and 3.0.46) — revive from git
// history once upstream fixes it.
