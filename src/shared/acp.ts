/**
 * ACP review backends: wraps a prompt runner in the ReviewBackend the runner
 * consumes, and parses what the agent returns. Local and remote share
 * everything here and differ only in the runner they are built with.
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
  buildContinuationFollowupPrompt,
  buildJsonRepairFollowupPrompt,
} from './prompt.ts';
import type { ReviewBackend } from './session-concurrency.ts';
import { makeSessionTee } from './observer.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';
import {
  classifyReadonlyTool,
  serializedBytes,
  toolIdentity,
  type ToolTelemetryAccumulator,
  type ToolTelemetryFinish,
} from './tool-telemetry.ts';

const ACP_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const ACP_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;

const LOCAL_ACP_TELEMETRY_CAPABILITY = 'observable' as const;

/** Delivers one assembled prompt to an agent and returns its final text. */
type AcpPromptRunner = (
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
) => Promise<string>;

export function createAcpBackend(
  spec: AcpAgentSpec,
  workspace: string,
  toolTelemetry?: ToolTelemetryAccumulator,
): ReviewBackend {
  return createAcpReviewBackend(`acp:${spec.id}`, async (model, prompt, label, log, timeoutMs) => {
    const telemetryTee = toolTelemetry
      ? createAcpTelemetryTee(toolTelemetry, `acp:${spec.id}`, label)
      : undefined;
    try {
      return await runLocalAcpPrompt(spec, workspace, model, prompt, label, log, {
        timeoutMs,
        tee: composeAcpTees(makeSessionTee(spec.id, label, model), telemetryTee?.tee),
      });
    } finally {
      telemetryTee?.finishPending();
    }
  });
}

function composeAcpTees(
  first?: (dir: 'out' | 'in', frame: Record<string, unknown>) => void,
  second?: (dir: 'out' | 'in', frame: Record<string, unknown>) => void,
): ((dir: 'out' | 'in', frame: Record<string, unknown>) => void) | undefined {
  if (!first) return second;
  if (!second) return first;
  return (dir, frame) => {
    first(dir, frame);
    second(dir, frame);
  };
}

export function createAcpTelemetryTee(
  telemetry: ToolTelemetryAccumulator,
  backend: string,
  session: string,
): {
  tee: (dir: 'out' | 'in', frame: Record<string, unknown>) => void;
  finishPending: () => void;
} {
  const pending = new Map<string, (finish: ToolTelemetryFinish) => void>();
  const tee = (dir: 'out' | 'in', frame: Record<string, unknown>): void => {
    if (dir !== 'in' || frame.method !== 'session/update') return;
    const params = isObject(frame.params) ? frame.params : {};
    const update = isObject(params.update) ? params.update : {};
    const kind = update.sessionUpdate;
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return;
    const id = String(update.toolCallId ?? update.id ?? '');
    if (!id) return;
    let finish = pending.get(id);
    if (!finish) {
      const name = String(update.kind ?? update.title ?? update.name ?? 'unknown');
      const input = update.rawInput ?? update.input;
      const toolClass = classifyReadonlyTool(name, input);
      finish = telemetry.startTool({
        session,
        backend,
        capability: LOCAL_ACP_TELEMETRY_CAPABILITY,
        toolClass,
        inputBytes: serializedBytes(input),
        ...toolIdentity(toolClass, input),
      });
      pending.set(id, finish);
    }
    const status = String(update.status ?? '').toLowerCase();
    if (!['completed', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) return;
    const output = update.rawOutput ?? update.output ?? update.content;
    const bytes = serializedBytes(output);
    finish({
      success: status === 'completed',
      ...(status === 'completed' ? {} : { failureClass: 'execution' as const }),
      outputBytesBeforeCap: bytes,
      outputBytesAfterCap: bytes,
      ...(typeof update.durationMs === 'number' ? { durationMs: update.durationMs } : {}),
    });
    pending.delete(id);
  };
  return {
    tee,
    finishPending: () => {
      for (const finish of pending.values()) {
        finish({
          success: false,
          failureClass: 'unknown',
          outputBytesBeforeCap: 0,
          outputBytesAfterCap: 0,
        });
      }
      pending.clear();
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every backend method reduces to "send a prompt, parse the reply", so local
 * (spawn) and remote (gateway) backends share this whole surface — prompt
 * assembly, parsing, and the recovery follow-ups — and differ only in the
 * runner they are built with. */
export function createAcpReviewBackend(name: string, run: AcpPromptRunner): ReviewBackend {
  // The client throws when a turn ends with no assistant message; for recovery
  // purposes that is the same "never attempted the task" state as a plan-only
  // reply, so it maps to '' instead of failing the session outright. The
  // message text is owned by @symma/client.
  const deliver = async (
    model: string,
    prompt: string,
    label: string,
    log: (msg: string) => void,
    timeoutMs?: number,
  ): Promise<string> => {
    try {
      return await run(model, prompt, label, log, timeoutMs);
    } catch (error) {
      if (error instanceof Error && /produced no assistant message/.test(error.message)) return '';
      throw error;
    }
  };

  /**
   * One prompt with two distinct recoveries, one attempt each:
   * - no JSON at all (a plan announcement, or an empty turn) → a CONTINUATION
   *   prompt: there is nothing to reformat, and asking for a reformat just
   *   elicits another announcement (observed with devin/glm-5.2);
   * - JSON-ish but unparseable → the reformat repair prompt.
   * Sessions are one-shot processes, so both re-carry the original prompt.
   */
  const promptWithRecovery = async <T>(
    model: string,
    prompt: string,
    label: string,
    log: (msg: string) => void,
    timeoutMs: number | undefined,
    parse: (raw: string, parseLabel: string) => T,
  ): Promise<T> => {
    // Parse with the reformat fallback — used for the direct reply and again
    // for a continuation reply, so a malformed continuation still gets its
    // repair instead of failing the session.
    const parseWithRepair = async (raw: string, parseLabel: string): Promise<T> => {
      try {
        return parse(raw, parseLabel);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(
          `${parseLabel} response unparseable; sending one JSON repair prompt via ${name}: ${message}`,
        );
        const repaired = await deliver(
          model,
          buildJsonRepairFollowupPrompt({
            originalPrompt: prompt,
            invalidResponse: raw,
            parseError: message,
            promptBudgetBytes: ACP_REPAIR_PROMPT_BUDGET_BYTES,
            responseBudgetBytes: ACP_REPAIR_RESPONSE_BUDGET_BYTES,
          }),
          `${parseLabel}-repair`,
          log,
          timeoutMs,
        );
        return parse(repaired, `${parseLabel}-repair`);
      }
    };

    const raw = await deliver(model, prompt, label, log, timeoutMs);
    // Any JSON delimiter counts as an attempt: an array-shaped reply is wrong
    // but reformable (or fails open in its parser) — only delimiter-free text
    // is an abandoned turn worth a continuation.
    if (!raw.includes('{') && !raw.includes('[')) {
      log(`${label} ended its turn without attempting the task; sending one continuation prompt`);
      const continued = await deliver(
        model,
        buildContinuationFollowupPrompt({
          originalPrompt: prompt,
          previousResponse: raw,
          promptBudgetBytes: ACP_REPAIR_PROMPT_BUDGET_BYTES,
          responseBudgetBytes: ACP_REPAIR_RESPONSE_BUDGET_BYTES,
        }),
        `${label}-continue`,
        log,
        timeoutMs,
      );
      if (!continued.includes('{') && !continued.includes('[')) {
        // Observed with devin/glm-5.2 on large reviews: the model announces a
        // plan and stops, even when the continuation explicitly forbids it —
        // while completing small prompts fine. Name the condition and the
        // lever instead of reporting a generic parse failure.
        throw new Error(
          `${label}: the agent twice ended its turn without attempting the task (an announcement, then again after an explicit continuation). This model/CLI pairing appears unable to complete a session of this size in one turn — try more shards (review-shards: 0 for auto) or a different model/backend.`,
        );
      }
      return parseWithRepair(continued, `${label}-continue`);
    }
    return parseWithRepair(raw, label);
  };

  return {
    name,
    observability: LOCAL_ACP_TELEMETRY_CAPABILITY,
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
      return promptWithRecovery(model, prompt, label, log, options.timeoutMs, (raw, parseLabel) =>
        parseReview(raw, parseLabel, log, { strict: true }),
      );
    },
    async runAddressedPriorCommentsCheck(
      model,
      prContext,
      log,
      timeoutMs,
      onTokenUsage,
    ): Promise<AddressedPriorComment[]> {
      void onTokenUsage;
      return promptWithRecovery(
        model,
        assembleAddressedPriorCommentsPrompt(prContext),
        'addressed-prior-comments',
        log,
        timeoutMs,
        (raw, parseLabel) => parseReview(raw, parseLabel, log).addressedPriorComments,
      );
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
      return promptWithRecovery(
        model,
        assembleGuidelineCompliancePrompt(prContext, guidelines),
        'guideline-compliance',
        log,
        timeoutMs,
        (raw, parseLabel) => parseReview(raw, parseLabel, log).findings,
      );
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
      return promptWithRecovery(
        model,
        assembleFindingVerificationPrompt(prContext, findings),
        'finding-verification',
        log,
        timeoutMs,
        (raw) => parseFindingVerdicts(raw, findings.length, log),
      );
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
      return promptWithRecovery(
        model,
        assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
        'changes-since-last-review',
        log,
        timeoutMs,
        (raw, parseLabel) => parseChangesSinceLastReviewSummary(raw, parseLabel, log),
      );
    },
  };
}

// No cline spec: its ACP prompt loop returns end_turn with no output
// (cline/cline#11015, reproduced on 3.0.34 and 3.0.46) — revive from git
// history once upstream fixes it.
