export interface ProviderConfig {
  defaultModel: string;
  keyEnv: string;
  keyInput: string;
  fallbackKey?: { env: string; input: string };
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

export interface ModelConfig {
  /**
   * Whether opencode should send promptCacheKey for this model. Defaults true
   * when omitted; false entries are seeded from Models.dev family metadata.
   */
  promptCache?: boolean;
}

const GLM_PROMPT_CACHE_UNSUPPORTED_MODELS = {
  'glm-5.1': { promptCache: false },
  'glm-5.2': { promptCache: false },
  'glm-5': { promptCache: false },
} satisfies Record<string, ModelConfig>;

// See https://models.dev/ for opencode-backed model catalogs. CLI backends
// such as Devin, CommandCode, and Cursor expose their own model lists.
export const PROVIDERS: Record<string, ProviderConfig> = {
  opencode: {
    defaultModel: 'opencode/deepseek-v4-flash-free',
    keyEnv: 'OPENCODE_API_KEY',
    keyInput: 'opencode-api-key',
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
    // No per-model promptCache override: Fireworks rejects promptCacheKey for every
    // model, so it is disabled provider-wide in modelSupportsPromptCache below.
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
    providerID === 'kilo'
  )
    return false;
  // Fireworks' OpenAI-compatible endpoint strictly rejects unknown request fields, so
  // the promptCacheKey opencode sends with setCacheKey returns a non-retryable 400 for
  // every Fireworks model. Disable provider-wide rather than per-model.
  if (providerID === 'fireworks-ai') return false;
  return PROVIDERS[providerID]?.models?.[modelID]?.promptCache !== false;
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
