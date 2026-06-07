export interface ProviderConfig {
  defaultModel: string;
  keyEnv: string;
}

// See https://models.dev/ for the full list of available models and providers.
export const PROVIDERS: Record<string, ProviderConfig> = {
  opencode: {
    defaultModel: 'opencode/deepseek-v4-flash-free',
    keyEnv: 'OPENCODE_API_KEY',
  },
  deepseek: {
    defaultModel: 'deepseek/deepseek-v4-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  openai: {
    defaultModel: 'openai/gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    defaultModel: 'anthropic/claude-sonnet-4-20250514',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  openrouter: {
    defaultModel: 'openrouter/openai/gpt-4o-mini',
    keyEnv: 'OPENROUTER_API_KEY',
  },
};
