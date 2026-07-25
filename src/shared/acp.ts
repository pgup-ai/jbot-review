/**
 * ACP review backends: turns the protocol engine into the ReviewBackend the
 * runner consumes. Local (spawn) and remote (gateway) share everything here
 * and differ only in the prompt runner they are built with.
 */
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import { driveAcpSession, type AcpAgentSpec } from './acp-protocol.ts';
import { terminateProcessTree } from './cli-process.ts';
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
import { truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

const ACP_PROMPT_TIMEOUT_MS = 20 * 60_000;
const ACP_REPAIR_PROMPT_BUDGET_BYTES = 80_000;
const ACP_REPAIR_RESPONSE_BUDGET_BYTES = 20_000;
const ACP_KILL_GRACE_MS = 2_000;
const ACP_STDERR_TAIL_BYTES = 64 * 1024;

async function runAcpPrompt(
  spec: AcpAgentSpec,
  workspace: string,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = ACP_PROMPT_TIMEOUT_MS,
): Promise<string> {
  const { env, cleanup } = spec.env(model);
  const configOptionModelIds = spec.modelConfigCandidates?.(model);
  log(`Calling ${label} prompt (agent=acp:${spec.id}, model=${model})`);
  const child = spawn(spec.bin, spec.args(model), {
    cwd: workspace,
    // Same process-group contract as cli-process.ts: a wedged agent (and any
    // child it spawned) can never outlive the review.
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-ACP_STDERR_TAIL_BYTES);
  });
  child.stdin?.on('error', (error: Error) => {
    stderr += `\n[stdin error: ${error.message}]`;
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      driveAcpSession(
        { input: child.stdin as Writable, output: child.stdout as Readable },
        {
          cwd: workspace,
          prompt,
          agent: spec.id,
          label,
          log,
          model,
          configOptionModelIds,
          requirePlanMode: spec.requirePlanMode,
        },
      ),
      new Promise<never>((_, reject) => {
        child.on('error', reject);
        child.on('close', (code) =>
          reject(
            new Error(
              `acp:${spec.id} ${label} exited ${code} before responding: ${truncateForLog(stderr, 1000)}`,
            ),
          ),
        );
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `acp:${spec.id} ${label} prompt timed out after ${Math.round(timeoutMs / 1000)}s (model=${model})`,
              ),
            ),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
    log(
      `${label} prompt complete via acp:${spec.id}: stopReason=${result.stopReason} last-message=${result.text.length} chars`,
    );
    if (!result.text) {
      throw new Error(
        `acp:${spec.id} ${label} produced no assistant message (stopReason=${result.stopReason}); stderr: ${truncateForLog(stderr, 1000)}`,
      );
    }
    return result.text;
  } finally {
    if (timer) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      terminateProcessTree(child, ACP_KILL_GRACE_MS);
    }
    // Wait (bounded) for the exit before removing the temp home: a dying
    // agent still writing there (kilo's SQLite) races rmSync into ENOTEMPTY.
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const grace = setTimeout(resolve, ACP_KILL_GRACE_MS + 500);
      grace.unref();
      child.once('close', () => {
        clearTimeout(grace);
        resolve();
      });
    });
    try {
      cleanup?.();
    } catch {
      // Teardown must never mask the session result; tmpdir reclaims leftovers.
    }
  }
}

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
    runAcpPrompt(spec, workspace, model, prompt, label, log, timeoutMs),
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
