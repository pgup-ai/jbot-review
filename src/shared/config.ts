import { parseModelName } from '@symma/protocol';

export interface ProviderConfig {
  defaultModel?: string;
  keyEnv: string;
  keyInput: string;
  fallbackKey?: { env: string; input: string };
  custom?: {
    name: string;
    npm: string;
    baseURL: { env: string; input: string };
  };
  promptCache?: boolean;
  models?: Record<string, ModelConfig>;
}

export interface ProviderCredentialSource {
  env: string;
  input: string;
}

export function providerCredentialSources(config: ProviderConfig): ProviderCredentialSource[] {
  return [
    { env: config.keyEnv, input: config.keyInput },
    ...(config.fallbackKey ? [config.fallbackKey] : []),
  ];
}

export function resolveProviderCredential(
  config: ProviderConfig,
  read: (source: ProviderCredentialSource) => string | undefined,
): string {
  for (const source of providerCredentialSources(config)) {
    const value = read(source)?.trim();
    if (value) return value;
  }
  return '';
}

export interface ProviderCredential {
  apiKey: string;
  baseURL?: string;
}

/**
 * Resolves a credential for every provider the pools draw on. A pool may span
 * providers — only one candidate runs per PR — so each needs its own key, and
 * resolving all of them up front keeps a missing key failing on the next run
 * rather than only the runs that happen to pick that provider.
 *
 * A configured candidate is never silently dropped: listing a model is a
 * request to review with it, so an unusable one is a configuration error.
 */
export function resolvePoolCredentials(
  pool: string[],
  read: (source: ProviderCredentialSource) => string | undefined,
  missingKeyHint = '',
): Map<string, ProviderCredential> {
  const credentials = new Map<string, ProviderCredential>();
  for (const model of pool) {
    const { providerID } = parseModelName(model);
    if (credentials.has(providerID)) continue;
    const config = providerConfig(providerID, model);
    const apiKey = resolveProviderCredential(config, read);
    if (!apiKey) {
      const sources = providerCredentialSources(config)
        .map(({ input, env }) => `"${input}" or ${env}`)
        .join(', then fallback to ');
      throw new Error(
        `Missing key for provider "${providerID}", required by pooled model "${model}". ` +
          `Pass ${sources}.${missingKeyHint}`,
      );
    }
    credentials.set(providerID, {
      apiKey,
      baseURL: resolveProviderBaseURL(providerID, config, read),
    });
  }
  return credentials;
}

/**
 * Looks a provider up by id. `source` names the model ref the id was derived
 * from, so a run that dropped its provider input but kept an unqualified model
 * gets told where the unknown id came from.
 */
export function providerConfig(providerID: string, source?: string): ProviderConfig {
  const config = PROVIDERS[providerID];
  if (!config) {
    throw new Error(
      `Unknown provider "${providerID}"${source ? ` derived from model "${source}"` : ''}. ` +
        `Supported: ${Object.keys(PROVIDERS).join(', ')}.`,
    );
  }
  return config;
}

function reasoningOptions(providerID: string, effort: string): Record<string, unknown> {
  // Poolside manages reasoning itself, and arbitrary custom endpoints may
  // reject provider-specific options.
  if (providerID === 'poolside') return { reasoningEffort: 'default' };
  return PROVIDERS[providerID]?.custom ? {} : { reasoningEffort: effort };
}

export function defaultModelOptions(providerID: string): Record<string, unknown> {
  return reasoningOptions(providerID, 'medium');
}

/**
 * Auxiliary sessions are recall supplements that land on the tail of the run,
 * and these models spend most of their output budget reasoning — one lens was
 * observed emitting 15,762 reasoning tokens and 53 of content, producing
 * nothing while costing minutes. They get a lower effort than the deep pass.
 *
 * Reaches an aux session only when it runs a model of its own: options are
 * scoped per model id, so an aux model that IS the main model shares its entry
 * and its effort.
 */
export function defaultAuxModelOptions(providerID: string): Record<string, unknown> {
  return reasoningOptions(providerID, 'low');
}

/**
 * The aux model's options, or undefined when it shares the main model's entry
 * and therefore its effort. Identity is provider-scoped: two providers can
 * serve the same model id, and the aux one is routed separately.
 */
export function auxModelOptionsFor(
  providerID: string,
  modelID: string,
  auxProviderID: string,
  auxModelID: string,
): Record<string, unknown> | undefined {
  if (auxProviderID === providerID && auxModelID === modelID) return undefined;
  return defaultAuxModelOptions(auxProviderID);
}

export function needsAuxOpencodeConfig(
  providerID: string,
  modelID: string,
  auxProviderID: string,
  auxModelID: string,
): boolean {
  return (
    auxProviderID !== providerID ||
    (auxModelID !== modelID && Boolean(PROVIDERS[providerID]?.custom))
  );
}

export function resolveProviderBaseURL(
  providerID: string,
  config: ProviderConfig,
  read: (source: { env: string; input: string }) => string | undefined,
): string | undefined {
  const source = config.custom?.baseURL;
  if (!source) return undefined;
  const value = read(source)?.trim();
  if (!value) {
    throw new Error(
      `Missing base URL for provider "${providerID}". Pass "${source.input}" or ${source.env}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid base URL for provider "${providerID}": expected an absolute URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid base URL for provider "${providerID}": expected http:// or https://.`);
  }
  return value;
}

export interface ModelConfig {
  /**
   * Whether opencode should send promptCacheKey for this model. Defaults true
   * when omitted; false entries are seeded from Models.dev family metadata.
   */
  promptCache?: boolean;
  /**
   * Reasoning efforts this model accepts. Omitted means every effort is fine;
   * a request outside the list is clamped to the nearest supported tier
   * (ties upward) so the provider never rejects the call (TASK-157).
   */
  reasoningEfforts?: readonly string[];
}

const GLM_PROMPT_CACHE_UNSUPPORTED_MODELS = {
  'glm-5.1': { promptCache: false },
  'glm-5.2': { promptCache: false },
  'glm-5': { promptCache: false },
} satisfies Record<string, ModelConfig>;

/**
 * Models that always reason and accept only these efforts: the main pass's
 * `medium` is a hard 400 ("[1210] This model always engages in thinking and
 * cannot be disabled; please use low, high, or max"), which no retry recovers.
 */
const ALWAYS_THINKING_MODELS = {
  'x-preview-f-free': { reasoningEfforts: ['low', 'high', 'max'] },
} satisfies Record<string, ModelConfig>;

// See https://models.dev/ for opencode-backed model catalogs. CLI backends
// such as Devin, CommandCode, and Cursor expose their own model lists.
export const PROVIDERS: Record<string, ProviderConfig> = {
  opencode: {
    defaultModel: 'opencode/deepseek-v4-flash-free',
    keyEnv: 'OPENCODE_API_KEY',
    keyInput: 'opencode-api-key',
    models: ALWAYS_THINKING_MODELS,
  },
  'opencode-go': {
    defaultModel: 'opencode-go/deepseek-v4-flash',
    keyEnv: 'OPENCODE_API_KEY',
    keyInput: 'opencode-api-key',
    // Models.dev marks these as family=glm; GLM rejects promptCacheKey.
    // Omitted models default enabled.
    models: GLM_PROMPT_CACHE_UNSUPPORTED_MODELS,
  },
  deepseek: {
    defaultModel: 'deepseek/deepseek-v4-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    keyInput: 'deepseek-api-key',
  },
  openai: {
    defaultModel: 'openai/gpt-5.4-nano',
    keyEnv: 'OPENAI_API_KEY',
    keyInput: 'openai-api-key',
  },
  'openai-compatible': {
    keyEnv: 'JBOT_OPENAI_COMPATIBLE_API_KEY',
    keyInput: 'openai-compatible-api-key',
    custom: {
      name: 'OpenAI Compatible',
      npm: '@ai-sdk/openai-compatible',
      baseURL: {
        env: 'JBOT_OPENAI_COMPATIBLE_BASE_URL',
        input: 'openai-compatible-base-url',
      },
    },
    // Arbitrary OpenAI-compatible endpoints may reject opencode's promptCacheKey.
    promptCache: false,
  },
  anthropic: {
    defaultModel: 'anthropic/claude-sonnet-4-6',
    keyEnv: 'ANTHROPIC_API_KEY',
    keyInput: 'anthropic-api-key',
  },
  google: {
    defaultModel: 'google/gemini-2.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    keyInput: 'gemini-api-key',
  },
  openrouter: {
    defaultModel: 'openrouter/openai/gpt-4o-mini',
    keyEnv: 'OPENROUTER_API_KEY',
    keyInput: 'openrouter-api-key',
  },
  nvidia: {
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
    keyEnv: 'NVIDIA_API_KEY',
    keyInput: 'nvidia-api-key',
  },
  'zai-coding-plan': {
    defaultModel: 'zai-coding-plan/glm-5.2',
    keyEnv: 'ZAI_API_KEY',
    keyInput: 'zai-api-key',
    models: GLM_PROMPT_CACHE_UNSUPPORTED_MODELS,
  },
  'kimi-for-coding': {
    defaultModel: 'kimi-for-coding/k3',
    keyEnv: 'KIMI_API_KEY',
    keyInput: 'kimi-api-key',
    // Models.dev does not advertise support for opencode's promptCacheKey.
    promptCache: false,
  },
  xai: {
    defaultModel: 'xai/grok-4.3',
    keyEnv: 'XAI_API_KEY',
    keyInput: 'xai-api-key',
  },
  // Xiaomi MiMo Token Plan (Singapore). Models.dev defines this provider —
  // baseURL, model catalog, and the reasoning-model metadata opencode needs to
  // drive mimo-v2.5-pro — so it needs only the key, no custom def. Keys are
  // region-locked: cn/sgp/ams are separate Models.dev providers.
  // promptCache off: the endpoint is unverified for opencode's promptCacheKey.
  'xiaomi-token-plan-sgp': {
    defaultModel: 'xiaomi-token-plan-sgp/mimo-v2.5-pro',
    keyEnv: 'MIMO_API_KEY',
    keyInput: 'mimo-api-key',
    models: { 'mimo-v2.5-pro': { promptCache: false } },
  },
  'fireworks-ai': {
    defaultModel: 'fireworks-ai/accounts/fireworks/models/deepseek-v4-flash',
    keyEnv: 'FIREWORKS_API_KEY',
    keyInput: 'fireworks-api-key',
    // Fireworks rejects opencode's promptCacheKey with a non-retryable 400 for every model.
    promptCache: false,
  },
  devin: {
    defaultModel: 'devin/default',
    keyEnv: 'DEVIN_WINDSURF_API_KEY',
    keyInput: 'devin-windsurf-api-key',
    models: {
      // Devin CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
  commandcode: {
    defaultModel: 'commandcode/default',
    keyEnv: 'COMMANDCODE_ACCESS_KEY',
    keyInput: 'commandcode-access-key',
    models: {
      // CommandCode CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
  cursor: {
    defaultModel: 'cursor/default',
    keyEnv: 'CURSOR_API_KEY',
    keyInput: 'cursor-api-key',
    models: {
      // Cursor CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
  qoder: {
    defaultModel: 'qoder/auto',
    keyEnv: 'QODER_PERSONAL_ACCESS_TOKEN',
    keyInput: 'qoder-token',
    models: {
      // Qoder sessions run through its CLI/Agent SDK, not an opencode provider.
      auto: { promptCache: false },
    },
  },
  codex: {
    defaultModel: 'codex/default',
    keyEnv: 'CODEX_AUTH_JSON',
    keyInput: 'codex-auth',
    models: {
      // Codex CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
  // Grok Build CLI. Kept separate from xai, which remains the direct API
  // provider routed through the SDK engines with XAI_API_KEY.
  grok: {
    defaultModel: 'grok/default',
    keyEnv: 'GROK_AUTH_JSON',
    keyInput: 'grok-auth',
    fallbackKey: { env: 'XAI_API_KEY', input: 'xai-api-key' },
    models: {
      default: { promptCache: false },
    },
  },
  // Cline pay-as-you-go. JBOT_REVIEW_MODEL: `cline/default`, or `cline/<type>/<model>`
  // (cline models carry their own type), e.g. `cline/deepseek/deepseek-v4-flash`.
  cline: {
    defaultModel: 'cline/default',
    keyEnv: 'CLINE_AUTH_JSON',
    keyInput: 'cline-auth',
    models: {
      // Cline CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
  // Cline subscription (same CLINE_AUTH_JSON, runs `--provider cline-pass`). JBOT_REVIEW_MODEL:
  // `cline-pass/default`, or `cline-pass/<model>` (namespaced under the mode), e.g. `cline-pass/glm-5.2`.
  'cline-pass': {
    defaultModel: 'cline-pass/default',
    keyEnv: 'CLINE_AUTH_JSON',
    keyInput: 'cline-auth',
    models: {
      default: { promptCache: false },
    },
  },
  // Kilo CLI (opencode fork). Auth via KILO_AUTH_CONTENT; default is the free gateway
  // smart-router. JBOT_REVIEW_MODEL: `kilo/kilo-auto/free` or `kilo/<vendor>/<model>`.
  kilo: {
    defaultModel: 'kilo/kilo-auto/free',
    keyEnv: 'KILO_AUTH_CONTENT',
    keyInput: 'kilo-auth',
    models: {
      // Kilo CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
  // DimAgent CLI. Auth via DIM_AUTH_BUNDLE from `npm run dim:bundle`; its own plan
  // has no API key. JBOT_REVIEW_MODEL: `dim/<dimProvider>/<model>` — run
  // `dim model list` for the catalog.
  dim: {
    defaultModel: 'dim/dimcode-api-oauth/deepseek-v4-flash',
    keyEnv: 'DIM_AUTH_BUNDLE',
    keyInput: 'dim-auth',
    models: {
      // dim CLI is not driven through opencode, so prompt-cache options do not apply.
      default: { promptCache: false },
    },
  },
  // Laguna S 2.1 works through Poolside's chat-completions endpoint when
  // named explicitly, despite being absent from its advertised model catalog.
  poolside: {
    defaultModel: 'poolside/laguna-s-2.1',
    keyEnv: 'POOLSIDE_API_KEY',
    keyInput: 'poolside-api-key',
    promptCache: false,
    models: {
      'laguna-s-2.1': { promptCache: false },
    },
  },
};

export function modelSupportsPromptCache(providerID: string, modelID: string): boolean {
  if (
    providerID === 'devin' ||
    providerID === 'commandcode' ||
    providerID === 'cursor' ||
    providerID === 'qoder' ||
    providerID === 'codex' ||
    providerID === 'cline' ||
    providerID === 'cline-pass' ||
    providerID === 'grok' ||
    providerID === 'kilo' ||
    providerID === 'dim'
  )
    return false;
  if (PROVIDERS[providerID]?.promptCache === false) return false;
  return PROVIDERS[providerID]?.models?.[modelID]?.promptCache !== false;
}

// Provider-managed values (poolside's 'default') stay outside this order.
const REASONING_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'max'] as const;

function effortRank(effort: string): number {
  return REASONING_EFFORT_ORDER.indexOf(effort as (typeof REASONING_EFFORT_ORDER)[number]);
}

/**
 * Nearest supported tier for a requested effort, ties resolved UPWARD so a
 * ladder without `medium` cannot quietly reinstate a lower tier (TASK-157).
 * Out-of-range requests clamp to the ladder's end; efforts outside the rank
 * order (provider-managed values) return undefined — the caller drops them.
 */
export function clampReasoningEffort(
  requested: string,
  supported: readonly string[],
): string | undefined {
  const want = effortRank(requested);
  if (want < 0) return undefined;
  return supported
    .filter((effort) => effortRank(effort) >= 0)
    .reduce<string | undefined>((best, effort) => {
      if (best === undefined) return effort;
      const distance = Math.abs(effortRank(effort) - want);
      const bestDistance = Math.abs(effortRank(best) - want);
      if (distance < bestDistance) return effort;
      return distance === bestDistance && effortRank(effort) > effortRank(best) ? effort : best;
    }, undefined);
}

/**
 * Clamps a `reasoningEffort` the model would reject to its nearest supported
 * tier (the provider 400s on unsupported efforts, non-retryably), dropping it
 * only when no tier is rankable. Model options are resolved per provider
 * before a pool entry is chosen, so this is the first point that knows both
 * the model and the effort.
 */
export function supportedModelOptions(
  providerID: string,
  modelID: string,
  modelOptions?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const supported = PROVIDERS[providerID]?.models?.[modelID]?.reasoningEfforts;
  const effort = modelOptions?.reasoningEffort;
  if (!supported || typeof effort !== 'string' || supported.includes(effort)) return modelOptions;
  const clamped = clampReasoningEffort(effort, supported);
  const { reasoningEffort: _dropped, ...rest } = modelOptions!;
  return clamped ? { ...rest, reasoningEffort: clamped } : rest;
}

/**
 * The verifier's model options (TASK-157): a verifier reasoning below the
 * finder cannot overturn the finder's reasoning errors, so parity with the
 * main pass is the floor. `undefined` aux options mean the verifier shares
 * the main model entry, where parity already holds. Efforts outside the rank
 * order (provider-managed) are left alone.
 */
export function verificationModelOptions(
  mainOptions: Record<string, unknown> | undefined,
  auxOptions: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!auxOptions) return undefined;
  const mainEffort = mainOptions?.reasoningEffort;
  if (typeof mainEffort !== 'string' || effortRank(mainEffort) < 0) return auxOptions;
  const auxEffort = auxOptions.reasoningEffort;
  // A provider-managed aux effort (poolside 'default') is outside the order
  // and never overwritten; a rankable one at or above the floor stands.
  if (
    typeof auxEffort === 'string' &&
    (effortRank(auxEffort) < 0 || effortRank(auxEffort) >= effortRank(mainEffort))
  ) {
    return auxOptions;
  }
  return { ...auxOptions, reasoningEffort: mainEffort };
}

export interface PromptCachePolicyInput {
  promptCache?: boolean;
  mainModel: string;
  mainProviderID: string;
  mainModelID: string;
  auxModel: string;
  auxProviderID: string;
  auxModelID: string;
}

export interface PromptCachePolicy {
  providerPromptCache: boolean;
  auxProviderPromptCache: boolean;
  disabledPromptCacheModels: string[];
  sharedProviderCacheDisabled: boolean;
}

export function resolvePromptCachePolicy(input: PromptCachePolicyInput): PromptCachePolicy {
  const promptCache = input.promptCache ?? true;
  const mainSupportsPromptCache = modelSupportsPromptCache(input.mainProviderID, input.mainModelID);
  const auxSupportsPromptCache = modelSupportsPromptCache(input.auxProviderID, input.auxModelID);
  const sameProvider = input.auxProviderID === input.mainProviderID;
  const disabledPromptCacheModels: string[] = [];

  if (promptCache && !mainSupportsPromptCache) {
    disabledPromptCacheModels.push(input.mainModel);
  }
  if (promptCache && input.auxModel !== input.mainModel && !auxSupportsPromptCache) {
    disabledPromptCacheModels.push(input.auxModel);
  }

  return {
    providerPromptCache:
      promptCache && mainSupportsPromptCache && (!sameProvider || auxSupportsPromptCache),
    auxProviderPromptCache: promptCache && auxSupportsPromptCache,
    disabledPromptCacheModels,
    sharedProviderCacheDisabled:
      promptCache &&
      sameProvider &&
      mainSupportsPromptCache &&
      !auxSupportsPromptCache &&
      input.auxModel !== input.mainModel,
  };
}

/**
 * Boolean env knob, shared by every entry point so a flag cannot mean different
 * things in each. Only the exact lowercased `'false'` disables; unset or
 * anything else keeps the default, mirroring the workflow's parseBooleanInput.
 */
export function parseEnvBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  return defaultValue;
}

/** JBOT_GUIDELINE_WIDEN: only the exact 'full' restores widen-everywhere. */
export function parseEnvGuidelineWiden(name: string): 'auto' | 'full' {
  return process.env[name]?.trim().toLowerCase() === 'full' ? 'full' : 'auto';
}
