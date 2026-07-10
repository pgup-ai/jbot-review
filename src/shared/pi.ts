import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { GIT_DIFF_ARGS } from './git.ts';
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
 * Static capability allowlist (never probe-and-see), mapping jbot provider IDs
 * to pi's. Rule: every non-CLI provider pi can also serve routes to pi first;
 * only a jbot provider pi's catalog lacks stays off this map. Every entry is
 * verified against pi's model catalog — provider id, runtime key injection, and
 * the repo default model resolve (nvidia resolves via the vendor-namespaced id;
 * see piModelCandidates). opencode/opencode-go are opencode's own Zen gateways;
 * on pi they're reached over the gateway's HTTP endpoint directly rather than
 * through the opencode server.
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
  nvidia: 'nvidia',
  opencode: 'opencode',
  'opencode-go': 'opencode-go',
};

export function piSupportsProvider(providerID: string): boolean {
  return Object.hasOwn(PI_PROVIDER_IDS, providerID);
}

/**
 * Model IDs to try against pi's registry, in order. jbot's config IDs come from
 * models.dev (bare stems, e.g. `nemotron-3-ultra-550b-a55b`), but multi-vendor
 * gateways like NVIDIA NIM namespace the same model with a vendor prefix
 * (`nvidia/nemotron-...`). So a bare ID also gets a provider-prefixed candidate;
 * an already-slashed ID is used as-is. Deterministic (two forms), not probing.
 */
export function piModelCandidates(providerID: string, modelID: string): string[] {
  const piID = piProviderIDFor(providerID);
  return piID && !modelID.includes('/') ? [modelID, `${piID}/${modelID}`] : [modelID];
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
 * Read-only, workspace-confined access (invariant 8). pi ships no sandbox, and
 * its built-in read/grep/find/ls accept absolute or `..` paths, so a
 * prompt-injected diff could make the model read host files (runner secrets)
 * and echo them in the review. So the built-ins are NEVER enabled — the session
 * gets only our custom tools: `read_file` (confined by resolveWithinWorkspace)
 * and `git_diff` (repo-scoped via git). blast-radius runs git grep in the
 * runner, outside the session. Single-shot sessions get no tools at all.
 */
export function resolveWithinWorkspace(
  workspace: string,
  requestedPath: string,
): string | undefined {
  // Canonicalize both sides through realpath: a lexical check alone is bypassed
  // by a symlink inside the checkout that points out (readFileSync follows it).
  // realpath resolves symlinks, `..`, and absolute paths; a missing/unreadable
  // path throws → undefined (nothing to read, no leak).
  const root = tryRealpath(resolve(workspace));
  if (!root) return undefined;
  const target = tryRealpath(resolve(root, requestedPath));
  if (!target) return undefined;
  // The trailing sep stops a sibling like `/repo-x` matching the `/repo` root.
  return target === root || target.startsWith(root + sep) ? target : undefined;
}

function tryRealpath(candidate: string): string | undefined {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

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

const execFileAsync = promisify(execFile);
const PI_DIFF_TOOL_MAX_BYTES = 48 * 1024;
const PI_DIFF_TOOL_TIMEOUT_MS = 30_000;

interface PiDiffScope {
  /** Merge-base (local mode) or PR base sha (GitHub paths). */
  base: string;
  /** Local mode diffs merge-base → working tree; GitHub paths are three-dot. */
  worktree: boolean;
  /**
   * PR head sha for GitHub paths. The checkout HEAD may be a synthetic merge
   * ref (actions/checkout pull_request default), so diff to the head sha the
   * embedded diff and anchors use — not the checkout's HEAD. Absent in local
   * mode (working tree) and as a defensive fallback.
   */
  head?: string;
}

/**
 * Reuses the pipeline's canonical GIT_DIFF_ARGS so this tool's hunks match the
 * embedded diff the model anchors findings against, and so no `.gitattributes`
 * textconv or external diff driver can run.
 */
export function piGitDiffArgs(scope: PiDiffScope, path?: string): string[] {
  const rev = scope.worktree ? scope.base : `${scope.base}...${scope.head ?? 'HEAD'}`;
  const args = [...GIT_DIFF_ARGS, rev];
  // `--` pins the model-supplied path as a pathspec; a flag-shaped value can
  // never become a git option.
  const trimmed = path?.trim();
  if (trimmed) args.push('--', trimmed);
  return args;
}

export function capPiDiffOutput(text: string, maxBytes = PI_DIFF_TOOL_MAX_BYTES): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Truncate on the byte budget (chars would overshoot up to 4x on multi-byte
  // content); decoding a split sequence yields trailing U+FFFD — drop it.
  const capped = Buffer.from(text, 'utf8').toString('utf8', 0, maxBytes).replace(/�+$/, '');
  return `${capped}\n\n_[output truncated at ${Math.floor(maxBytes / 1024)}KB]_`;
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

/**
 * Usage for the turns appended after `priorTurns` messages. A session is reused
 * across a prompt and its JSON-repair re-prompt, so each prompt bills only the
 * turns it produced — never the earlier prompt's or the repair's twice.
 */
export function piTurnUsageSince(
  messages: unknown,
  priorTurns: number,
): PromptTokenUsage | undefined {
  return sumPiUsage(Array.isArray(messages) ? messages.slice(priorTurns) : []);
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
  defineTool(definition: Record<string, unknown>): unknown;
}

/**
 * Read-only replacement for the shell the pi engine deliberately lacks: the
 * omitted-hunks notes tell the model to "run the git diff command" when the
 * embedded diff overflows its byte budget, and without this tool a pi session
 * could never see removals or unembedded hunks (invariant 1). The base ref and
 * diff form are runner-supplied — the model only chooses an optional pathspec.
 */
function createPiGitDiffTool(sdk: PiSdkLike, workspace: string, scope: PiDiffScope): unknown {
  return sdk.defineTool({
    name: 'git_diff',
    description:
      'Show the change under review (git diff against the PR base). Pass `path` to scope the diff to one file — do that whenever the full output is truncated.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Repo-relative file path to diff; omit for the whole change.',
        },
      },
    },
    execute: async (_id: unknown, params: unknown) => {
      const path = isRecord(params) && typeof params.path === 'string' ? params.path : undefined;
      let text: string;
      try {
        const { stdout } = await execFileAsync('git', piGitDiffArgs(scope, path), {
          cwd: workspace,
          maxBuffer: 64 * 1024 * 1024,
          timeout: PI_DIFF_TOOL_TIMEOUT_MS,
        });
        text = stdout.trim() ? capPiDiffOutput(stdout) : '(no changes for this path)';
      } catch (error) {
        // Surface the failure as tool output the model can react to; a throw
        // here would fail the whole session over a bad pathspec.
        text = `git diff failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}

/**
 * Repo-confined replacement for pi's built-in `read` (which accepts absolute
 * and `..` paths with no sandbox). Refuses anything resolving outside the
 * workspace, so a prompt-injected diff cannot read host files.
 */
function createPiReadTool(sdk: PiSdkLike, workspace: string): unknown {
  return sdk.defineTool({
    name: 'read_file',
    description:
      'Read a UTF-8 file from the repository under review. `path` is repo-relative; paths outside the repo are refused.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative file path.' } },
      required: ['path'],
    },
    execute: async (_id: unknown, params: unknown) => {
      const requested = isRecord(params) && typeof params.path === 'string' ? params.path : '';
      const target = resolveWithinWorkspace(workspace, requested);
      if (!target) {
        return {
          content: [{ type: 'text', text: `Refused: "${requested}" is outside the repository.` }],
          details: {},
        };
      }
      let text: string;
      try {
        text = capPiDiffOutput(readFileSync(target, 'utf8'));
      } catch (error) {
        text = `read failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
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
  gitDiffTool?: unknown;
  readTool: unknown;
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
  const piID = requirePiProvider(providerID);
  let model: unknown;
  for (const candidate of piModelCandidates(providerID, modelID)) {
    model = registry.find(piID, candidate);
    if (model) break;
  }
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
    diffScope?: PiDiffScope;
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
      // pi already namespaces NIM ids (nvidia/nemotron-…); don't double the
      // provider prefix in the jbot-form listing.
      .map((m) => (m.id!.startsWith(`${piID}/`) ? m.id! : `${providerID}/${m.id!}`))
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
      readTool: createPiReadTool(sdk, workspace),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(options.diffScope
        ? { gitDiffTool: createPiGitDiffTool(sdk, workspace, options.diffScope) }
        : {}),
    },
    stop: removeIsolationDir,
  };
}

/** The session's tool allowlist + custom tools — only our confined tools. */
function piCustomToolConfig(runtime: PiRuntime): {
  tools: string[];
  customTools: unknown[];
} {
  const entries: Array<{ name: string; tool: unknown }> = [
    { name: 'read_file', tool: runtime.readTool },
    ...(runtime.gitDiffTool ? [{ name: 'git_diff', tool: runtime.gitDiffTool }] : []),
  ];
  return { tools: entries.map((e) => e.name), customTools: entries.map((e) => e.tool) };
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
    // Read-only (invariant 8): NO pi built-in tools (they're unsandboxed and
    // escape the workspace). The session sees only our confined custom tools —
    // `read_file` and `git_diff` — and `tools` must name each one or it never
    // registers (verified live). Single-shot sessions get no tools at all.
    ...(singleShot ? { noTools: 'all' } : piCustomToolConfig(runtime)),
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
  const allMessages = piSessionMessages(session);
  const messages = allMessages.slice(priorTurns);
  const raw = extractPiFinalText(messages);
  // Bill every assistant turn this prompt produced (a tool-using prompt spans
  // several), and only this prompt's — see piTurnUsageSince.
  const usage = piTurnUsageSince(allMessages, priorTurns);
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
  // Single-shot (no tools): this pass wants the reviewedHead..head DELTA, but
  // git_diff only serves the full base...HEAD diff — offering it would let the
  // model describe old PR changes as new. The commit list is embedded in the
  // prompt, so it summarizes from that.
  const session = await createPiSession(runtime, model, true);
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
