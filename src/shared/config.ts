export interface ProviderConfig {
  defaultModel: string;
  keyEnv: string;
  keyInput: string;
  models?: Record<string, ModelConfig>;
}

export interface ModelConfig {
  /**
   * Whether opencode should send promptCacheKey for this model. Defaults true
   * when omitted; false entries are seeded from Models.dev family metadata.
   */
  promptCache?: boolean;
}

// See https://models.dev/ for the full list of available models and providers.
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
    // Models.dev marks these opencode-go models as family=glm; that gateway
    // rejects promptCacheKey for GLM models. Omitted models default enabled.
    models: {
      'glm-5.1': { promptCache: false },
      'glm-5.2': { promptCache: false },
      'glm-5': { promptCache: false },
    },
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
  },
  xai: {
    defaultModel: 'xai/grok-4.3',
    keyEnv: 'XAI_API_KEY',
    keyInput: 'xai-api-key',
  },
};

export function modelSupportsPromptCache(providerID: string, modelID: string): boolean {
  return PROVIDERS[providerID]?.models?.[modelID]?.promptCache !== false;
}
