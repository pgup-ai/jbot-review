import { parseModelName } from '@symma/protocol';
import { modelAcceptsForcedToolChoice, modelSupportsAgenticTools } from './config.ts';
import { isContext7QuotaError } from './context7.ts';
import { appendGuidelineSweep, type GuidelineSweep } from './guideline-sweep.ts';
import { VERIFY_AGENT, type OptionTier } from './opencode-config.ts';
import { wrapUpReserveMs } from './time-budget.ts';
import type { OpencodeRuntime } from './opencode-server.ts';
import {
  agentForModel,
  createReviewSession,
  promptInSession,
  type PromptOutcome,
} from './opencode-session.ts';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  buildVerificationRecoveryPrompt,
  assembleGuidelineCompliancePrompt,
  assembleGuidelineSweepPrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
  CONTINUATION_NUDGE_PROMPT,
  isNoAttemptReply,
  withNoToolsReviewDirective,
} from './prompt.ts';
import type { TokenUsageRecorder } from './token-usage.ts';
import {
  sanitizeFinding,
  VALID_SEVERITIES,
  VALID_FINDING_KINDS,
  EVIDENCE_MAX_CHARS,
  type AddressedPriorComment,
  type Finding,
  type FindingVerdict,
  type ReviewResult,
} from './types.ts';

// Every name another module imports from here keeps resolving here.
export { type ProviderKeyConfig } from './opencode-config.ts';
export {
  sessionEnvDenyKeys,
  startOpencode,
  takeOpencodeProxyEnv,
  withCredentialEnvWithheld,
  type OpencodeRuntime,
} from './opencode-server.ts';
export {
  abortOpencodeSessionsByLabel,
  configureOpencodeTelemetry,
  configureSessionConcurrency,
  finalizeOpencodeSessionsByLabel,
  OPENCODE_TELEMETRY_CAPABILITY,
  Semaphore,
  type PromptOutcome,
  type SemaphorePriority,
} from './opencode-session.ts';
export { formatTokenUsage, type PromptTokenUsage, type TokenUsageRecorder } from './token-usage.ts';

const CONTEXT7_MCP_NAME = 'context7';
const CONTEXT7_MCP_URL = 'https://mcp.context7.com/mcp';
const CONTEXT7_MCP_TIMEOUT_MS = 15_000;

export async function enableContext7Mcp(
  runtime: OpencodeRuntime,
  apiKey: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return false;
  const { client, workspace } = runtime;
  const location = { directory: workspace };
  const signal = () => AbortSignal.timeout(CONTEXT7_MCP_TIMEOUT_MS);
  let added = false;
  try {
    await client.mcp.add(
      {
        server: CONTEXT7_MCP_NAME,
        location,
        // codemode false: the tools stay on the model's native list instead of behind `execute`.
        config: {
          type: 'remote',
          url: CONTEXT7_MCP_URL,
          headers: { CONTEXT7_API_KEY: trimmedKey },
          codemode: false,
        },
      },
      { signal: signal() },
    );
    added = true;
    await client.mcp.connect({ server: CONTEXT7_MCP_NAME, location }, { signal: signal() });
    log('Context7 MCP enabled for external API/SDK documentation checks.');
    return true;
  } catch (error) {
    if (added) await disableContext7Mcp(runtime, log);
    const detail = formatContext7Error(error, trimmedKey);
    const note = isContext7QuotaError(detail)
      ? 'Context7 out of credit or rate-limited; review continues with the framework-behavior abstention fallback (refill credit or rotate CONTEXT7_API_KEY to re-enable docs checks)'
      : 'Context7 MCP unavailable; continuing without it';
    log(`${note}: ${detail}`);
    return false;
  }
}

export async function disableContext7Mcp(
  runtime: OpencodeRuntime,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await runtime.client.mcp.disconnect(
      { server: CONTEXT7_MCP_NAME, location: { directory: runtime.workspace } },
      { signal: AbortSignal.timeout(CONTEXT7_MCP_TIMEOUT_MS) },
    );
  } catch (error) {
    log(`Context7 MCP disconnect skipped: ${formatContext7Error(error)}`);
  }
}

export function formatContext7Error(error: unknown, secret = ''): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = secret
    ? message.replace(new RegExp(escapeRegExp(secret), 'gi'), '[redacted]')
    : message;
  return redacted.replace(/ctx7sk-[A-Za-z0-9_-]+/gi, '[redacted]');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Shared by the pi engine (pi.ts); a timeout rejection never leaks an unhandled rejection. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // If the timeout wins, keep any later rejection from the original operation
  // from surfacing as an unhandled rejection.
  void promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(message);
          reject(error);
          try {
            onTimeout?.();
          } catch {
            // The caller logs this rejection; cancellation failure must not escape the timer.
            error.message += '; timeout cancellation failed';
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One review session → structured findings. A lens addendum (REVIEW_LENSES)
 * makes it a focused recall pass; the label keeps parallel passes' log lines
 * apart. Output is strict: an unparseable response gets ONE same-session
 * repair prompt before the run fails.
 */
export async function runReview(
  runtime: OpencodeRuntime,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  options: {
    guidelineSweep?: GuidelineSweep;
    lensAddendum?: string;
    contextFirst?: boolean;
    contextPack?: boolean;
    toolLess?: boolean;
    evidenceQuotes?: boolean;
    embeddedFirstPrompt?: boolean;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const deadlineAt = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
  const prompt = promptForModel(
    model,
    assembleReviewPrompt(
      prContext,
      guidelines,
      options.lensAddendum ?? '',
      options.evidenceQuotes ?? false,
      options.embeddedFirstPrompt ?? false,
      {
        toolsAvailable: !isSingleShotModel(model) && !options.toolLess,
        contextFirst: options.contextFirst,
        contextPack: options.contextPack,
      },
    ),
    options.toolLess,
  );
  log(`Prompt assembled (${label}): ${prompt.length} chars, guidelines=${!!guidelines}`);

  const outcome: PromptOutcome = { wrappedUp: false };
  const { raw, sessionID } = await promptPlanAgent(
    runtime,
    model,
    prompt,
    label,
    log,
    options.timeoutMs,
    options.onTokenUsage,
    outcome,
    { toolLess: options.toolLess },
  );
  let result: ReviewResult;
  try {
    result = parseReview(raw, label, log, { strict: true });
  } catch (error) {
    // A wrap-up reply is the last answer its deadline allows: a repair turn
    // would re-enable tools and a fresh timeout past it.
    if (outcome.wrappedUp) throw error;
    const repaired = await repromptForJson(
      runtime,
      model,
      sessionID,
      raw,
      error,
      label,
      log,
      options.timeoutMs,
      options.onTokenUsage,
    );
    result = parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
  // A fork candidate produced a result and carries the review ruleset (a tool-less
  // session's deny-all would stay under any rules added to its fork).
  if (!isSingleShotModel(model)) rememberReviewSession(runtime, label, sessionID);
  if (outcome.wrappedUp) result.partial = true;
  if (!options.guidelineSweep || outcome.wrappedUp) return result;
  const sweep = options.guidelineSweep;
  const sweepLabel = `guideline-sweep-${label}`;
  return appendGuidelineSweep(
    result,
    sweep,
    sweepLabel,
    deadlineAt,
    async (timeoutMs) => {
      const raw = await promptPlanAgentInSession(
        runtime,
        model,
        sessionID,
        promptForModel(model, assembleGuidelineSweepPrompt(sweep.guidelines)),
        sweepLabel,
        log,
        timeoutMs,
        options.onTokenUsage,
        label,
      );
      return parseReview(raw, sweepLabel, log, { strict: true }).findings;
    },
    log,
  );
}

/**
 * One same-session recovery re-prompt, shared by the main and auxiliary
 * sessions: a continuation for an abandoned turn (announcement/empty — a
 * reformat request there just elicits another announcement), the JSON repair
 * for a malformed attempt.
 */
async function repromptForJson(
  runtime: OpencodeRuntime,
  model: string,
  sessionID: string,
  raw: string,
  parseError: unknown,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const message = parseError instanceof Error ? parseError.message : String(parseError);
  if (isNoAttemptReply(raw)) {
    log(`${label} ended its turn without attempting the task; sending one continuation prompt`);
    return promptPlanAgentInSession(
      runtime,
      model,
      sessionID,
      CONTINUATION_NUDGE_PROMPT,
      `${label}-continue`,
      log,
      timeoutMs,
      onTokenUsage,
      label,
    );
  }
  log(`${label} response unparseable; sending one JSON repair prompt: ${message}`);
  return promptPlanAgentInSession(
    runtime,
    model,
    sessionID,
    buildJsonRepairPrompt(message),
    `${label}-repair`,
    log,
    timeoutMs,
    onTokenUsage,
    label,
  );
}

// Let the runner record failed coverage before applying its auxiliary fallback.
async function parseAuxSessionWithRepair<K extends 'findings' | 'addressedPriorComments'>(
  session: {
    runtime: OpencodeRuntime;
    model: string;
    sessionID: string;
    raw: string;
    label: string;
    log: (msg: string) => void;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
  },
  field: K,
): Promise<ReviewResult[K]> {
  const { runtime, model, sessionID, raw, label, log, timeoutMs, onTokenUsage } = session;
  try {
    return parseReview(raw, label, log, { strict: true, field })[field];
  } catch (error) {
    const repaired = await repromptForJson(
      runtime,
      model,
      sessionID,
      raw,
      error,
      label,
      log,
      timeoutMs,
      onTokenUsage,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true, field })[field];
  }
}

export async function runAddressedPriorCommentsCheck(
  runtime: OpencodeRuntime,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<AddressedPriorComment[]> {
  const prompt = promptForModel(model, assembleAddressedPriorCommentsPrompt(prContext));
  const { raw, sessionID } = await promptPlanAgent(
    runtime,
    model,
    prompt,
    'addressed-prior-comments',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseAuxSessionWithRepair(
    {
      runtime,
      model,
      sessionID,
      raw,
      label: 'addressed-prior-comments',
      log,
      timeoutMs,
      onTokenUsage,
    },
    'addressedPriorComments',
  );
}

export async function runGuidelineComplianceCheck(
  runtime: OpencodeRuntime,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<Finding[]> {
  const prompt = promptForModel(model, assembleGuidelineCompliancePrompt(prContext, guidelines));
  const { raw, sessionID } = await promptPlanAgent(
    runtime,
    model,
    prompt,
    'guideline-compliance',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseAuxSessionWithRepair(
    { runtime, model, sessionID, raw, label: 'guideline-compliance', log, timeoutMs, onTokenUsage },
    'findings',
  );
}

export async function runChangesSinceLastReview(
  runtime: OpencodeRuntime,
  model: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  // Its own single-shot variant carries the omitted-subjects disclosure a bare
  // no-tools directive would lack, so use that rather than promptForModel.
  const prompt = assembleChangesSinceLastReviewPrompt(deltaContext, isSingleShotModel(model));
  const { raw } = await promptPlanAgent(
    runtime,
    model,
    prompt,
    'changes-since-last-review',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseChangesSinceLastReviewSummary(raw, 'changes-since-last-review', log);
}

/**
 * Adversarially verifies blocking findings in a dedicated session. Returns
 * undefined when the verifier output cannot be used — the caller MUST treat
 * that as "verification unavailable" and keep the findings (fail-open): a
 * broken precision filter must never become a recall hole.
 */
export async function runFindingVerification(
  runtime: OpencodeRuntime,
  model: string,
  prContext: string,
  findings: Finding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  modelOptions?: Record<string, unknown>,
  mode?: 'single-shot' | 'capped',
): Promise<FindingVerdict[] | undefined> {
  const singleShot = isSingleShotModel(model) || mode === 'single-shot';
  const { providerID, modelID } = parseModelName(model);
  const agent =
    mode === 'capped' && modelAcceptsForcedToolChoice(providerID, modelID)
      ? VERIFY_AGENT
      : agentForModel(isSingleShotModel(model), runtime.reviewerAgent, mode === 'single-shot');
  const forkFrom = runtime.verifyFork ? singleReviewSession(runtime) : undefined;
  if (runtime.verifyFork && !forkFrom) {
    log('finding-verification: fork skipped (no single main review session)');
  }
  // Pass findings through unprojected: Finding is structurally a VerifiableFinding.
  // An earlier field-subset projection here silently dropped `evidence` and
  // defeated verifier grounding on this (primary) backend — don't reintroduce one.
  const prompt = assembleFindingVerificationPrompt(prContext, findings, singleShot);
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  log('Creating finding-verification session');
  const sessionID = await createReviewSession(runtime, {
    model,
    label: 'finding-verification',
    deadline,
    tier: modelOptions ? 'verify' : 'main',
    forkFrom,
    agent,
  });
  log(`finding-verification session created: ${sessionID}`);
  const reserve = deadline === undefined ? 0 : wrapUpReserveMs(deadline - Date.now());
  let verdicts: FindingVerdict[] | undefined;
  let failure: unknown;
  try {
    const remaining = deadline === undefined ? undefined : deadline - Date.now() - reserve;
    if (remaining !== undefined && remaining <= 0)
      throw new Error('Finding verification budget exhausted.');
    const raw = await promptInSession(runtime, sessionID, {
      model,
      text: prompt,
      label: 'finding-verification',
      log,
      timeoutMs: remaining,
      onTokenUsage,
    });
    verdicts = parseFindingVerdicts(raw, findings.length, log);
    if (verdicts?.length === findings.length) return verdicts;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/^opencode finding-verification prompt (?:did not finish within \d+s|settled without a completed assistant message)$/.test(
        error.message,
      )
    )
      throw error;
    failure = error;
  }
  if (deadline === undefined || deadline - Date.now() < 1000) {
    if (failure) throw failure;
    return verdicts;
  }
  const started = Date.now();
  const recoveryDeadline = Math.min(deadline, started + (reserve || 60_000));
  log(
    `Finding verification recovery: model=${model} reason=${failure ? 'interrupted' : 'unusable-output'} remainingMs=${recoveryDeadline - started}`,
  );
  try {
    const recoverySession = await createReviewSession(runtime, {
      model,
      label: 'finding-verification-recovery',
      tier: modelOptions ? 'verify' : 'main',
      agent,
      deadline: recoveryDeadline,
      forkFrom: sessionID,
    });
    const remaining = recoveryDeadline - Date.now();
    if (remaining <= 0) throw new Error('Finding verification recovery budget exhausted.');
    const raw = await promptInSession(runtime, recoverySession, {
      model,
      text: buildVerificationRecoveryPrompt(findings.length),
      label: 'finding-verification-recovery',
      log,
      timeoutMs: remaining,
      onTokenUsage,
    });
    const recovered = parseFindingVerdicts(raw, findings.length, log);
    const completed = new Map((verdicts ?? []).map((verdict) => [verdict.index, verdict]));
    for (const verdict of recovered ?? [])
      if (!completed.has(verdict.index)) completed.set(verdict.index, verdict);
    log(
      `Finding verification recovery: elapsedMs=${Date.now() - started} verdicts=${completed.size}/${findings.length}`,
    );
    return completed.size ? [...completed.values()] : undefined;
  } catch (error) {
    log(
      `Finding verification recovery failed: model=${model} elapsedMs=${Date.now() - started} error=${error instanceof Error ? error.message : String(error)}; preserving existing verdicts.`,
    );
    if (verdicts?.length) return verdicts;
    throw failure ?? error;
  }
}

const reviewSessionsByRuntime = new WeakMap<object, Map<string, string[]>>();

function rememberReviewSession(runtime: OpencodeRuntime, label: string, sessionID: string): void {
  const byLabel = reviewSessionsByRuntime.get(runtime) ?? new Map<string, string[]>();
  reviewSessionsByRuntime.set(runtime, byLabel);
  // The runner's retry of a failed attempt runs under `<label>-retry`; it is the same pass.
  const pass = label.replace(/-retry$/, '');
  byLabel.set(pass, [...(byLabel.get(pass) ?? []), sessionID]);
}

/** The one main review session; lens passes never count, and a sharded run yields none (a fork of one shard would bias the verifier). */
function singleReviewSession(runtime: OpencodeRuntime): string | undefined {
  const sessions = reviewSessionsByRuntime.get(runtime)?.get('review') ?? [];
  return sessions.length === 1 ? sessions[0] : undefined;
}

function isSingleShotModel(model: string): boolean {
  const { providerID, modelID } = parseModelName(model);
  return !modelSupportsAgenticTools(providerID, modelID);
}

/**
 * Prepend the no-tools directive for a single-shot model so the agentic review
 * prompt's "run git diff / explore the checkout" instructions don't make a
 * tool-trained model emit tool-call markup or "I'll inspect…" prose instead of
 * JSON. Passes with a tailored single-shot prompt variant (changes-since,
 * verification) use that instead. Agentic models are unchanged.
 */
function promptForModel(model: string, prompt: string, toolLess = false): string {
  return toolLess || isSingleShotModel(model) ? withNoToolsReviewDirective(prompt) : prompt;
}

async function promptPlanAgent(
  runtime: OpencodeRuntime,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  outcome?: PromptOutcome,
  session: { tier?: OptionTier; forkFrom?: string; toolLess?: boolean } = {},
): Promise<{ raw: string; sessionID: string }> {
  log(`Creating ${label} session`);
  const sessionID = await createReviewSession(runtime, {
    label,
    model,
    tier: session.tier,
    forkFrom: session.forkFrom,
    agent: agentForModel(isSingleShotModel(model), runtime.reviewerAgent, session.toolLess),
  });
  log(`${label} session created: ${sessionID}`);
  const text = await promptInSession(runtime, sessionID, {
    model,
    text: prompt,
    label,
    timeoutMs,
    log,
    onTokenUsage,
    outcome,
  });
  return { raw: text, sessionID };
}

async function promptPlanAgentInSession(
  runtime: OpencodeRuntime,
  model: string,
  sessionID: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  abortLabel = label,
): Promise<string> {
  return promptInSession(runtime, sessionID, {
    model,
    text: prompt,
    label,
    timeoutMs,
    log,
    onTokenUsage,
    abortLabel,
  });
}

/**
 * Defensively parses the agent's JSON. Main review output is strict so we
 * don't post a misleading "good to go" review when the reviewer response is
 * malformed; auxiliary checks send one repair prompt, then stay best-effort.
 * Exported for direct test coverage.
 */
export function parseReview(
  raw: string,
  label: string,
  log: (msg: string) => void,
  options: { strict?: boolean; field?: 'findings' | 'addressedPriorComments' } = {},
): ReviewResult {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`${label} response was not valid JSON: ${message}`);
    log(`${label} response preview:\n${truncateForLog(raw, 2000) || '<empty>'}`);
    if (options.strict) throw new Error(`${label} returned unparseable JSON: ${message}`);
    return {
      summary: 'The reviewer returned an unparseable response.',
      findings: [],
      addressedPriorComments: [],
    };
  }

  // A parseable non-object root (a bare array, a string) would read as a
  // silent zero-finding review; strict mode must throw so the repair prompt
  // gets its chance, and auxiliaries fail open as with any garbage.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log(`${label} response was valid JSON but not an object.`);
    if (options.strict) {
      throw new Error(`${label} returned a non-object JSON root`);
    }
    return {
      summary: 'The reviewer returned an unparseable response.',
      findings: [],
      addressedPriorComments: [],
    };
  }

  const obj = parsed as Record<string, unknown>;
  const field = options.field ?? 'findings';
  if (options.strict && !Array.isArray(obj[field]))
    throw new Error(`${label} returned JSON without a ${field} array`);
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const rawAddressed = Array.isArray(obj.addressedPriorComments) ? obj.addressedPriorComments : [];

  const findings: Finding[] = [];
  for (const item of rawFindings) {
    const finding = sanitizeFinding(item);
    if (finding) findings.push(finding);
  }
  const addressedPriorComments: AddressedPriorComment[] = [];
  for (const item of rawAddressed) {
    const addressed = item as Record<string, unknown>;
    const id = typeof addressed.id === 'string' ? addressed.id.trim() : '';
    if (!id) continue;
    // Accept both casings: the schema uses camelCase, but models normalize
    // inconsistently and historic prompts used snake_case.
    const rawCommit =
      typeof addressed.addressedByCommit === 'string'
        ? addressed.addressedByCommit
        : typeof addressed.addressed_by_commit === 'string'
          ? addressed.addressed_by_commit
          : undefined;
    addressedPriorComments.push({
      id,
      addressedByCommit: rawCommit?.trim(),
    });
  }

  return { summary, findings, addressedPriorComments };
}

const VALID_VERDICTS = new Set<FindingVerdict['verdict']>(['confirmed', 'refuted', 'uncertain']);

/**
 * Returns undefined for unusable responses and skips malformed entries;
 * `strict` throws instead so a caller can repair first.
 * Callers retain findings with missing verdicts as unverified advisories.
 */
export function parseFindingVerdicts(
  raw: string,
  findingCount: number,
  log: (msg: string) => void,
  options: { strict?: boolean } = {},
): FindingVerdict[] | undefined {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.strict)
      throw new Error(`finding-verification returned unparseable JSON: ${message}`);
    log(`finding-verification response was not valid JSON: ${message}`);
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.verdicts)) {
    if (options.strict)
      throw new Error('finding-verification returned JSON without a verdicts array');
    log('finding-verification response had no "verdicts" array.');
    return undefined;
  }

  const verdicts: FindingVerdict[] = [];
  const seen = new Set<number>();
  for (const item of obj.verdicts) {
    const v = item as Record<string, unknown>;
    if (
      typeof v.index === 'number' &&
      Number.isInteger(v.index) &&
      v.index >= 0 &&
      v.index < findingCount &&
      !seen.has(v.index) &&
      typeof v.verdict === 'string' &&
      VALID_VERDICTS.has(v.verdict as FindingVerdict['verdict'])
    ) {
      seen.add(v.index);
      const correction = v.finding as Record<string, unknown> | undefined;
      const finding =
        correction &&
        typeof correction.title === 'string' &&
        typeof correction.severity === 'string' &&
        VALID_SEVERITIES.has(correction.severity as Finding['severity']) &&
        typeof correction.kind === 'string' &&
        VALID_FINDING_KINDS.has(correction.kind as NonNullable<Finding['kind']>) &&
        typeof correction.evidence === 'string'
          ? {
              title: correction.title,
              severity: correction.severity as Finding['severity'],
              kind: correction.kind as Finding['kind'],
              evidence: correction.evidence.trim().slice(0, EVIDENCE_MAX_CHARS),
            }
          : undefined;
      verdicts.push({
        index: v.index,
        verdict: v.verdict as FindingVerdict['verdict'],
        reason: typeof v.reason === 'string' ? v.reason : undefined,
        ...(v.verdict === 'confirmed' && finding ? { finding } : {}),
      });
    }
  }
  return verdicts;
}

/**
 * Parses the "changes since last review" pass output. Unlike parseReview, an
 * unparseable or summary-less response yields '' (not a placeholder string) so
 * the caller OMITS the block — the pass fails open. `strict` throws instead so
 * a caller can repair first.
 */
export function parseChangesSinceLastReviewSummary(
  raw: string,
  label: string,
  log: (msg: string) => void,
  options: { strict?: boolean } = {},
): string {
  let summary: unknown;
  try {
    summary = (parseJsonObject(raw) as Record<string, unknown>).summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.strict) throw new Error(`${label} returned unparseable JSON: ${message}`);
    log(
      `${label} response was not valid JSON; omitting the changes-since-last-review block: ${message}`,
    );
    return '';
  }
  if (typeof summary === 'string') return summary.trim();
  if (options.strict) throw new Error(`${label} returned JSON without a summary string`);
  return '';
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('empty response');

  const candidates = [
    trimmed,
    ...extractFencedCodeBlocks(trimmed),
    ...extractBalancedJsonObjects(trimmed),
  ];
  const seen = new Set<string>();
  let lastError: unknown;

  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      return JSON.parse(normalized);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('no parseable JSON object found');
}

function extractFencedCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(text)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
}

function extractBalancedJsonObjects(text: string): string[] {
  const objects: string[] = [];
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = findBalancedObjectEnd(text, start);
    if (end !== -1) objects.push(text.slice(start, end + 1));
  }
  return objects;
}

function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function truncateForLog(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}\n...[truncated]`;
}
