import { join } from 'node:path';

import { parseModelName } from './model.ts';
import { NO_TOOLS_REVIEW_DIRECTIVE } from './prompt.ts';

export const KILO_PROVIDER_ID = 'kilo';
export const KILO_CLI_BIN = 'kilo';
/** Kilo's hardcoded free smart-router; the CI default. Gateway-prefixed (see buildKiloCliArgs). */
export const KILO_GATEWAY_FREE_MODEL = 'kilo-auto/free';

export function isKiloProvider(providerID: string): boolean {
  return providerID === KILO_PROVIDER_ID;
}

/**
 * Static `kilo run` argv. Read-only is enforced here (invariant #8): `--agent plan`
 * denies edit/write/terminal headless (POC: a write tool is auto-denied, no hang), and
 * the bypass flags (`--auto`, `--dangerously-skip-permissions`) are never emitted.
 * `--format json` yields the NDJSON we parse. The prompt goes on stdin (runKiloPrompt).
 *
 * Model mapping: jbot's provider id (`kilo`) is also Kilo's gateway provider id, so
 * parseModelName strips the leading `kilo/`; we re-add it so `--model` stays
 * gateway-qualified (`kilo/kilo-auto/free`) — the bare form 404s (POC). `default` maps
 * to the free smart-router.
 */
export function buildKiloCliArgs(input: { model: string }): string[] {
  const { modelID } = parseModelName(input.model);
  const model = modelID === 'default' ? KILO_GATEWAY_FREE_MODEL : modelID;
  return ['run', '--format', 'json', '--agent', 'plan', '--model', `${KILO_PROVIDER_ID}/${model}`];
}

/** Prompt input: the no-tools directive (a denied tool under `--agent plan` yields empty
 * text — POC) prepended so the model reviews the embedded context instead of stalling. */
export function buildKiloPromptInput(prompt: string): string {
  return `${NO_TOOLS_REVIEW_DIRECTIVE}\n\n${prompt}`;
}

// Provider api-key envs Kilo could read above the injected KILO_AUTH_CONTENT; stripped so
// an ambient key can't silently redirect provider/billing (Kilo is multi-provider).
export const KILO_STRIPPED_ENV_KEYS = [
  'KILO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
] as const;

/**
 * Validates the `KILO_AUTH_CONTENT` secret — the contents of
 * `~/.local/share/kilo/auth.json` — is present and JSON, returning the trimmed content.
 * Throws a clear error so a bad secret fails fast at startup.
 */
export function assertValidKiloAuth(auth: string): string {
  const content = auth.trim();
  if (!content) {
    throw new Error('Missing Kilo auth. Set kilo-auth or KILO_AUTH_CONTENT.');
  }
  try {
    JSON.parse(content);
  } catch {
    throw new Error(
      'Invalid KILO_AUTH_CONTENT: expected the JSON contents of ~/.local/share/kilo/auth.json.',
    );
  }
  return content;
}

/**
 * Child env carrying the Kilo credential via `KILO_AUTH_CONTENT` (env-injected, no file
 * written). `HOME`/`XDG_DATA_HOME` point at a per-process temp dir so concurrent
 * sessions don't race kilo's SQLite data dir (every invocation opens/migrates
 * ~/.local/share/kilo/kilo.db) or any token-refresh writeback. Ambient provider api-key
 * envs are stripped so the carried auth wins.
 */
export function kiloEnvForAuth(auth: string, home: string): NodeJS.ProcessEnv {
  const content = assertValidKiloAuth(auth);
  const h = home?.trim();
  if (!h) {
    throw new Error('Missing Kilo home. A temp HOME is required for the kilo data dir.');
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KILO_AUTH_CONTENT: content,
    HOME: h,
    XDG_DATA_HOME: join(h, '.local/share'),
  };
  for (const key of KILO_STRIPPED_ENV_KEYS) delete env[key];
  return env;
}
