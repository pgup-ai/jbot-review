import { AsyncLocalStorage } from 'node:async_hooks';
import { createReadStream, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { gitRepositoryPage, readRepositoryPage } from './repository-output.ts';
import { supportedModelOptions } from './config.ts';
import { GIT_DIFF_ARGS } from './git.ts';
import { parseModelName } from '@symma/protocol';
import {
  formatTokenUsage,
  parseChangesSinceLastReviewSummary,
  parseFindingVerdicts,
  parseReview,
  withTimeout,
} from './opencode.ts';
import type { PromptTokenUsage, ProviderKeyConfig, TokenUsageRecorder } from './opencode.ts';
import {
  EMBEDDED_FIRST_PI_REVIEW_SYSTEM_PROMPT,
  PI_REVIEW_SYSTEM_PROMPT,
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
  CONTINUATION_NUDGE_PROMPT,
  isNoAttemptReply,
} from './prompt.ts';
import { isFiniteNumber, isRecord, truncateForLog } from './text.ts';
import type { AddressedPriorComment, Finding, FindingVerdict, ReviewResult } from './types.ts';
import { serializedBytes, type ToolTelemetryAccumulator } from './tool-telemetry.ts';
import { classifyTelemetryStopReason } from './telemetry.ts';

export const PI_TELEMETRY_CAPABILITY = 'enforceable' as const;
const piTelemetryContext = new AsyncLocalStorage<{ session: string }>();
const piSessionTelemetry = new WeakMap<object, ToolTelemetryAccumulator>();

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

interface PiCatalogModel {
  provider?: string;
  id?: string;
}

export function piCatalogHasModel(
  models: ReadonlyArray<PiCatalogModel>,
  providerID: string,
  modelID: string,
): boolean {
  const piID = piProviderIDFor(providerID);
  if (!piID) return false;
  const candidates = piModelCandidates(providerID, modelID);
  return models.some((model) => model.provider === piID && candidates.includes(model.id ?? ''));
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

// Pi's built-in file tools can escape the checkout; only confined replacements
// are exposed to model sessions.
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

type PiMessageLike = {
  role?: unknown;
  content?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
};

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

function piContentTypes(content: unknown): string {
  if (typeof content === 'string') return 'text=1';
  if (!Array.isArray(content) || content.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const part of content) {
    const type = isRecord(part) && typeof part.type === 'string' ? part.type : 'unknown';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => `${type}=${count}`).join(', ');
}

// Structural views of the pi SDK surface this module uses. Local types keep
// typecheck independent of the 0.x package's own declarations; the dynamic
// import is cast through them.
interface PiModelRuntimeLike {
  setRuntimeApiKey(
    providerID: string,
    apiKey: string,
    options?: { allowNetwork?: boolean },
  ): Promise<void>;
  getModel(providerID: string, modelID: string): unknown;
  getModels(): ReadonlyArray<PiCatalogModel>;
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
  ModelRuntime: {
    create(options: Record<string, unknown>): Promise<PiModelRuntimeLike>;
  };
  InMemoryCredentialStore: new () => unknown;
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
export function createPiGitDiffTool(
  sdk: PiSdkLike,
  workspace: string,
  scope: PiDiffScope,
  telemetry?: ToolTelemetryAccumulator,
): unknown {
  return sdk.defineTool({
    name: 'git_diff',
    description:
      'Show the change under review (git diff against the PR base). Pass `path` to scope the diff to one file — do that whenever the full output is truncated.',
    parameters: {
      type: 'object',
      properties: {
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Byte offset returned by the previous page.',
        },
        path: {
          type: 'string',
          description: 'Repo-relative file path to diff; omit for the whole change.',
        },
      },
    },
    execute: async (_id: unknown, params: unknown) => {
      const path = isRecord(params) && typeof params.path === 'string' ? params.path : undefined;
      const finish = telemetry?.startTool({
        session: piTelemetryContext.getStore()?.session ?? 'unknown',
        backend: 'pi',
        capability: PI_TELEMETRY_CAPABILITY,
        toolClass: 'diff-recovery',
        inputBytes: serializedBytes(params),
        ...(isRecord(params) && (params.offset || params.line)
          ? { page: JSON.stringify({ offset: params.offset, line: params.line }) }
          : {}),
        ...(path
          ? { identity: path, identityKind: 'path' as const }
          : { identity: 'whole-diff', identityKind: 'scope' as const }),
        diffScope: path ? 'path' : 'whole',
      });
      let text: string;
      try {
        const page = await gitRepositoryPage(
          workspace,
          piGitDiffArgs(scope, path),
          isRecord(params) ? params : {},
        );
        text = page.totalBytes ? page.text : '(no changes for this path)';
        finish?.({
          success: true,
          outputBytesBeforeCap: page.totalBytes,
          outputBytesAfterCap: Buffer.byteLength(text),
        });
      } catch (error) {
        // Surface the failure as tool output the model can react to; a throw
        // here would fail the whole session over a bad pathspec.
        text = `git diff failed: ${truncateForLog(error instanceof Error ? error.message : String(error), 2000)}`;
        finish?.({
          success: false,
          failureClass:
            (isRecord(error) && error.killed === true) ||
            classifyTelemetryStopReason(error) === 'timeout'
              ? 'timeout'
              : 'execution',
          outputBytesBeforeCap: 0,
          outputBytesAfterCap: Buffer.byteLength(text),
        });
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
export function createPiReadTool(
  sdk: PiSdkLike,
  workspace: string,
  telemetry?: ToolTelemetryAccumulator,
): unknown {
  return sdk.defineTool({
    name: 'read_file',
    description:
      'Read a UTF-8 file from the repository under review. `path` is repo-relative; paths outside the repo are refused.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repo-relative file path.' },
        line: {
          type: 'integer',
          minimum: 1,
          description: 'Start at this 1-based line; omit when continuing with offset.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Byte offset returned by the previous page.',
        },
      },
      required: ['path'],
    },
    execute: async (_id: unknown, params: unknown) => {
      const requested = isRecord(params) && typeof params.path === 'string' ? params.path : '';
      const finish = telemetry?.startTool({
        session: piTelemetryContext.getStore()?.session ?? 'unknown',
        backend: 'pi',
        capability: PI_TELEMETRY_CAPABILITY,
        toolClass: 'file-read',
        inputBytes: serializedBytes(params),
        ...(isRecord(params) && (params.offset || params.line)
          ? { page: JSON.stringify({ offset: params.offset, line: params.line }) }
          : {}),
        ...(requested ? { identity: requested, identityKind: 'path' as const } : {}),
      });
      const target = requested ? resolveWithinWorkspace(workspace, requested) : undefined;
      if (!target) {
        const text = `Refused: "${requested}" is outside the repository.`;
        finish?.({
          success: false,
          failureClass:
            requested && existsSync(resolve(workspace, requested)) ? 'denied' : 'invalid-input',
          outputBytesBeforeCap: 0,
          outputBytesAfterCap: Buffer.byteLength(text),
        });
        return {
          content: [{ type: 'text', text }],
          details: {},
        };
      }
      let text: string;
      try {
        const page = await readRepositoryPage(
          createReadStream(target, { encoding: 'utf8' }),
          isRecord(params) ? params : {},
        );
        text = page.text;
        finish?.({
          success: true,
          outputBytesBeforeCap: page.totalBytes,
          outputBytesAfterCap: Buffer.byteLength(text),
        });
      } catch (error) {
        text = `read failed: ${truncateForLog(error instanceof Error ? error.message : String(error), 2000)}`;
        finish?.({
          success: false,
          failureClass: 'execution',
          outputBytesBeforeCap: 0,
          outputBytesAfterCap: Buffer.byteLength(text),
        });
      }
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}

export function createPiSearchTool(
  sdk: PiSdkLike,
  workspace: string,
  telemetry?: ToolTelemetryAccumulator,
): unknown {
  return sdk.defineTool({
    name: 'search_repo',
    description:
      'Search tracked repository files for literal text. Results include path and line number; continue large results with offset.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['query'],
    },
    execute: async (_id: unknown, params: unknown) => {
      const query = isRecord(params) && typeof params.query === 'string' ? params.query : '';
      if (!query)
        return { content: [{ type: 'text', text: 'query must be nonempty' }], details: {} };
      const finish = telemetry?.startTool({
        session: piTelemetryContext.getStore()?.session ?? 'unknown',
        backend: 'pi',
        capability: PI_TELEMETRY_CAPABILITY,
        toolClass: 'search',
        inputBytes: serializedBytes(params),
        ...(isRecord(params) && (params.offset || params.line)
          ? { page: JSON.stringify({ offset: params.offset, line: params.line }) }
          : {}),
        identity: query,
        identityKind: 'query',
      });
      let text: string;
      try {
        const page = await gitRepositoryPage(
          workspace,
          [
            '--no-pager',
            'grep',
            '--no-color',
            '-n',
            '-I',
            '-F',
            '--no-textconv',
            '--no-recurse-submodules',
            '-e',
            query,
            '--',
          ],
          isRecord(params) ? params : {},
        );
        text = page.totalBytes ? page.text : '(no matches in tracked files)';
        finish?.({
          success: true,
          outputBytesBeforeCap: page.totalBytes,
          outputBytesAfterCap: Buffer.byteLength(text),
        });
      } catch (error) {
        text = `search failed: ${truncateForLog(error instanceof Error ? error.message : String(error), 2000)}`;
        finish?.({
          success: false,
          failureClass: 'execution',
          outputBytesBeforeCap: 0,
          outputBytesAfterCap: Buffer.byteLength(text),
        });
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
  piSdkPromise ??= Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]).then(
    ([agent, ai]) =>
      ({ ...agent, InMemoryCredentialStore: ai.InMemoryCredentialStore }) as unknown as PiSdkLike,
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

function createPiModelRuntime(sdk: PiSdkLike): Promise<PiModelRuntimeLike> {
  return sdk.ModelRuntime.create({
    credentials: new sdk.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
}

let piCatalogPromise: Promise<ReadonlyArray<PiCatalogModel>> | undefined;

export async function piModelAvailable(providerID: string, modelID: string): Promise<boolean> {
  if (!piSupportsProvider(providerID)) return false;
  piCatalogPromise ??= loadPiSdk()
    .then(async (sdk) => {
      const runtime = await createPiModelRuntime(sdk);
      return runtime.getModels();
    })
    .catch((error: unknown) => {
      piCatalogPromise = undefined;
      throw error;
    });
  return piCatalogHasModel(await piCatalogPromise, providerID, modelID);
}

export interface PiRuntime {
  sdk: PiSdkLike;
  modelRuntime: PiModelRuntimeLike;
  loader: PiResourceLoaderLike;
  /** Embedded-first system prompt, for review and lens sessions only. */
  reviewLoader?: PiResourceLoaderLike;
  workspace: string;
  /** Full `provider/model` — a bare model ID collides across providers. */
  mainModel: string;
  thinkingLevel?: string;
  /** For sessions on a model other than `mainModel` (the aux default). */
  auxThinkingLevel?: string;
  gitDiffTool?: unknown;
  readTool: unknown;
  searchTool: unknown;
  toolTelemetry?: ToolTelemetryAccumulator;
  /**
   * Created-but-not-disposed sessions; teardown aborts them so a prompt
   * abandoned past the settle grace can't hold the event loop past posting.
   */
  activeSessions: Set<PiAgentSessionLike>;
  /** Set by stop(); a session born after the teardown sweep aborts itself. */
  stopped: boolean;
  /**
   * In-flight sessions by prompt label, for the grace-expiry abort
   * (TASK-077). Optional and lazily created so test fakes stay minimal.
   */
  sessionsByLabel?: Map<string, Set<PiAgentSessionLike>>;
}

function requirePiProvider(providerID: string): string {
  const piID = piProviderIDFor(providerID);
  if (!piID) {
    throw new Error(`Provider "${providerID}" is not on the pi engine allowlist.`);
  }
  return piID;
}

function requirePiModel(runtime: PiModelRuntimeLike, providerID: string, modelID: string): unknown {
  const piID = requirePiProvider(providerID);
  let model: unknown;
  for (const candidate of piModelCandidates(providerID, modelID)) {
    model = runtime.getModel(piID, candidate);
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
    /** Thinking level for sessions on a model other than the main one. */
    auxThinkingLevel?: string;
    additionalProviderKeys?: ProviderKeyConfig[];
    diffScope?: PiDiffScope;
    toolTelemetry?: ToolTelemetryAccumulator;
    embeddedFirstPrompt?: boolean;
  } = {},
): Promise<{ runtime: PiRuntime; stop: () => void }> {
  const piID = requirePiProvider(providerID);
  const sdk = await loadPiSdk();
  const modelRuntime = await createPiModelRuntime(sdk);
  await modelRuntime.setRuntimeApiKey(piID, apiKey, { allowNetwork: false });
  for (const extra of options.additionalProviderKeys ?? []) {
    if (!extra.apiKey || extra.providerID === providerID) continue;
    const extraPiID = piProviderIDFor(extra.providerID);
    if (extraPiID) {
      await modelRuntime.setRuntimeApiKey(extraPiID, extra.apiKey, { allowNetwork: false });
    }
  }
  requirePiModel(modelRuntime, providerID, modelID);

  // The isolation dir must not outlive a failed init (a long-running webhook
  // server would accumulate leaked /tmp/jbot-pi-loader-* dirs).
  const isolationDir = mkdtempSync(join(tmpdir(), 'jbot-pi-loader-'));
  const removeIsolationDir = () => rmSync(isolationDir, { recursive: true, force: true });
  // System prompts are fixed per loader; review and auxiliary guidance differ.
  const buildLoader = (systemPrompt: string): PiResourceLoaderLike =>
    new sdk.DefaultResourceLoader({
      cwd: isolationDir,
      agentDir: join(isolationDir, 'agent'),
      systemPromptOverride: () => systemPrompt,
    });
  let loader: PiResourceLoaderLike;
  let reviewLoader: PiResourceLoaderLike | undefined;
  try {
    loader = buildLoader(PI_REVIEW_SYSTEM_PROMPT);
    await loader.reload();
    if (options.embeddedFirstPrompt) {
      reviewLoader = buildLoader(EMBEDDED_FIRST_PI_REVIEW_SYSTEM_PROMPT);
      await reviewLoader.reload();
    }
  } catch (error) {
    removeIsolationDir();
    throw error;
  }

  const thinkingLevel = piThinkingLevel(
    supportedModelOptions(providerID, modelID, options.modelOptions),
  );
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
    const models = modelRuntime
      .getModels()
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

  const runtime: PiRuntime = {
    sdk,
    modelRuntime,
    loader,
    ...(reviewLoader ? { reviewLoader } : {}),
    workspace,
    mainModel: `${providerID}/${modelID}`,
    readTool: createPiReadTool(sdk, workspace, options.toolTelemetry),
    searchTool: createPiSearchTool(sdk, workspace, options.toolTelemetry),
    ...(options.toolTelemetry ? { toolTelemetry: options.toolTelemetry } : {}),
    activeSessions: new Set(),
    stopped: false,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(options.auxThinkingLevel ? { auxThinkingLevel: options.auxThinkingLevel } : {}),
    ...(options.diffScope
      ? {
          gitDiffTool: createPiGitDiffTool(
            sdk,
            workspace,
            options.diffScope,
            options.toolTelemetry,
          ),
        }
      : {}),
  };
  return {
    runtime,
    stop: () => {
      runtime.stopped = true;
      for (const session of runtime.activeSessions) {
        abandonPiSession(runtime, session, 'abandoned', log);
      }
      removeIsolationDir();
    },
  };
}

/** The session's tool allowlist + custom tools — only our confined tools. */
function piCustomToolConfig(runtime: PiRuntime): {
  tools: string[];
  customTools: unknown[];
} {
  const entries: Array<{ name: string; tool: unknown }> = [
    { name: 'read_file', tool: runtime.readTool },
    { name: 'search_repo', tool: runtime.searchTool },
    ...(runtime.gitDiffTool ? [{ name: 'git_diff', tool: runtime.gitDiffTool }] : []),
  ];
  return { tools: entries.map((e) => e.name), customTools: entries.map((e) => e.tool) };
}

async function createPiSession(
  runtime: PiRuntime,
  model: string,
  singleShot: boolean,
  /** Only the review and lens sessions carry the matching embedded-first user prompt. */
  reviewSession = false,
  /** Per-session override (TASK-157: the verifier's floored effort). */
  thinkingLevelOverride?: string,
  /** Registers the session for the grace-expiry abort (TASK-077). */
  label?: string,
): Promise<PiAgentSessionLike> {
  const { providerID, modelID } = parseModelName(model);
  const modelRef = requirePiModel(runtime.modelRuntime, providerID, modelID);
  const thinkingLevel =
    thinkingLevelOverride ??
    // Compare the full provider/model: bare model IDs repeat across providers.
    (model === runtime.mainModel ? runtime.thinkingLevel : runtime.auxThinkingLevel);
  const { session } = await runtime.sdk.createAgentSession({
    model: modelRef,
    cwd: runtime.workspace,
    // Naming custom tools in `tools` is required for registration; built-ins
    // remain unavailable because Pi does not sandbox them.
    ...(singleShot ? { noTools: 'all' } : piCustomToolConfig(runtime)),
    modelRuntime: runtime.modelRuntime,
    resourceLoader: reviewSession && runtime.reviewLoader ? runtime.reviewLoader : runtime.loader,
    sessionManager: runtime.sdk.SessionManager.inMemory(),
    settingsManager: runtime.sdk.SettingsManager.inMemory({}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  });
  runtime.activeSessions.add(session);
  if (label) {
    const byLabel = (runtime.sessionsByLabel ??= new Map());
    const labeled = byLabel.get(label) ?? new Set<PiAgentSessionLike>();
    byLabel.set(label, labeled);
    labeled.add(session);
  }
  if (runtime.toolTelemetry) piSessionTelemetry.set(session, runtime.toolTelemetry);
  // stop() may have swept the registry while createAgentSession was pending
  // (an abandoned caller racing teardown): abort the newborn session and fail
  // the call into the aux fail-open path rather than prompting post-teardown.
  if (runtime.stopped) {
    // The throw skips the caller's dispose finally, so release it here — under
    // the registration label, or the sessionsByLabel entry leaks.
    abandonPiSession(runtime, session, label ?? 'post-stop', () => undefined);
    throw new Error('pi engine stopped during session creation');
  }
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
    await piTelemetryContext.run({ session: label }, () =>
      withTimeout(
        session.prompt(prompt, { expandPromptTemplates: false }),
        timeoutMs,
        `pi ${label} prompt did not finish within ${Math.round(timeoutMs / 1000)}s`,
      ),
    );
  } catch (error) {
    piSessionTelemetry.get(session)?.finishSession({
      session: label,
      backend: 'pi',
      capability: PI_TELEMETRY_CAPABILITY,
      budgetTier: 'observe-only',
      stopReason: classifyTelemetryStopReason(error),
      turnCount: countPiAssistantTurns(piSessionMessages(session).slice(priorTurns)),
    });
    await abortPiSessionBestEffort(session, label, log);
    onTokenUsage?.({ promptBytes: Buffer.byteLength(prompt, 'utf8') }, model, label);
    throw error;
  }
  const allMessages = piSessionMessages(session);
  const messages = allMessages.slice(priorTurns);
  const turnCount = countPiAssistantTurns(messages);
  const finalMessage = lastAssistantMessage(messages);
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
  }
  onTokenUsage?.({ ...usage, promptBytes: Buffer.byteLength(prompt, 'utf8') }, model, label);
  if (finalMessage?.stopReason === 'error' || finalMessage?.stopReason === 'aborted') {
    const detail =
      typeof finalMessage.errorMessage === 'string' && finalMessage.errorMessage.trim()
        ? truncateForLog(finalMessage.errorMessage.replace(/\s+/g, ' ').trim(), 1000)
        : 'unknown provider error';
    const error = new Error(
      `pi ${label} prompt ${finalMessage.stopReason} (${model}; content types: ${piContentTypes(finalMessage.content)}): ${detail}`,
    );
    piSessionTelemetry.get(session)?.finishSession({
      session: label,
      backend: 'pi',
      capability: PI_TELEMETRY_CAPABILITY,
      budgetTier: 'observe-only',
      stopReason: classifyTelemetryStopReason(error),
      turnCount,
    });
    throw error;
  }
  if (!raw) {
    log(
      `${label} response contained no text output (stopReason=${String(finalMessage?.stopReason ?? 'unknown')}; content types: ${piContentTypes(finalMessage?.content)})`,
    );
  }
  piSessionTelemetry.get(session)?.finishSession({
    session: label,
    backend: 'pi',
    capability: PI_TELEMETRY_CAPABILITY,
    budgetTier: 'observe-only',
    stopReason: 'completed',
    turnCount,
  });
  return raw;
}

function countPiAssistantTurns(messages: unknown[]): number {
  return messages.filter(
    (message) =>
      isRecord(message) && (message.role === 'assistant' || message.type === 'assistant'),
  ).length;
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

/**
 * Best-effort abort of every in-flight session created under `label`, used
 * when the settle grace abandons an auxiliary result (TASK-077): the fallback
 * has already been settled, so the session's remaining work is pure waste —
 * decode, a held concurrency slot, and process linger.
 */
export function abortPiSessionsByLabel(
  runtime: PiRuntime,
  label: string,
  log: (msg: string) => void,
): number {
  const labeled = runtime.sessionsByLabel?.get(label);
  if (!labeled || labeled.size === 0) return 0;
  const count = labeled.size;
  // Abandoning deletes only the visited element — safe during Set iteration.
  for (const session of labeled) abandonPiSession(runtime, session, label, log);
  return count;
}

/**
 * Releases a session nothing is waiting on (teardown, or one born after the
 * teardown sweep). Never awaits the abort: abortPiSessionBestEffort's timeout
 * would hold a referenced timer — and the caller — for up to PI_ABORT_TIMEOUT_MS
 * on a hanging abort, which is the delay aborting exists to release.
 */
function abandonPiSession(
  runtime: PiRuntime,
  session: PiAgentSessionLike,
  label: string,
  log: (msg: string) => void,
): void {
  // Called synchronously, not off a microtask: disposal below would otherwise
  // land first and leave the abort to fail against an already-disposed session.
  try {
    void Promise.resolve(session.abort()).catch(() => undefined);
  } catch {
    /* best-effort; the session is disposed either way */
  }
  disposePiSession(runtime, session, label, log);
}

function disposePiSession(
  runtime: PiRuntime,
  session: PiAgentSessionLike,
  label: string,
  log: (msg: string) => void,
): void {
  // Idempotent: teardown disposes abandoned sessions, whose own callers still
  // run this from their finally once the abort settles their prompt.
  runtime.sessionsByLabel?.get(label)?.delete(session);
  if (!runtime.activeSessions.delete(session)) return;
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
    embeddedFirstPrompt?: boolean;
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
    options.embeddedFirstPrompt ?? false,
  );
  log(`Prompt assembled (${label}): ${prompt.length} chars, guidelines=${!!guidelines}`);
  const session = await createPiSession(runtime, model, false, true, undefined, label);
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
        raw,
        error,
        label,
        log,
        options.timeoutMs,
        options.onTokenUsage,
      );
      return parseReview(repaired, `${label}-repair`, log, { strict: true });
    }
  } finally {
    disposePiSession(runtime, session, label, log);
  }
}

async function repromptPiForJson(
  session: PiAgentSessionLike,
  model: string,
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
    return promptPiSession(
      session,
      model,
      CONTINUATION_NUDGE_PROMPT,
      `${label}-continue`,
      log,
      timeoutMs,
      onTokenUsage,
    );
  }
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
async function parsePiAuxWithRepair<K extends 'findings' | 'addressedPriorComments'>(
  session: PiAgentSessionLike,
  model: string,
  raw: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs: number | undefined,
  onTokenUsage: TokenUsageRecorder | undefined,
  field: K,
): Promise<ReviewResult[K]> {
  try {
    return parseReview(raw, label, log, { strict: true, field })[field];
  } catch (error) {
    try {
      const repaired = await repromptPiForJson(
        session,
        model,
        raw,
        error,
        label,
        log,
        timeoutMs,
        onTokenUsage,
      );
      return parseReview(repaired, `${label}-repair`, log, { strict: true, field })[field];
    } catch (repairError) {
      const message = repairError instanceof Error ? repairError.message : String(repairError);
      log(`(${label} repair failed; keeping empty results: ${message})`);
      return [];
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
  const session = await createPiSession(runtime, model, false, false, undefined, label);
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
      'addressedPriorComments',
    );
  } finally {
    disposePiSession(runtime, session, label, log);
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
  const session = await createPiSession(runtime, model, false, false, undefined, label);
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
      'findings',
    );
  } finally {
    disposePiSession(runtime, session, label, log);
  }
}

export async function runPiChangesSinceLastReview(
  runtime: PiRuntime,
  model: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const label = 'changes-since-last-review';
  // git_diff serves base...HEAD, not the re-review delta embedded here.
  const session = await createPiSession(runtime, model, true, false, undefined, label);
  try {
    const raw = await promptPiSession(
      session,
      model,
      assembleChangesSinceLastReviewPrompt(deltaContext, true),
      label,
      log,
      timeoutMs,
      onTokenUsage,
    );
    return parseChangesSinceLastReviewSummary(raw, label, log);
  } finally {
    disposePiSession(runtime, session, label, log);
  }
}

export async function runPiFindingVerification(
  runtime: PiRuntime,
  model: string,
  prContext: string,
  findings: Finding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  modelOptions?: Record<string, unknown>,
): Promise<FindingVerdict[] | undefined> {
  const label = 'finding-verification';
  // Findings pass through unprojected — a field-subset projection here would
  // silently drop `evidence` and defeat verifier grounding (see the opencode
  // engine's identical warning).
  const prompt = assembleFindingVerificationPrompt(prContext, findings, false);
  // TASK-157: the runner passes the verifier's floored options when the aux
  // entry does not already deliver them; pi maps them per session.
  const session = await createPiSession(
    runtime,
    model,
    false,
    false,
    piThinkingLevel(modelOptions),
    label,
  );
  try {
    const raw = await promptPiSession(session, model, prompt, label, log, timeoutMs, onTokenUsage);
    return parseFindingVerdicts(raw, findings.length, log);
  } finally {
    disposePiSession(runtime, session, label, log);
  }
}
