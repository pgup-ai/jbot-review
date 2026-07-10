import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseModelName } from './model.ts';
import {
  formatTokenUsage,
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  withTimeout,
} from './opencode.ts';
import type { PromptTokenUsage, ProviderKeyConfig, TokenUsageRecorder } from './opencode.ts';
import {
  PI_REVIEW_SYSTEM_PROMPT,
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
} from './prompt.ts';
import { isFiniteNumber, isRecord } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';

/**
 * pi SDK engine: in-process review sessions via @earendil-works/pi-coding-agent,
 * routed per role by `selectReviewBackends` for providers on the verified
 * allowlist below. opencode remains the SDK engine for everything else; with
 * pi disabled (kill switch, old Node, unsupported provider) behavior is
 * identical to before this module existed.
 */

const PI_PROMPT_TIMEOUT_MS = 15 * 60_000;
const PI_ABORT_TIMEOUT_MS = 10_000;
const PI_MODEL_LIST_LOG_CAP = 40;

/** pi-coding-agent (and its bundled undici) declare engines.node >= 22.19.0. */
export const PI_MIN_NODE_VERSION = '22.19.0';

/**
 * Static capability allowlist (never probe-and-see), mapped to pi's provider
 * IDs. Every entry was verified against pi 0.80's model catalog: provider id,
 * runtime key injection, and the repo default model id all resolve. nvidia is
 * deliberately absent (its default model is missing from pi's catalog);
 * opencode/opencode-go are opencode's own gateways.
 */
const PI_PROVIDER_IDS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  deepseek: 'deepseek',
  xai: 'xai',
  openrouter: 'openrouter',
  'fireworks-ai': 'fireworks',
  'zai-coding-plan': 'zai',
  'xiaomi-token-plan-sgp': 'xiaomi-token-plan-sgp',
};

export function piSupportsProvider(providerID: string): boolean {
  return Object.hasOwn(PI_PROVIDER_IDS, providerID);
}

export function piProviderIDFor(providerID: string): string | undefined {
  return PI_PROVIDER_IDS[providerID];
}

export function piRuntimeSupported(nodeVersion: string): boolean {
  const version = parseSemver(nodeVersion);
  if (!version) return false;
  const floor = parseSemver(PI_MIN_NODE_VERSION) as [number, number, number];
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}

function parseSemver(value: string): [number, number, number] | undefined {
  const match = value
    .trim()
    .replace(/^v/, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Kill switch + runtime gate, resolved once per run and fed to
 * `selectReviewBackends` as `piEnabled`. JBOT_SDK_ENGINE accepts `auto`
 * (default) and `opencode`; anything else fails safe to opencode so a config
 * typo can never force a broken engine.
 */
export function resolvePiEngine(
  env: NodeJS.ProcessEnv,
  nodeVersion: string,
): { enabled: boolean; reason: string } {
  const engine = env.JBOT_SDK_ENGINE?.trim() || 'auto';
  if (engine === 'opencode') {
    return { enabled: false, reason: 'JBOT_SDK_ENGINE=opencode pins the opencode engine' };
  }
  if (engine !== 'auto') {
    return {
      enabled: false,
      reason: `unknown JBOT_SDK_ENGINE value "${engine}"; using the opencode engine`,
    };
  }
  if (!piRuntimeSupported(nodeVersion)) {
    return {
      enabled: false,
      reason: `Node ${nodeVersion} is below the pi engine floor (>= ${PI_MIN_NODE_VERSION})`,
    };
  }
  return { enabled: true, reason: '' };
}

const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The one modelOptions key the pi engine honors: reasoningEffort values that
 * are also pi thinking levels map through; everything else is provider-SDK
 * passthrough that only opencode understands.
 */
export function piThinkingLevel(modelOptions?: Record<string, unknown>): string | undefined {
  const effort = modelOptions?.reasoningEffort;
  return typeof effort === 'string' && PI_THINKING_LEVELS.has(effort) ? effort : undefined;
}

/**
 * Read-only toolset (invariant 8). Unlike opencode, pi ships no sandbox and no
 * permission layer — "Pi does not include a built-in sandbox" — so a shell here
 * could not be constrained by config or prompt: redirection (`echo x > f`) and
 * wrappers (`sh -c`) defeat any command filter. The toolset IS the enforcement,
 * so bash is withheld entirely and mutation is impossible by construction.
 *
 * The review does not need a shell: the full diff is embedded in the prompt
 * (diff-context.ts) and blast-radius runs git grep in the runner, outside the
 * session — the same posture the cline backend already reviews under.
 * Single-shot sessions disable even these tools.
 */
export const PI_SESSION_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/**
 * Maps a pi assistant-message usage object onto PromptTokenUsage. Defensive
 * about field spellings (`input` vs `inputTokens`) and missing counters —
 * same stance as formatTokenUsage on the opencode side.
 */
export function mapPiUsage(usage: unknown): PromptTokenUsage | undefined {
  if (typeof usage !== 'object' || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  const count = (...candidates: unknown[]): number => {
    for (const candidate of candidates) if (isFiniteNumber(candidate)) return candidate;
    return 0;
  };
  const cost = isRecord(u.cost) ? u.cost.total : undefined;
  return {
    input: count(u.input, u.inputTokens),
    output: count(u.output, u.outputTokens),
    reasoning: count(u.reasoning, u.reasoningTokens),
    cacheRead: count(u.cacheRead, u.cacheReadTokens),
    cacheWrite: count(u.cacheWrite, u.cacheWriteTokens),
    ...(isFiniteNumber(cost) ? { costUsd: cost } : {}),
  };
}

type PiMessageLike = { role?: unknown; content?: unknown; usage?: unknown };

/**
 * Totals usage across EVERY assistant turn in `messages`. A tool-using prompt
 * yields one assistant message per turn, so reading only the last one would
 * bill the final turn and silently drop the rest.
 */
export function sumPiUsage(messages: unknown): PromptTokenUsage | undefined {
  if (!Array.isArray(messages)) return undefined;
  const total: PromptTokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let seen = false;
  let cost: number | undefined;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant') continue;
    const usage = mapPiUsage((message as PiMessageLike).usage);
    if (!usage) continue;
    seen = true;
    total.input += usage.input;
    total.output += usage.output;
    total.reasoning += usage.reasoning;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    if (isFiniteNumber(usage.costUsd)) cost = (cost ?? 0) + usage.costUsd;
  }
  if (!seen) return undefined;
  return { ...total, ...(isFiniteNumber(cost) ? { costUsd: cost } : {}) };
}

function lastAssistantMessage(messages: unknown): PiMessageLike | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as PiMessageLike;
    if (isRecord(message) && message.role === 'assistant') return message;
  }
  return undefined;
}

/**
 * Final text of the last assistant message. Accepts both content shapes pi
 * has shipped (plain string and text-block arrays); an empty result surfaces
 * as a parse failure upstream so the repair loop fires.
 */
export function extractPiFinalText(messages: unknown): string {
  const message = lastAssistantMessage(messages);
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

// Structural views of the pi SDK surface this module uses. Local types keep
// typecheck independent of the 0.x package's own declarations; the dynamic
// import is cast through them.
interface PiAuthStorageLike {
  setRuntimeApiKey(providerID: string, apiKey: string): void;
}
interface PiModelRegistryLike {
  find(providerID: string, modelID: string): unknown;
  getAll(): ReadonlyArray<{ provider?: string; id?: string }>;
}
interface PiResourceLoaderLike {
  reload(): Promise<void>;
}
interface PiAgentSessionLike {
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<unknown>;
  abort(): Promise<void>;
  dispose?: () => unknown;
  messages?: unknown;
  agent?: { state?: { messages?: unknown } };
}
interface PiSdkLike {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiAgentSessionLike }>;
  AuthStorage: { inMemory(): PiAuthStorageLike };
  ModelRegistry: new (authStorage: PiAuthStorageLike) => PiModelRegistryLike;
  DefaultResourceLoader: new (options: Record<string, unknown>) => PiResourceLoaderLike;
  SessionManager: { inMemory(): unknown };
  SettingsManager: { inMemory(settings: Record<string, unknown>): unknown };
}

/**
 * Lazy singleton import: environments that never route to pi (old Node,
 * kill switch, no allowlisted provider) must not even load the package —
 * its bundled undici throws at import time below Node 22.19.
 */
let piSdkPromise: Promise<PiSdkLike> | undefined;
function loadPiSdk(): Promise<PiSdkLike> {
  piSdkPromise ??= import('@earendil-works/pi-coding-agent').then(
    (mod) => mod as unknown as PiSdkLike,
    (error: unknown) => {
      piSdkPromise = undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `pi engine failed to load @earendil-works/pi-coding-agent (requires Node >= ${PI_MIN_NODE_VERSION}): ${message}. ` +
          'Set JBOT_SDK_ENGINE=opencode to pin the opencode engine.',
      );
    },
  );
  return piSdkPromise;
}

export interface PiRuntime {
  sdk: PiSdkLike;
  authStorage: PiAuthStorageLike;
  registry: PiModelRegistryLike;
  loader: PiResourceLoaderLike;
  workspace: string;
  /** Full `provider/model` — a bare model ID collides across providers. */
  mainModel: string;
  thinkingLevel?: string;
}

function requirePiProvider(providerID: string): string {
  const piID = piProviderIDFor(providerID);
  if (!piID) {
    throw new Error(`Provider "${providerID}" is not on the pi engine allowlist.`);
  }
  return piID;
}

function requirePiModel(
  registry: PiModelRegistryLike,
  providerID: string,
  modelID: string,
): unknown {
  const model = registry.find(requirePiProvider(providerID), modelID);
  if (!model) {
    throw new Error(
      `pi's model catalog has no ${providerID}/${modelID}; set JBOT_SDK_ENGINE=opencode to use the opencode engine instead.`,
    );
  }
  return model;
}

/**
 * Initializes the in-process pi engine: runtime-injected keys (never ambient
 * env — the webhook app runs concurrent reviews with different keys), the
 * model catalog, and a hermetic resource loader. The loader's discovery root
 * is a temp dir, NEVER the reviewed workspace: pointing it at the workspace
 * would let a PR inject .pi/ skills/extensions/prompt-templates into the
 * reviewer. Session tools get cwd=workspace separately.
 */
export async function startPi(
  workspace: string,
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
  options: {
    modelOptions?: Record<string, unknown>;
    additionalProviderKeys?: ProviderKeyConfig[];
  } = {},
): Promise<{ runtime: PiRuntime; stop: () => void }> {
  const piID = requirePiProvider(providerID);
  const sdk = await loadPiSdk();
  const authStorage = sdk.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(piID, apiKey);
  for (const extra of options.additionalProviderKeys ?? []) {
    if (!extra.apiKey || extra.providerID === providerID) continue;
    const extraPiID = piProviderIDFor(extra.providerID);
    if (extraPiID) authStorage.setRuntimeApiKey(extraPiID, extra.apiKey);
  }
  const registry = new sdk.ModelRegistry(authStorage);
  requirePiModel(registry, providerID, modelID);

  // The isolation dir must not outlive a failed init (a long-running webhook
  // server would accumulate leaked /tmp/jbot-pi-loader-* dirs).
  const isolationDir = mkdtempSync(join(tmpdir(), 'jbot-pi-loader-'));
  const removeIsolationDir = () => rmSync(isolationDir, { recursive: true, force: true });
  let loader: PiResourceLoaderLike;
  try {
    loader = new sdk.DefaultResourceLoader({
      cwd: isolationDir,
      agentDir: join(isolationDir, 'agent'),
      systemPromptOverride: () => PI_REVIEW_SYSTEM_PROMPT,
    });
    await loader.reload();
  } catch (error) {
    removeIsolationDir();
    throw error;
  }

  const thinkingLevel = piThinkingLevel(options.modelOptions);
  const ignoredOptions = Object.keys(options.modelOptions ?? {}).filter(
    (key) => key !== 'reasoningEffort',
  );
  if (ignoredOptions.length > 0) {
    log(
      `pi engine ignores modelOptions ${ignoredOptions.join(', ')} (only reasoningEffort maps to a pi thinking level).`,
    );
  }
  log(
    `pi engine ready (in-process, provider=${providerID} model=${modelID}${
      thinkingLevel ? ` thinking=${thinkingLevel}` : ''
    })`,
  );
  try {
    const models = registry
      .getAll()
      .filter((m) => m.provider === piID && typeof m.id === 'string')
      .map((m) => `${providerID}/${m.id}`)
      .sort();
    if (models.length > 0) {
      log(
        `pi models available for ${providerID} (${models.length}): ${models
          .slice(0, PI_MODEL_LIST_LOG_CAP)
          .join(', ')}${models.length > PI_MODEL_LIST_LOG_CAP ? ', …' : ''}`,
      );
    }
  } catch {
    /* model listing is a log nicety only */
  }

  return {
    runtime: {
      sdk,
      authStorage,
      registry,
      loader,
      workspace,
      mainModel: `${providerID}/${modelID}`,
      ...(thinkingLevel ? { thinkingLevel } : {}),
    },
    stop: removeIsolationDir,
  };
}

async function createPiSession(
  runtime: PiRuntime,
  model: string,
  singleShot: boolean,
): Promise<PiAgentSessionLike> {
  const { providerID, modelID } = parseModelName(model);
  const modelRef = requirePiModel(runtime.registry, providerID, modelID);
  const { session } = await runtime.sdk.createAgentSession({
    model: modelRef,
    cwd: runtime.workspace,
    // Layered read-only (invariant 8): mutating tools are never enabled
    // (write/edit absent; single-shot disables all tools), the hermetic
    // loader blocks ambient skills/extensions from adding any, and the
    // system prompt pins read-only conduct.
    ...(singleShot ? { noTools: 'all' } : { tools: [...PI_SESSION_TOOLS] }),
    authStorage: runtime.authStorage,
    modelRegistry: runtime.registry,
    resourceLoader: runtime.loader,
    sessionManager: runtime.sdk.SessionManager.inMemory(),
    settingsManager: runtime.sdk.SettingsManager.inMemory({}),
    // modelOptions are main-model-only, matching the opencode engine. Compare
    // the full provider/model: bare model IDs repeat across providers.
    ...(model === runtime.mainModel && runtime.thinkingLevel
      ? { thinkingLevel: runtime.thinkingLevel }
      : {}),
  });
  return session;
}

function piSessionMessages(session: PiAgentSessionLike): unknown[] {
  const messages = session.agent?.state?.messages ?? session.messages;
  return Array.isArray(messages) ? messages : [];
}

async function promptPiSession(
  session: PiAgentSessionLike,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = PI_PROMPT_TIMEOUT_MS,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const { providerID, modelID } = parseModelName(model);
  log(`Calling ${label} prompt (engine=pi, provider=${providerID} model=${modelID})`);
  // Sessions outlive a single prompt (the JSON repair re-prompts in place), so
  // only the turns appended by THIS prompt may be read or billed.
  const priorTurns = piSessionMessages(session).length;
  try {
    // prompt() resolves when the full agent turn completes — no polling.
    // Template expansion stays off: prompts embed arbitrary diff text that
    // must never trigger pi's /template expansion.
    await withTimeout(
      session.prompt(prompt, { expandPromptTemplates: false }),
      timeoutMs,
      `pi ${label} prompt did not finish within ${Math.round(timeoutMs / 1000)}s`,
    );
  } catch (error) {
    await abortPiSessionBestEffort(session, label, log);
    throw error;
  }
  const messages = piSessionMessages(session).slice(priorTurns);
  const raw = extractPiFinalText(messages);
  // A tool-using prompt spans several assistant turns; bill them all.
  const usage = sumPiUsage(messages);
  if (usage) {
    log(
      `${label} ${formatTokenUsage({
        ...(isFiniteNumber(usage.costUsd) ? { cost: usage.costUsd } : {}),
        tokens: {
          input: usage.input,
          output: usage.output,
          reasoning: usage.reasoning,
          cache: { read: usage.cacheRead, write: usage.cacheWrite },
        },
      })}`,
    );
    onTokenUsage?.(usage, model, label);
  }
  if (!raw) log(`${label} response contained no text output`);
  return raw;
}

async function abortPiSessionBestEffort(
  session: PiAgentSessionLike,
  label: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await withTimeout(
      session.abort(),
      PI_ABORT_TIMEOUT_MS,
      `abort timed out after ${PI_ABORT_TIMEOUT_MS}ms`,
    );
    log(`Aborted pi ${label} session.`);
  } catch (error) {
    log(
      `(failed to abort pi ${label} session: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function disposePiSession(
  session: PiAgentSessionLike,
  label: string,
  log: (msg: string) => void,
): void {
  const failed = (error: unknown) =>
    log(
      `(pi ${label} session dispose failed: ${error instanceof Error ? error.message : String(error)})`,
    );
  try {
    // dispose() may be sync or async: a rejected promise left unhandled would
    // take down the long-running webhook process, not just skip a cleanup.
    void Promise.resolve(session.dispose?.()).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/** Mirrors the opencode engine's runReview: strict parse, one same-session JSON repair. */
export async function runPiReview(
  runtime: PiRuntime,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  options: {
    lensAddendum?: string;
    evidenceQuotes?: boolean;
    label?: string;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
  } = {},
): Promise<ReviewResult> {
  const label = options.label ?? 'review';
  const prompt = assembleReviewPrompt(
    prContext,
    guidelines,
    options.lensAddendum ?? '',
    options.evidenceQuotes ?? false,
  );
  log(`Prompt assembled (${label}): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const session = await createPiSession(runtime, model, false);
  try {
    const raw = await promptPiSession(
      session,
      model,
      prompt,
      label,
      log,
      options.timeoutMs,
      options.onTokenUsage,
    );
    try {
      return parseReview(raw, label, log, { strict: true });
    } catch (error) {
      const repaired = await repromptPiForJson(
        session,
        model,
        error,
        label,
        log,
        options.timeoutMs,
        options.onTokenUsage,
      );
      return parseReview(repaired, `${label}-repair`, log, { strict: true });
    }
  } finally {
    disposePiSession(session, label, log);
  }
}

async function repromptPiForJson(
  session: PiAgentSessionLike,
  model: string,
  parseError: unknown,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const message = parseError instanceof Error ? parseError.message : String(parseError);
  log(`${label} response unparseable; sending one JSON repair prompt: ${message}`);
  return promptPiSession(
    session,
    model,
    buildJsonRepairPrompt(message),
    `${label}-repair`,
    log,
    timeoutMs,
    onTokenUsage,
  );
}

/**
 * Aux-session parse with one same-session repair, failing open to the empty
 * selection (invariant 3) — mirrors the opencode engine's behavior.
 */
async function parsePiAuxWithRepair<T>(
  session: PiAgentSessionLike,
  model: string,
  raw: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs: number | undefined,
  onTokenUsage: TokenUsageRecorder | undefined,
  select: (result: ReviewResult) => T,
): Promise<T> {
  try {
    return select(parseReview(raw, label, log, { strict: true }));
  } catch (error) {
    try {
      const repaired = await repromptPiForJson(
        session,
        model,
        error,
        label,
        log,
        timeoutMs,
        onTokenUsage,
      );
      return select(parseReview(repaired, `${label}-repair`, log));
    } catch (repairError) {
      const message = repairError instanceof Error ? repairError.message : String(repairError);
      log(`(${label} repair failed; keeping empty results: ${message})`);
      return select({ summary: '', findings: [], addressedPriorComments: [] });
    }
  }
}

export async function runPiAddressedPriorCommentsCheck(
  runtime: PiRuntime,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<AddressedPriorComment[]> {
  const label = 'addressed-prior-comments';
  const session = await createPiSession(runtime, model, false);
  try {
    const raw = await promptPiSession(
      session,
      model,
      assembleAddressedPriorCommentsPrompt(prContext),
      label,
      log,
      timeoutMs,
      onTokenUsage,
    );
    return await parsePiAuxWithRepair(
      session,
      model,
      raw,
      label,
      log,
      timeoutMs,
      onTokenUsage,
      (result) => result.addressedPriorComments,
    );
  } finally {
    disposePiSession(session, label, log);
  }
}

export async function runPiGuidelineComplianceCheck(
  runtime: PiRuntime,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<Finding[]> {
  const label = 'guideline-compliance';
  const session = await createPiSession(runtime, model, false);
  try {
    const raw = await promptPiSession(
      session,
      model,
      assembleGuidelineCompliancePrompt(prContext, guidelines),
      label,
      log,
      timeoutMs,
      onTokenUsage,
    );
    return await parsePiAuxWithRepair(
      session,
      model,
      raw,
      label,
      log,
      timeoutMs,
      onTokenUsage,
      (result) => result.findings,
    );
  } finally {
    disposePiSession(session, label, log);
  }
}

export async function runPiChangesSinceLastReview(
  runtime: PiRuntime,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const label = 'changes-since-last-review';
  const session = await createPiSession(runtime, model, false);
  try {
    const raw = await promptPiSession(
      session,
      model,
      assembleChangesSinceLastReviewPrompt(prContext, deltaContext),
      label,
      log,
      timeoutMs,
      onTokenUsage,
    );
    return parseChangesSinceLastReviewSummary(raw, label, log);
  } finally {
    disposePiSession(session, label, log);
  }
}

/**
 * Single-shot adversarial verification (all tools off — one model call, no
 * agentic loop). Returns undefined when the output is unusable so callers
 * fail open and keep the findings.
 */
export async function runPiFindingVerification(
  runtime: PiRuntime,
  model: string,
  prContext: string,
  findings: Finding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<FindingVerdict[] | undefined> {
  const label = 'finding-verification';
  // Findings pass through unprojected — a field-subset projection here would
  // silently drop `evidence` and defeat verifier grounding (see the opencode
  // engine's identical warning).
  const prompt = assembleFindingVerificationPrompt(prContext, findings, true);
  const session = await createPiSession(runtime, model, true);
  try {
    const raw = await promptPiSession(session, model, prompt, label, log, timeoutMs, onTokenUsage);
    return parseFindingVerdicts(raw, findings.length, log);
  } finally {
    disposePiSession(session, label, log);
  }
}
