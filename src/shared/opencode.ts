import {
  createOpencode,
  type AssistantMessage,
  type OpencodeClient,
  type Part,
  type ServerOptions,
  type SessionStatus,
} from '@opencode-ai/sdk';

import { isContext7QuotaError } from './context7.ts';
import { PROVIDERS, supportedModelOptions } from './config.ts';
import { hermeticOpencodeConfigHome, toolSchemaShimPluginUrl } from './opencode-hardening.ts';
import { BASH_PERMISSIONS } from './shell-policy.ts';
import { parseModelName } from '@symma/protocol';
import {
  assembleAddressedPriorCommentsPrompt,
  assembleChangesSinceLastReviewPrompt,
  assembleFindingVerificationPrompt,
  assembleGuidelineCompliancePrompt,
  assembleReviewPrompt,
  buildJsonRepairPrompt,
  CONTINUATION_NUDGE_PROMPT,
  isNoAttemptReply,
} from './prompt.ts';
import { isFiniteNumber, isRecord } from './text.ts';
import {
  classifyReadonlyTool,
  serializedBytes,
  toolIdentity,
  type ToolTelemetryAccumulator,
} from './tool-telemetry.ts';
import {
  sanitizeFinding,
  type AddressedPriorComment,
  type Finding,
  type FindingVerdict,
  type ReviewResult,
} from './types.ts';

const READY_TIMEOUT_MS = 15_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 15 * 60_000;
const PROMPT_POLL_INTERVAL_MS = 2_000;
const PROMPT_POLL_REQUEST_TIMEOUT_MS = 10_000;
const opencodeToolTelemetry = new WeakMap<object, ToolTelemetryAccumulator>();
const PROMPT_PROGRESS_LOG_MS = 60_000;
const CONTEXT7_MCP_NAME = 'context7';
const CONTEXT7_MCP_URL = 'https://mcp.context7.com/mcp';
const CONTEXT7_MCP_TIMEOUT_MS = 15_000;

export const OPENCODE_TELEMETRY_CAPABILITY = 'observable' as const;

export function configureOpencodeTelemetry(
  client: OpencodeClient,
  telemetry: ToolTelemetryAccumulator,
): void {
  opencodeToolTelemetry.set(client, telemetry);
}

export function recordOpencodeToolParts(
  telemetry: ToolTelemetryAccumulator,
  session: string,
  parts: ReadonlyArray<Part>,
): void {
  for (const part of parts) {
    if (
      part.type !== 'tool' ||
      (part.state.status !== 'completed' && part.state.status !== 'error')
    ) {
      continue;
    }
    const toolClass = classifyReadonlyTool(part.tool, part.state.input);
    const identity = toolIdentity(toolClass, part.state.input);
    const finish = telemetry.startTool({
      session,
      backend: 'opencode',
      capability: OPENCODE_TELEMETRY_CAPABILITY,
      toolClass,
      inputBytes: serializedBytes(part.state.input),
      ...identity,
      ...(toolClass === 'diff-recovery'
        ? { diffScope: identity.identityKind === 'path' ? ('path' as const) : ('whole' as const) }
        : {}),
    });
    const output = part.state.status === 'completed' ? part.state.output : part.state.error;
    const outputBytes = serializedBytes(output);
    finish({
      success: part.state.status === 'completed',
      ...(part.state.status === 'error' ? { failureClass: 'execution' as const } : {}),
      outputBytesBeforeCap: outputBytes,
      outputBytesAfterCap: outputBytes,
      durationMs: Math.max(part.state.time.end - part.state.time.start, 0),
    });
  }
  const turnCount = parts.filter((part) => part.type === 'step-finish').length;
  telemetry.finishSession({
    session,
    backend: 'opencode',
    capability: OPENCODE_TELEMETRY_CAPABILITY,
    budgetTier: 'observe-only',
    stopReason: 'completed',
    ...(turnCount > 0 ? { turnCount } : {}),
  });
}

export function observedAssistantParts(
  messages: ReadonlyArray<{ info: { id: string }; parts?: ReadonlyArray<Part> }>,
  afterMessageID?: string,
): ReadonlyArray<Part> {
  if (!afterMessageID) return messages.flatMap((message) => message.parts ?? []);
  const afterIndex = messages.findIndex((message) => message.info.id === afterMessageID);
  return afterIndex < 0
    ? []
    : messages.slice(afterIndex + 1).flatMap((message) => message.parts ?? []);
}

export interface ProviderKeyConfig {
  providerID: string;
  apiKey: string;
}

export interface OpencodeProviderConfig extends ProviderKeyConfig {
  modelID?: string;
  baseURL?: string;
  promptCache?: boolean;
  /** Provider options for this entry's model, scoped to it alone. */
  modelOptions?: Record<string, unknown>;
  /**
   * TASK-157: options for the verifier alias entry on this model (effort
   * floored at the main pass). The prompt API has no per-session options, so
   * the alias `<modelID>--jbot-verify` carries them, with `id` pointing back
   * at the real model.
   */
  verificationModelOptions?: Record<string, unknown>;
}

/** Config-time model alias that carries the verifier's own options (TASK-157). */
export const VERIFICATION_MODEL_ALIAS_SUFFIX = '--jbot-verify';

type ProviderEntry = NonNullable<NonNullable<ServerOptions['config']>['provider']>[string];

/**
 * Models.dev-known providers need only their key and options. Custom providers
 * also carry the SDK package, endpoint, and selected model required by opencode.
 */
function buildProviderEntry(params: {
  providerID: string;
  apiKey: string;
  baseURL?: string;
  promptCache: boolean;
  modelID: string;
  modelOptions?: Record<string, unknown>;
  verificationModelOptions?: Record<string, unknown>;
}): ProviderEntry {
  const { providerID, apiKey, baseURL, promptCache, modelID } = params;
  const modelOptions = supportedModelOptions(providerID, modelID, params.modelOptions);
  const hasModelOptions = Boolean(modelOptions && Object.keys(modelOptions).length > 0);
  const aliasModels = verificationAliasEntry(providerID, modelID, params.verificationModelOptions);
  const options = {
    apiKey,
    ...(promptCache ? { setCacheKey: true } : {}),
  };
  const custom = PROVIDERS[providerID]?.custom;
  if (custom) {
    if (!baseURL) throw new Error(`Missing base URL for custom provider "${providerID}".`);
    if (!modelID) throw new Error(`Missing model for custom provider "${providerID}".`);
    return {
      name: custom.name,
      npm: custom.npm,
      options: { ...options, baseURL },
      models: {
        [modelID]: {
          name: modelID,
          ...(hasModelOptions ? { options: modelOptions } : {}),
        },
        ...aliasModels,
      },
    };
  }
  return {
    options,
    ...(hasModelOptions || aliasModels
      ? {
          models: {
            ...(hasModelOptions ? { [modelID]: { options: modelOptions } } : {}),
            ...aliasModels,
          },
        }
      : {}),
  };
}

/** Builds the alias entry OpencodeProviderConfig.verificationModelOptions describes. */
function verificationAliasEntry(
  providerID: string,
  modelID: string,
  verificationModelOptions?: Record<string, unknown>,
): Record<string, { id: string; name?: string; options: Record<string, unknown> }> | undefined {
  if (!modelID) return undefined;
  const options = supportedModelOptions(providerID, modelID, verificationModelOptions);
  if (!options || Object.keys(options).length === 0) return undefined;
  return {
    [`${modelID}${VERIFICATION_MODEL_ALIAS_SUFFIX}`]: {
      id: modelID,
      ...(PROVIDERS[providerID]?.custom ? { name: modelID } : {}),
      options,
    },
  };
}

/**
 * Env vars withheld from the opencode server — and therefore from every
 * session's bash children, which inherit its environment. The Action maps ALL
 * inputs to INPUT_* (the write-scoped GitHub token plus every provider key),
 * and app/local modes hold credential-suffixed vars; sessions need none of
 * them, since provider auth travels inside the opencode config. With these
 * gone, "prompt injection runs `env`" stops yielding tokens that act OUTSIDE
 * the container (post as the bot, spend provider credits) — the exfil surface
 * the bash accident-filter above explicitly does not close.
 */
export function sessionEnvDenyKeys(keys: string[]): string[] {
  // Match the trailing WORD, not a fixed suffix list: `STRIPE_SECRET_KEY` ends
  // in KEY (not SECRET), and a bare `API_KEY`/`TOKEN` has no leading segment.
  // `(^|_)` also covers GITHUB_TOKEN/GH_TOKEN without naming them.
  const CREDENTIAL_NAME =
    /(^|_)(KEY|KEY_ID|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|AUTH_CONTENT|AUTH_JSON|DSN)$/;
  return keys.filter((key) => {
    const upper = key.toUpperCase();
    return upper.startsWith('INPUT_') || CREDENTIAL_NAME.test(upper);
  });
}

export function takeOpencodeProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const proxy = env.JBOT_OPENCODE_HTTPS_PROXY?.trim();
  const noProxy = env.JBOT_OPENCODE_NO_PROXY?.trim();
  delete env.JBOT_OPENCODE_HTTPS_PROXY;
  delete env.JBOT_OPENCODE_NO_PROXY;
  if (!proxy) return {};
  return {
    HTTPS_PROXY: proxy,
    NO_PROXY: noProxy || 'localhost,127.0.0.1',
  };
}

/**
 * Builds the opencode config object that embeds the API key for the selected
 * provider, plus any secondary providers needed by aux-model sessions. This is
 * the official way to authenticate opencode (replaces the old "set env var"
 * pattern).
 *
 * Permissions enforce read-only at the CONFIG level, not just via the plan
 * agent: edits are denied outright (never "ask" — an interactive prompt
 * would hang a headless run), and file access outside the workspace is
 * denied. Bash stays allowed: the review needs git diff/log/grep, filtered
 * by the shared BASH_PERMISSIONS accident filter.
 *
 * `modelOptions` pass through opencode to the provider SDK, scoped to the model
 * they are attached to — the lever for capping reasoning spend (e.g.
 * {"reasoningEffort":"medium"} for OpenAI, thinking budgets for Anthropic).
 * Auxiliary entries carry their own via OpencodeProviderConfig.modelOptions.
 *
 * `promptCache` sets the provider's `setCacheKey` option (opencode's
 * promptCacheKey toggle, default off in the SDK). Parallel review shards and
 * re-reviews of the same PR share a byte-identical prompt prefix (base
 * instructions + guidelines + PR context), so caching cuts input-token cost
 * on models that honor it. Runner-level model capability checks should pass
 * `false` for models known to reject promptCacheKey; cache hits are observable
 * in the per-session token log (`formatTokenUsage`). When disabled, the key is
 * OMITTED entirely rather than sent as `false` — the off switch exists for
 * providers that reject unknown option keys, so it must not send the key at
 * all. Exported for unit testing (pure).
 */
export function buildConfig(
  providerID: string,
  modelID: string,
  apiKey: string,
  modelOptions?: Record<string, unknown>,
  promptCache = true,
  additionalProviderKeys: OpencodeProviderConfig[] = [],
  baseURL?: string,
  verificationModelOptions?: Record<string, unknown>,
): NonNullable<ServerOptions['config']> {
  const providerConfig: NonNullable<ServerOptions['config']>['provider'] = {
    [providerID]: buildProviderEntry({
      providerID,
      apiKey,
      baseURL,
      promptCache,
      modelID,
      modelOptions,
      verificationModelOptions,
    }),
  };
  for (const providerKey of additionalProviderKeys) {
    if (!providerKey.providerID) continue;
    if (providerKey.providerID === providerID) {
      const custom = PROVIDERS[providerID]?.custom;
      const auxOptions = supportedModelOptions(
        providerID,
        providerKey.modelID ?? '',
        providerKey.modelOptions,
      );
      const hasAuxOptions = Boolean(auxOptions && Object.keys(auxOptions).length > 0);
      const aliasModels = verificationAliasEntry(
        providerID,
        providerKey.modelID ?? '',
        providerKey.verificationModelOptions,
      );
      // A same-provider aux model needs its own entry only to carry a name
      // (custom providers), options of its own, or a verifier alias; otherwise
      // the provider entry already covers it.
      if (!providerKey.modelID || providerKey.modelID === modelID) continue;
      if (!custom && !hasAuxOptions && !aliasModels) continue;
      const entry = providerConfig[providerID];
      entry.models = {
        ...entry.models,
        ...(custom || hasAuxOptions
          ? {
              [providerKey.modelID]: {
                ...(custom ? { name: providerKey.modelID } : {}),
                ...(hasAuxOptions ? { options: auxOptions } : {}),
              },
            }
          : {}),
        ...aliasModels,
      };
      continue;
    }
    providerConfig[providerKey.providerID] = buildProviderEntry({
      providerID: providerKey.providerID,
      apiKey: providerKey.apiKey,
      baseURL: providerKey.baseURL,
      promptCache: providerKey.promptCache ?? promptCache,
      modelID: providerKey.modelID ?? '',
      modelOptions: providerKey.modelOptions,
      verificationModelOptions: providerKey.verificationModelOptions,
    });
  }
  return {
    provider: providerConfig,
    permission: {
      edit: 'deny',
      external_directory: 'deny',
      bash: { ...BASH_PERMISSIONS },
    },
  };
}

export interface TokenUsageInfo {
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

export interface PromptTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd?: number;
  estimatedCostUsd?: number;
  creditCost?: number;
  acuCost?: number;
}

export type TokenUsageRecorder = (usage: PromptTokenUsage, model: string, label?: string) => void;

export function extractPromptTokenUsage(info: TokenUsageInfo): PromptTokenUsage | undefined {
  const tokens = info.tokens;
  if (!tokens) return undefined;
  const cache = tokens.cache ?? {};
  return {
    input: tokens.input ?? 0,
    output: tokens.output ?? 0,
    reasoning: tokens.reasoning ?? 0,
    cacheRead: cache.read ?? 0,
    cacheWrite: cache.write ?? 0,
    ...(isFiniteNumber(info.cost) ? { costUsd: info.cost } : {}),
  };
}

/**
 * One-line token/cost summary for a completed session. Defensive about
 * missing fields: gateways like opencode-go may not populate every counter,
 * and cache read/write are the signal for whether prompt caching is actually
 * working (cache.read > 0 on a later shard or re-review means a hit).
 * Exported for unit testing (pure).
 */
export function formatTokenUsage(info: TokenUsageInfo): string {
  const tokens = info.tokens ?? {};
  const cache = tokens.cache ?? {};
  const parts = [
    `input=${tokens.input ?? 0}`,
    `output=${tokens.output ?? 0}`,
    `reasoning=${tokens.reasoning ?? 0}`,
    `cache(read=${cache.read ?? 0} write=${cache.write ?? 0})`,
  ];
  if (isFiniteNumber(info.cost)) parts.push(`cost=$${info.cost.toFixed(4)}`);
  return `tokens: ${parts.join(' ')}`;
}

/**
 * Bounds in-flight model sessions. Free / throttled provider tiers serialize
 * concurrent requests on one API key upstream anyway — observed as a
 * flash-tier session taking 7+ minutes while queued behind parallel shards.
 * Capping concurrency on OUR side keeps each session's deadline measuring
 * model time, not queue time. High-priority waiters wake first; each priority
 * remains FIFO. 0 = unlimited.
 */
export type SemaphorePriority = 'high' | 'normal';

export class Semaphore {
  private highPriorityQueue: Array<() => void> = [];
  private normalPriorityQueue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(priority: SemaphorePriority = 'normal'): Promise<() => void> {
    if (this.limit === 0) return () => undefined;
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      const queue = priority === 'high' ? this.highPriorityQueue : this.normalPriorityQueue;
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.highPriorityQueue.shift() ?? this.normalPriorityQueue.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    };
  }

  isBusy(): boolean {
    return (
      this.active > 0 || this.highPriorityQueue.length > 0 || this.normalPriorityQueue.length > 0
    );
  }
}

let sessionSlots: Semaphore | undefined;
let sessionSlotLimit = 0;
const clientDirectories = new WeakMap<OpencodeClient, string>();

export function configureSessionConcurrency(limit: number): void {
  const normalized = Math.max(0, Math.floor(limit));
  if (normalized === sessionSlotLimit) return;
  if (sessionSlots?.isBusy()) return;
  sessionSlotLimit = normalized;
  sessionSlots = normalized > 0 ? new Semaphore(normalized) : undefined;
}

/**
 * Serializes the `process.chdir(workspace) → createOpencode → restoreCwd`
 * critical section so concurrent startOpencode calls don't race on the
 * process-global cwd. Each call awaits the previous one before mutating.
 */
let cwdChain: Promise<void> = Promise.resolve();

/**
 * Starts an opencode server with the given provider API key embedded in its
 * config, and returns an SDK client pointed at it. The server's child process
 * inherits the current working directory, so we set cwd to the workspace
 * before spawning and restore it immediately after startup. The read-only
 * "plan" agent is used by default — it cannot edit files, which keeps the
 * review safe and avoids non-interactive permission prompts that would hang a
 * CI run.
 */
export async function startOpencode(
  workspace: string,
  providerID: string,
  modelID: string,
  apiKey: string,
  log: (msg: string) => void,
  options: {
    modelOptions?: Record<string, unknown>;
    /** Verifier alias options for the ROOT model (aux-as-root runs; TASK-157). */
    verificationModelOptions?: Record<string, unknown>;
    port?: number;
    promptCache?: boolean;
    baseURL?: string;
    additionalProviderKeys?: OpencodeProviderConfig[];
    proxyEnv?: NodeJS.ProcessEnv;
    /**
     * The scrub mutates process-global env for the spawn window (the SDK
     * offers no env injection), so it is only safe in a single-run process
     * where nothing else reads env concurrently. The multi-run app disables
     * it: a sibling run's credential reads (gateway token, provider keys)
     * would race the window. Restoring earlier is not an option — the child
     * must provably have spawned, or the scrub silently stops scrubbing.
     */
    scrubEnv?: boolean;
  } = {},
): Promise<{ client: OpencodeClient; stop: () => void }> {
  // Serialize against other startOpencode calls so the chdir → spawn → restore
  // sequence runs atomically. This is the only safe way to scope cwd to the
  // child process while using the SDK's `createOpencode` factory, which
  // doesn't accept a cwd option directly.
  const previous = cwdChain;
  let release: () => void = () => undefined;
  cwdChain = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const previousCwd = process.cwd();
  let restoreCwd = () => {
    /* no-op before assignment */
    try {
      process.chdir(previousCwd);
    } catch {
      /* best effort */
    }
  };
  let lockReleased = false;
  // Scrubbed only within this serialized critical section (backend setup runs
  // before any session dispatch), restored the moment the child has spawned —
  // the child copies its environment at spawn, so the parent's restore never
  // reaches it.
  const scrubbedEnv = new Map<string, string>();
  const scopedEnv = new Map<string, string | undefined>();
  const restoreAndRelease = () => {
    for (const [key, value] of scrubbedEnv) process.env[key] = value;
    scrubbedEnv.clear();
    for (const [key, value] of scopedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    scopedEnv.clear();
    restoreCwd();
    if (!lockReleased) {
      lockReleased = true;
      release();
    }
  };

  try {
    // Move chdir inside try so the mutex is released on any error.
    process.chdir(workspace);
    log(`opencode cwd: ${process.cwd()}`);

    restoreCwd = () => {
      try {
        process.chdir(previousCwd);
      } catch {
        /* best effort */
      }
    };
    for (const [key, value] of Object.entries(options.proxyEnv ?? {})) {
      scopedEnv.set(key, process.env[key]);
      process.env[key] = value;
    }
    // Hermetic config: the child uses ONLY jbot's config (via
    // OPENCODE_CONFIG_CONTENT) plus the context7 MCP jbot adds at runtime,
    // never ambient opencode config. Two sources, two switches:
    //   - Project (reviewed repo's .opencode/): auto-EXECUTES plugins/tools at
    //     session start outside the tool sandbox — a malicious-PR RCE beside
    //     the provider keys and GitHub token (read-only invariant 8, layer 4).
    //   - Global (~/.config/opencode): its MCP servers add unvetted,
    //     write-capable tools (github, postgres) and 400 a Gemini backend
    //     (schemas carry x-mcp-header / exclusiveMinimum). Empty XDG_CONFIG_HOME
    //     drops them; auth lives under XDG_DATA_HOME, so it stays.
    // Scoped like proxyEnv above: the child copies these at spawn, the parent
    // restores immediately after.
    scopedEnv.set('OPENCODE_DISABLE_PROJECT_CONFIG', process.env.OPENCODE_DISABLE_PROJECT_CONFIG);
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
    scopedEnv.set('XDG_CONFIG_HOME', process.env.XDG_CONFIG_HOME);
    process.env.XDG_CONFIG_HOME = hermeticOpencodeConfigHome();
    if (options.scrubEnv !== false) {
      for (const key of sessionEnvDenyKeys(Object.keys(process.env))) {
        scrubbedEnv.set(key, process.env[key]!);
        delete process.env[key];
      }
    }
    if (scrubbedEnv.size > 0) {
      log(`Withheld ${scrubbedEnv.size} credential env var(s) from the opencode child.`);
    }
    const config = {
      ...buildConfig(
        providerID,
        modelID,
        apiKey,
        options.modelOptions,
        options.promptCache ?? true,
        options.additionalProviderKeys,
        options.baseURL,
        options.verificationModelOptions,
      ),
      // Bash wire-schema shim: Gemini-backed proxies 400 on exclusiveMinimum.
      plugin: [toolSchemaShimPluginUrl()],
    };
    const { client, server } = await createOpencode({
      hostname: '127.0.0.1',
      // Fixed port means two runs on one host collide (e.g. the webhook app
      // plus a CI job on a self-hosted runner); override per process.
      port: options.port ?? parsePortEnv('JBOT_OPENCODE_PORT', 4096),
      timeout: READY_TIMEOUT_MS,
      config,
    });
    restoreAndRelease();

    log(`opencode server listening at ${server.url} (provider=${providerID} model=${modelID})`);
    clientDirectories.set(client, workspace);

    const stop = () => {
      try {
        server.close();
      } catch (error) {
        log(`opencode server close failed: ${formatUnknownError(error)}`);
      }
    };

    return { client, stop };
  } catch (err) {
    // Restore cwd on failure and release the lock so the next caller can proceed.
    restoreAndRelease();
    throw err;
  }
}

export async function listProviderModels(
  client: OpencodeClient,
  providerID: string,
  timeoutMs = MODEL_LIST_TIMEOUT_MS,
): Promise<string[]> {
  const result = await withTimeout(
    client.provider.list(),
    timeoutMs,
    `provider model listing timed out after ${timeoutMs}ms`,
  );
  const data = result.data;
  if (!isProviderListData(data)) return [];

  const provider = data.all.find((item) => item.id === providerID);
  if (!provider) return [];

  return Object.keys(provider.models)
    .map((modelID) => `${providerID}/${modelID}`)
    .sort();
}

export async function enableContext7Mcp(
  client: OpencodeClient,
  apiKey: string,
  log: (msg: string) => void,
): Promise<boolean> {
  const trimmedKey = apiKey.trim();
  if (!trimmedKey) return false;
  let added = false;

  try {
    await client.mcp.add({
      body: {
        name: CONTEXT7_MCP_NAME,
        config: {
          type: 'remote',
          url: CONTEXT7_MCP_URL,
          enabled: true,
          headers: {
            CONTEXT7_API_KEY: trimmedKey,
            Accept: 'application/json, text/event-stream',
          },
          timeout: CONTEXT7_MCP_TIMEOUT_MS,
        },
      },
    });
    added = true;
    await client.mcp.connect({ path: { name: CONTEXT7_MCP_NAME } });
    log('Context7 MCP enabled for external API/SDK documentation checks.');
    return true;
  } catch (error) {
    if (added) await disableContext7Mcp(client, log);
    const detail = formatContext7Error(error, trimmedKey);
    const note = isContext7QuotaError(detail)
      ? 'Context7 out of credit or rate-limited; review continues with the framework-behavior abstention fallback (refill credit or rotate CONTEXT7_API_KEY to re-enable docs checks)'
      : 'Context7 MCP unavailable; continuing without it';
    log(`${note}: ${detail}`);
    return false;
  }
}

export async function disableContext7Mcp(
  client: OpencodeClient,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await client.mcp.disconnect({ path: { name: CONTEXT7_MCP_NAME } });
  } catch (error) {
    log(`Context7 MCP disconnect skipped: ${formatContext7Error(error)}`);
  }
}

function isProviderListData(value: unknown): value is {
  all: Array<{ id: string; models: Record<string, unknown> }>;
} {
  if (!isRecord(value) || !Array.isArray(value.all)) return false;
  return value.all.every(
    (item) => isRecord(item) && typeof item.id === 'string' && isRecord(item.models),
  );
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

export function parsePortEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : defaultValue;
}

/** Shared by the pi engine (pi.ts); a timeout rejection never leaks an unhandled rejection. */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // If the timeout wins, keep any later rejection from the original operation
  // from surfacing as an unhandled rejection.
  void promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Runs one review session and returns structured findings.
 *
 * Uses the current SDK API: `client.session.prompt()` (replaces the legacy
 * `chat()` from 0.4.x). The agent runs as the read-only "plan" agent by
 * default. An optional lens addendum (REVIEW_LENSES) turns the session into
 * a focused recall pass; the label keeps log lines distinguishable when
 * several passes run in parallel.
 *
 * Main-review output is strict: if the response fails JSON parsing, ONE
 * repair prompt is sent in the same session (the model sees its own
 * malformed output) before the run fails.
 */
export async function runReview(
  client: OpencodeClient,
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

  const { raw, sessionID } = await promptPlanAgent(
    client,
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
    const repaired = await repromptForJson(
      client,
      model,
      sessionID,
      raw,
      error,
      label,
      log,
      options.timeoutMs,
      options.onTokenUsage,
    );
    return parseReview(repaired, `${label}-repair`, log, { strict: true });
  }
}

/**
 * One same-session recovery re-prompt, shared by the main and auxiliary
 * sessions: a continuation for an abandoned turn (announcement/empty — a
 * reformat request there just elicits another announcement), the JSON repair
 * for a malformed attempt.
 */
async function repromptForJson(
  client: OpencodeClient,
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
      client,
      model,
      sessionID,
      CONTINUATION_NUDGE_PROMPT,
      `${label}-continue`,
      log,
      timeoutMs,
      onTokenUsage,
      undefined,
      label,
    );
  }
  log(`${label} response unparseable; sending one JSON repair prompt: ${message}`);
  return promptPlanAgentInSession(
    client,
    model,
    sessionID,
    buildJsonRepairPrompt(message),
    `${label}-repair`,
    log,
    timeoutMs,
    onTokenUsage,
    undefined,
    label,
  );
}

/**
 * Runs an aux session's output through a strict parse, one same-session JSON
 * repair on failure, then a lenient parse — failing open to the empty selection
 * if the repair is unparseable or its round-trip dies. Aux checks never fail the
 * run (invariant #3).
 */
async function parseAuxSessionWithRepair<T>(
  session: {
    client: OpencodeClient;
    model: string;
    sessionID: string;
    raw: string;
    label: string;
    log: (msg: string) => void;
    timeoutMs?: number;
    onTokenUsage?: TokenUsageRecorder;
  },
  select: (result: ReviewResult) => T,
): Promise<T> {
  const { client, model, sessionID, raw, label, log, timeoutMs, onTokenUsage } = session;
  try {
    return select(parseReview(raw, label, log, { strict: true }));
  } catch (error) {
    try {
      const repaired = await repromptForJson(
        client,
        model,
        sessionID,
        raw,
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

export async function runAddressedPriorCommentsCheck(
  client: OpencodeClient,
  model: string,
  prContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<AddressedPriorComment[]> {
  const prompt = assembleAddressedPriorCommentsPrompt(prContext);
  const { raw, sessionID } = await promptPlanAgent(
    client,
    model,
    prompt,
    'addressed-prior-comments',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseAuxSessionWithRepair(
    {
      client,
      model,
      sessionID,
      raw,
      label: 'addressed-prior-comments',
      log,
      timeoutMs,
      onTokenUsage,
    },
    (result) => result.addressedPriorComments,
  );
}

export async function runGuidelineComplianceCheck(
  client: OpencodeClient,
  model: string,
  prContext: string,
  guidelines: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<Finding[]> {
  const prompt = assembleGuidelineCompliancePrompt(prContext, guidelines);
  const { raw, sessionID } = await promptPlanAgent(
    client,
    model,
    prompt,
    'guideline-compliance',
    log,
    timeoutMs,
    onTokenUsage,
  );
  return parseAuxSessionWithRepair(
    { client, model, sessionID, raw, label: 'guideline-compliance', log, timeoutMs, onTokenUsage },
    (result) => result.findings,
  );
}

export async function runChangesSinceLastReview(
  client: OpencodeClient,
  model: string,
  prContext: string,
  deltaContext: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
): Promise<string> {
  const prompt = assembleChangesSinceLastReviewPrompt(prContext, deltaContext);
  const { raw } = await promptPlanAgent(
    client,
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
  client: OpencodeClient,
  model: string,
  prContext: string,
  findings: Finding[],
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  modelOptions?: Record<string, unknown>,
): Promise<FindingVerdict[] | undefined> {
  // TASK-157: per-session options don't exist in the prompt API; when the
  // runner passed verifier options it also registered the matching alias
  // entry at boot, so the floored effort rides the alias model id.
  const verificationModel = modelOptions ? `${model}${VERIFICATION_MODEL_ALIAS_SUFFIX}` : model;
  // Pass findings through unprojected: Finding is structurally a VerifiableFinding.
  // An earlier field-subset projection here silently dropped `evidence` and
  // defeated verifier grounding on this (primary) backend — don't reintroduce one.
  const prompt = assembleFindingVerificationPrompt(prContext, findings, true);
  // Single-shot: exploration tools off, so the verifier judges from the embedded
  // diff in one model call instead of an agentic git/grep loop.
  const { raw } = await promptPlanAgent(
    client,
    verificationModel,
    prompt,
    'finding-verification',
    log,
    timeoutMs,
    onTokenUsage,
    SINGLE_SHOT_TOOLS,
  );
  return parseFindingVerdicts(raw, findings.length, log);
}

// Defense-in-depth tool sets for every review prompt. Default: mutating tools
// off, exploration (bash/read/grep) on. Single-shot also turns exploration off,
// forcing ONE model call with no agentic round-trips (used by finding-verification,
// which judges from the embedded diff).
const READONLY_TOOLS = { write: false, edit: false, patch: false } as const;
const SINGLE_SHOT_TOOLS = {
  write: false,
  edit: false,
  patch: false,
  bash: false,
  read: false,
  grep: false,
  glob: false,
  list: false,
  webfetch: false,
} as const;

async function promptPlanAgent(
  client: OpencodeClient,
  model: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs?: number,
  onTokenUsage?: TokenUsageRecorder,
  tools?: Record<string, boolean>,
): Promise<{ raw: string; sessionID: string }> {
  log(`Creating ${label} session`);
  // The title makes parallel sessions distinguishable in opencode's own
  // session list when debugging a run.
  const created = await client.session.create({
    body: { title: `jbot-review ${label}` },
    query: queryDirectory(client),
  });
  const session = created.data;
  if (!session) throw new Error(`Failed to create ${label} session`);
  log(`${label} session created: ${session.id}`);

  const raw = await promptPlanAgentInSession(
    client,
    model,
    session.id,
    prompt,
    label,
    log,
    timeoutMs,
    onTokenUsage,
    tools,
  );
  return { raw, sessionID: session.id };
}

async function promptPlanAgentInSession(
  client: OpencodeClient,
  model: string,
  sessionID: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs = PROMPT_TIMEOUT_MS,
  onTokenUsage?: TokenUsageRecorder,
  tools?: Record<string, boolean>,
  /** Grace-abort registry key; repair/continue prompts keep the BASE label. */
  abortLabel = label,
): Promise<string> {
  const release = sessionSlots ? await sessionSlots.acquire() : undefined;
  try {
    return await promptInSessionHoldingSlot(
      client,
      model,
      sessionID,
      prompt,
      label,
      log,
      timeoutMs,
      onTokenUsage,
      tools,
      abortLabel,
    );
  } finally {
    release?.();
  }
}

async function promptInSessionHoldingSlot(
  client: OpencodeClient,
  model: string,
  sessionID: string,
  prompt: string,
  label: string,
  log: (msg: string) => void,
  timeoutMs: number,
  onTokenUsage?: TokenUsageRecorder,
  tools: Record<string, boolean> = READONLY_TOOLS,
  abortLabel = label,
): Promise<string> {
  const { providerID, modelID } = parseModelName(model);
  // Abortable only while a prompt is in flight (mirrors the pi registry's
  // dispose-time cleanup): a settled session left registered would eat a
  // later same-label abort as a spurious failed-abort log line. Keyed by the
  // BASE label — a repair/continue prompt must stay reachable by the runner's
  // grace-expiry abort, which only knows base labels.
  registerOpencodeSessionForAbort(client, abortLabel, sessionID);
  try {
    // A follow-up prompt in an existing session must not return the previous
    // completed assistant message: remember its id and wait for a NEWER one.
    const previous = await getLatestAssistantMessage(client, sessionID, label);
    const previousMessageID = previous?.info.id;

    log(`Calling ${label} prompt (agent=plan, provider=${providerID} model=${modelID})`);
    const promptRes = await client.session.promptAsync({
      path: { id: sessionID },
      query: queryDirectory(client),
      body: {
        model: { providerID, modelID },
        agent: 'plan',
        // Defense-in-depth alongside the plan agent and the config-level
        // permission.edit deny: mutating tools are always off. Default keeps
        // bash/read on (the review needs git diff/log/grep); single-shot callers
        // pass SINGLE_SHOT_TOOLS to turn exploration off for a one-call response.
        tools,
        parts: [{ type: 'text', text: prompt }],
      },
    });
    const promptError = getResultError(promptRes);
    if (promptError) throw new Error(`opencode ${label} prompt was rejected: ${promptError}`);

    let data;
    try {
      data = await waitForAssistantMessage(
        client,
        sessionID,
        label,
        log,
        previousMessageID,
        timeoutMs,
      );
    } catch (error) {
      // A timed-out or failed wait leaves the session generating (and
      // spending tokens) until the server shuts down; stop it now.
      await abortSessionBestEffort(client, sessionID, label, log);
      throw error;
    }

    const parts = data.parts;
    const telemetry = opencodeToolTelemetry.get(client);
    if (telemetry) recordOpencodeToolParts(telemetry, label, data.observedParts);
    log(
      `${label} prompt complete: parts=${parts.length} (types: ${parts.map((p) => p.type).join(', ')})`,
    );
    log(`${label} ${formatTokenUsage(data.info)}`);
    const usage = extractPromptTokenUsage(data.info);
    if (usage) onTokenUsage?.(usage, model, label);

    const textParts = parts.filter(
      (part): part is Extract<Part, { type: 'text' }> => part.type === 'text' && Boolean(part.text),
    );
    // No text part (e.g. the model exhausted its budget on reasoning) must
    // surface as a parse failure so the repair loop fires — defaulting to
    // '{}' would silently score the session as "no findings".
    const raw = textParts
      .map((p) => p.text)
      .join('\n\n')
      .trim();
    if (!raw)
      log(
        `${label} response contained no text part (types: ${parts.map((p) => p.type).join(', ')})`,
      );
    log(`Extracted ${label} text: ${raw.length} chars from ${textParts.length} text part(s)`);
    return raw;
  } finally {
    unregisterOpencodeSessionForAbort(client, abortLabel, sessionID);
  }
}

/**
 * Grace-abandon abort registry (TASK-076): sessions register at creation and
 * stay registered — aborting a finished session is a server-side no-op, the
 * set is cleared on the first abort, and the registry dies with the client.
 */
const abortableSessionsByLabel = new WeakMap<OpencodeClient, Map<string, Set<string>>>();

export function registerOpencodeSessionForAbort(
  client: OpencodeClient,
  label: string,
  sessionID: string,
): void {
  const byLabel = abortableSessionsByLabel.get(client) ?? new Map<string, Set<string>>();
  abortableSessionsByLabel.set(client, byLabel);
  const ids = byLabel.get(label) ?? new Set<string>();
  byLabel.set(label, ids);
  ids.add(sessionID);
}

export function unregisterOpencodeSessionForAbort(
  client: OpencodeClient,
  label: string,
  sessionID: string,
): void {
  abortableSessionsByLabel.get(client)?.get(label)?.delete(sessionID);
}

/**
 * Best-effort, fire-and-forget: used when the settle grace abandons a result.
 * Returns the signalled count (the ReviewBackend.abortSessionsByLabel contract).
 */
export function abortOpencodeSessionsByLabel(
  client: OpencodeClient,
  label: string,
  log: (msg: string) => void,
): number {
  const ids = abortableSessionsByLabel.get(client)?.get(label);
  if (!ids || ids.size === 0) return 0;
  const count = ids.size;
  for (const sessionID of ids) void abortSessionBestEffort(client, sessionID, label, log);
  ids.clear();
  return count;
}

async function abortSessionBestEffort(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await withTimeout(
      client.session.abort({ path: { id: sessionID }, query: queryDirectory(client) }),
      PROMPT_POLL_REQUEST_TIMEOUT_MS,
      `abort timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms`,
    );
    log(`Aborted ${label} session ${sessionID}.`);
  } catch (error) {
    log(
      `(failed to abort ${label} session ${sessionID}: ${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
}

async function waitForAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  log: (msg: string) => void,
  ignoreMessageID?: string,
  timeoutMs = PROMPT_TIMEOUT_MS,
): Promise<{
  info: AssistantMessage;
  parts: ReadonlyArray<Part>;
  observedParts: ReadonlyArray<Part>;
}> {
  const startedAt = Date.now();
  let lastStatus = 'unknown';
  let lastProgressLogAt = startedAt;

  while (Date.now() - startedAt < timeoutMs) {
    const latest = await getLatestAssistantMessage(client, sessionID, label, ignoreMessageID);
    const message = latest && latest.info.id === ignoreMessageID ? undefined : latest;
    if (message?.info.error) {
      throw new Error(`opencode ${label} prompt failed: ${formatUnknownError(message.info.error)}`);
    }

    const status = await getSessionStatus(client, sessionID, label);
    if (status) lastStatus = describeSessionStatus(status);
    if (message && (status?.type === 'idle' || message.info.time.completed)) {
      return {
        info: message.info,
        parts: message.parts,
        observedParts: message.observedParts,
      };
    }

    const now = Date.now();
    if (now - lastProgressLogAt >= PROMPT_PROGRESS_LOG_MS) {
      log(
        `${label} prompt still running (${Math.round((now - startedAt) / 1000)}s, ${lastStatus})`,
      );
      lastProgressLogAt = now;
    }

    await sleep(PROMPT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `opencode ${label} prompt did not finish within ${Math.round(
      timeoutMs / 1000,
    )}s (last status: ${lastStatus})`,
  );
}

async function getLatestAssistantMessage(
  client: OpencodeClient,
  sessionID: string,
  label: string,
  afterMessageID?: string,
): Promise<
  | {
      info: AssistantMessage;
      parts: ReadonlyArray<Part>;
      observedParts: ReadonlyArray<Part>;
    }
  | undefined
> {
  const result = await withTimeout(
    client.session.messages({ path: { id: sessionID }, query: queryDirectory(client) }),
    PROMPT_POLL_REQUEST_TIMEOUT_MS,
    `opencode ${label} message polling timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms (session=${sessionID})`,
  );
  const error = getResultError(result);
  if (error) throw new Error(`opencode ${label} message polling failed: ${error}`);

  const messages = (result.data ?? []).filter(
    (message): message is typeof message & { info: AssistantMessage } =>
      message.info.role === 'assistant',
  );
  const latest = messages.at(-1);
  if (!latest) return undefined;
  return {
    info: latest.info,
    parts: latest.parts ?? [],
    observedParts: observedAssistantParts(messages, afterMessageID),
  };
}

async function getSessionStatus(
  client: OpencodeClient,
  sessionID: string,
  label: string,
): Promise<SessionStatus | undefined> {
  const result = await withTimeout(
    client.session.status({ query: queryDirectory(client) }),
    PROMPT_POLL_REQUEST_TIMEOUT_MS,
    `opencode ${label} status polling timed out after ${PROMPT_POLL_REQUEST_TIMEOUT_MS}ms (session=${sessionID})`,
  );
  const error = getResultError(result);
  if (error) throw new Error(`opencode ${label} status polling failed: ${error}`);
  const statuses = result.data;
  return statuses?.[sessionID];
}

function queryDirectory(client: OpencodeClient): { directory: string } | undefined {
  const directory = clientDirectories.get(client);
  return directory ? { directory } : undefined;
}

function describeSessionStatus(status: SessionStatus): string {
  if (status.type === 'retry') return `retry attempt ${status.attempt}: ${status.message}`;
  return status.type;
}

function getResultError(result: unknown): string | undefined {
  if (!isRecord(result) || !('error' in result) || result.error == null) return undefined;
  return formatUnknownError(result.error);
}

function formatUnknownError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Evidence quotes parse from any backend regardless of the prompt flag; the cap
// defends against runaway quotes.
// Room for the two or three consecutive lines EVIDENCE_INSTRUCTION asks for:
// a quote truncated mid-line cannot match the file exactly.

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
  options: { strict?: boolean } = {},
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
 * Parses the verifier's {"verdicts": [...]} response. Returns undefined when
 * the response is unusable so callers fail open. Individual malformed
 * entries are skipped; a finding without a verdict is treated as confirmed
 * by the caller. Exported for direct test coverage.
 */
export function parseFindingVerdicts(
  raw: string,
  findingCount: number,
  log: (msg: string) => void,
): FindingVerdict[] | undefined {
  let parsed: unknown;
  try {
    parsed = parseJsonObject(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`finding-verification response was not valid JSON: ${message}`);
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.verdicts)) {
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
      verdicts.push({
        index: v.index,
        verdict: v.verdict as FindingVerdict['verdict'],
        reason: typeof v.reason === 'string' ? v.reason : undefined,
      });
    }
  }
  return verdicts;
}

/**
 * Parses the "changes since last review" pass output. Unlike parseReview, an
 * unparseable or summary-less response yields '' (not a placeholder string) so
 * the caller OMITS the block — the pass fails open.
 */
export function parseChangesSinceLastReviewSummary(
  raw: string,
  label: string,
  log: (msg: string) => void,
): string {
  try {
    const obj = parseJsonObject(raw) as Record<string, unknown>;
    return typeof obj.summary === 'string' ? obj.summary.trim() : '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(
      `${label} response was not valid JSON; omitting the changes-since-last-review block: ${message}`,
    );
    return '';
  }
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
