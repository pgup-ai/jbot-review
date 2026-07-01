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
