import { PROVIDERS, supportedModelOptions } from './config.ts';
import { BASH_PERMISSIONS, CLI_ENV_ALLOWLIST } from './shell-policy.ts';

/** Built-in read-only agent for review turns. */
export const MAIN_AGENT = 'plan';
/** Opt-in (JBOT_REVIEWER_AGENT=1): plan's policy with a review system prompt instead of the coding-agent one. */
export const REVIEWER_AGENT = 'jbot-reviewer';
/** jbot agents whose deny-all ruleset hides every tool; the plugin strips them too. */
export const WRAPUP_AGENT = 'jbot-wrapup';
export const PLAIN_AGENT = 'jbot-plain';
/** A tool-less turn is one completion: no wrap-up reserve, no finalize trigger. */
export const TOOL_LESS_AGENTS: ReadonlySet<string> = new Set([WRAPUP_AGENT, PLAIN_AGENT]);

export interface PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/**
 * V1 bash globs as ordered V2 rules (last match wins, so the catch-all leads),
 * plus the denies V1 expressed elsewhere: edits (covers write/patch), reads
 * outside the workspace, and `question`, which would wait for an interactive
 * form nothing in CI can answer.
 */
export function permissionRules(): PermissionRule[] {
  const { '*': catchAll, ...denies } = BASH_PERMISSIONS;
  return [
    { action: 'shell', resource: '*', effect: catchAll },
    ...Object.entries(denies).map(([resource, effect]) => ({ action: 'shell', resource, effect })),
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'external_directory', resource: '*', effect: 'deny' },
    { action: 'question', resource: '*', effect: 'deny' },
  ];
}

export interface ModelEntry {
  providerID: string;
  modelID: string;
  apiKey: string;
  baseURL?: string;
  promptCache: boolean;
  modelOptions?: Record<string, unknown>;
  verificationModelOptions?: Record<string, unknown>;
}

export interface ProviderKeyConfig {
  providerID: string;
  apiKey: string;
}

/**
 * Env var the V2 server reads for a catalog provider's key (its "env" auth
 * method). Config-carried keys do not activate built-in providers (measured
 * 2026-09-16); these names come from the provider `env` field of V2's
 * embedded models.dev snapshot. A wrong name fails the run at readiness.
 */
const PROVIDER_KEY_ENV: Record<string, string> = {
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  'zai-coding-plan': 'ZHIPU_API_KEY',
  'kimi-for-coding': 'KIMI_API_KEY',
  xai: 'XAI_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_API_KEY',
  'fireworks-ai': 'FIREWORKS_API_KEY',
};

/** Server-process env vars that activate the run's catalog providers. */
export function providerKeyVariables(keys: ProviderKeyConfig[]): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const { providerID, apiKey } of keys) {
    if (PROVIDERS[providerID]?.custom) continue; // its key travels in the config entry
    const name = PROVIDER_KEY_ENV[providerID];
    if (!name) {
      throw new Error(
        `No V2 key env var known for provider "${providerID}"; add it to PROVIDER_KEY_ENV.`,
      );
    }
    if (variables[name] !== undefined && variables[name] !== apiKey) {
      throw new Error(`Providers sharing ${name} were given different keys.`);
    }
    variables[name] = apiKey;
  }
  return variables;
}

const SESSION_ENV_EXTRA = [
  'HOME',
  'USER',
  'SHELL',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
] as const;

/**
 * The env a session's shell commands see. `session.environment` REPLACES the
 * inherited server env (measured), so this is an allowlist like the CLI one:
 * provider keys and OPENCODE_CONFIG_CONTENT never reach `env` in a tool call.
 */
export function sessionEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const name of [...CLI_ENV_ALLOWLIST, ...SESSION_ENV_EXTRA]) {
    const value = env[name];
    if (value !== undefined) variables[name] = value;
  }
  return variables;
}

export type OptionTier = 'main' | 'verify';
export type ModelOptionsByModel = Record<
  string,
  Partial<Record<OptionTier, Record<string, unknown>>>
>;

function nonEmpty(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return options && Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Provider options per `provider/model` and tier. V2 ignores config model
 * overrides on catalog providers (measured), so the jbot plugin applies these
 * per session through its `context` hook instead — V1's per-model options,
 * one mechanism for every provider. The verifier's tier rounds down on
 * ladders that lack it, as V1's alias entry did.
 */
export function modelOptionsByModel(models: ModelEntry[]): ModelOptionsByModel {
  const byModel: ModelOptionsByModel = {};
  for (const entry of models) {
    if (!entry.modelID) continue;
    const main = nonEmpty(
      supportedModelOptions(entry.providerID, entry.modelID, entry.modelOptions),
    );
    const verify = nonEmpty(
      supportedModelOptions(
        entry.providerID,
        entry.modelID,
        entry.verificationModelOptions,
        'down',
      ),
    );
    if (!main && !verify) continue;
    byModel[`${entry.providerID}/${entry.modelID}`] = {
      ...(main ? { main } : {}),
      ...(verify ? { verify } : {}),
    };
  }
  return byModel;
}

/** Options for one session: the verify tier when it was configured, else the model's own. */
export function sessionModelOptions(
  byModel: ModelOptionsByModel,
  model: string,
  tier: OptionTier,
): Record<string, unknown> | undefined {
  const entry = byModel[model];
  return (tier === 'verify' ? entry?.verify : undefined) ?? entry?.main;
}

export interface OpencodeConfigInput {
  /** Root model first, then auxiliary entries. */
  models: ModelEntry[];
  /** System prompt of the opt-in reviewer agent (REVIEWER_SYSTEM_PROMPT). */
  reviewerSystem: string;
}

type ProviderEntry = {
  settings?: Record<string, unknown>;
  models?: Record<string, Record<string, unknown>>;
} & Record<string, unknown>;

function mergeProvider(providers: Record<string, ProviderEntry>, entry: ModelEntry): void {
  const custom = PROVIDERS[entry.providerID]?.custom;
  const existing = providers[entry.providerID];
  // `setCacheKey` is V1's promptCacheKey toggle; spike S3 confirms the V2 key name.
  const settings = entry.promptCache ? { setCacheKey: true } : {};
  if (custom) {
    if (!entry.baseURL) {
      throw new Error(`Missing base URL for custom provider "${entry.providerID}".`);
    }
    if (!entry.modelID) throw new Error(`Missing model for custom provider "${entry.providerID}".`);
    providers[entry.providerID] = {
      name: custom.name,
      package: '@opencode/ai/providers/openai-compatible',
      settings: {
        ...existing?.settings,
        ...settings,
        baseURL: entry.baseURL,
        apiKey: entry.apiKey,
      },
      models: {
        ...existing?.models,
        [entry.modelID]: {
          name: entry.modelID,
          modelID: entry.modelID,
          capabilities: { tools: true, input: ['text'], output: ['text'] },
          // Conservative: V2 compacts by context limit; an undeclared custom model gets these.
          limit: { context: 200_000, output: 32_000 },
        },
      },
    };
    return;
  }
  if (Object.keys(settings).length === 0) return;
  providers[entry.providerID] = { ...existing, settings: { ...existing?.settings, ...settings } };
}

/** Native V2 config for OPENCODE_CONFIG_CONTENT. Pure; exported for tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildConfig(input: OpencodeConfigInput): Record<string, any> {
  const providers: Record<string, ProviderEntry> = {};
  for (const entry of input.models) mergeProvider(providers, entry);
  const denyAll = [{ action: '*', resource: '*', effect: 'deny' }];
  return {
    $schema: 'https://opencode.ai/config.json',
    permissions: permissionRules(),
    agents: {
      [REVIEWER_AGENT]: {
        mode: 'primary',
        description: 'jbot-review: read-only reviewer',
        system: input.reviewerSystem,
      },
      [WRAPUP_AGENT]: {
        mode: 'primary',
        description: 'jbot-review: final answer, tools off',
        permissions: denyAll,
      },
      [PLAIN_AGENT]: {
        mode: 'primary',
        description: 'jbot-review: single-shot model, tools off',
        permissions: denyAll,
      },
    },
    ...(Object.keys(providers).length ? { providers } : {}),
  };
}
