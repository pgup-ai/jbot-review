import { parseModelName } from '@symma/protocol';

import { CLINE_PROVIDER_ID, isClineProvider } from './cline.ts';
import { DIM_PROVIDER_ID, isDimProvider } from './dim.ts';
import { CODEX_PROVIDER_ID, isCodexProvider } from '@symma/protocol';
import { COMMANDCODE_PROVIDER_ID, isCommandCodeProvider } from './commandcode.ts';
import {
  CURSOR_PROVIDER_ID,
  DEVIN_PROVIDER_ID,
  isCursorProvider,
  isDevinProvider,
} from '@symma/protocol';
import { GROK_PROVIDER_ID, isGrokProvider } from './grok.ts';
import { KILO_PROVIDER_ID, isKiloProvider } from '@symma/protocol';
import { piSupportsProvider } from './pi.ts';
import { isPoolsideProvider } from './poolside.ts';
import { QODER_PROVIDER_ID, isQoderProvider } from './qoder.ts';

export type CliBackendID =
  | typeof DEVIN_PROVIDER_ID
  | typeof COMMANDCODE_PROVIDER_ID
  | typeof CURSOR_PROVIDER_ID
  | typeof CODEX_PROVIDER_ID
  | typeof CLINE_PROVIDER_ID
  | typeof GROK_PROVIDER_ID
  | typeof KILO_PROVIDER_ID
  | typeof QODER_PROVIDER_ID
  | typeof DIM_PROVIDER_ID;

export interface ReviewBackendSelectionInput {
  providerID: string;
  modelID: string;
  apiKey: string;
  auxProviderID: string;
  auxModelID: string;
  auxApiKey: string;
  /** Whether the pi engine may be used at all (see resolvePiEngine). */
  piEnabled?: boolean;
  /** Per-role catalog checks; false routes that role through opencode. */
  mainPiModelAvailable?: boolean;
  auxPiModelAvailable?: boolean;
}

export interface PiEngineConfig {
  providerID: string;
  modelID: string;
  apiKey: string;
}

export function backendRequiresCompleteEmbeddedDiff(
  providerID: string,
  cliBackend: CliBackendID | undefined,
): boolean {
  return (
    isPoolsideProvider(providerID) ||
    cliBackend === COMMANDCODE_PROVIDER_ID ||
    cliBackend === GROK_PROVIDER_ID ||
    cliBackend === QODER_PROVIDER_ID
  );
}

export interface ReviewBackendSelection {
  mainCliBackend?: CliBackendID;
  auxCliBackend?: CliBackendID;
  /** Present only when the role bypasses the OpenCode server. */
  mainSdkEngine?: 'pi' | 'poolside';
  auxSdkEngine?: 'pi' | 'poolside';
  needsOpencode: boolean;
  devinApiKey: string;
  commandCodeAccessKey: string;
  cursorApiKey: string;
  codexAuth: string;
  clineAuth: string;
  grokAuth: string;
  kiloAuth: string;
  dimAuth: string;
  qoderToken?: string;
  opencodeProviderID: string;
  opencodeModelID: string;
  opencodeApiKey: string;
  /** pi engine init config (main role wins), present only when needsPi. */
  pi?: PiEngineConfig;
}

export function selectReviewBackends(input: ReviewBackendSelectionInput): ReviewBackendSelection {
  const mainCliBackend = cliBackendForProvider(input.providerID);
  const auxCliBackend = cliBackendForProvider(input.auxProviderID);
  const mainPoolside = !mainCliBackend && isPoolsideProvider(input.providerID);
  const auxPoolside = !auxCliBackend && isPoolsideProvider(input.auxProviderID);
  const mainPi =
    !mainCliBackend &&
    !mainPoolside &&
    !!input.piEnabled &&
    input.mainPiModelAvailable !== false &&
    piSupportsProvider(input.providerID);
  const auxPi =
    !auxCliBackend &&
    !auxPoolside &&
    !!input.piEnabled &&
    input.auxPiModelAvailable !== false &&
    piSupportsProvider(input.auxProviderID);
  const mainOpencode = !mainCliBackend && !mainPi && !mainPoolside;
  const auxOpencode = !auxCliBackend && !auxPi && !auxPoolside;
  const needsOpencode = mainOpencode || auxOpencode;
  const needsPi = mainPi || auxPi;
  const effectiveAuxApiKey =
    input.auxApiKey || (input.auxProviderID === input.providerID ? input.apiKey : '');
  const opencodeApiKey = mainOpencode
    ? input.apiKey
    : input.auxApiKey ||
      (needsOpencode && input.auxProviderID === input.providerID ? input.apiKey : '');
  // A CLI backend's key is whichever role selected it: main wins, else aux,
  // else empty. One closure keeps that rule in a single place as backends grow.
  const keyFor = (backendID: CliBackendID): string => {
    if (mainCliBackend === backendID) return input.apiKey;
    if (auxCliBackend === backendID) return input.auxApiKey;
    return '';
  };
  return {
    ...(mainCliBackend ? { mainCliBackend } : {}),
    ...(auxCliBackend ? { auxCliBackend } : {}),
    ...(mainPoolside
      ? { mainSdkEngine: 'poolside' as const }
      : mainPi
        ? { mainSdkEngine: 'pi' as const }
        : {}),
    ...(auxPoolside
      ? { auxSdkEngine: 'poolside' as const }
      : auxPi
        ? { auxSdkEngine: 'pi' as const }
        : {}),
    needsOpencode,
    devinApiKey: keyFor(DEVIN_PROVIDER_ID),
    commandCodeAccessKey: keyFor(COMMANDCODE_PROVIDER_ID),
    cursorApiKey: keyFor(CURSOR_PROVIDER_ID),
    codexAuth: keyFor(CODEX_PROVIDER_ID),
    clineAuth: keyFor(CLINE_PROVIDER_ID),
    grokAuth: keyFor(GROK_PROVIDER_ID),
    kiloAuth: keyFor(KILO_PROVIDER_ID),
    dimAuth: keyFor(DIM_PROVIDER_ID),
    ...(mainCliBackend === QODER_PROVIDER_ID || auxCliBackend === QODER_PROVIDER_ID
      ? { qoderToken: keyFor(QODER_PROVIDER_ID) }
      : {}),
    // The opencode server boots with the config of the role it serves: main
    // when main is on opencode, else aux (a CLI or pi main defers to aux).
    opencodeProviderID: mainOpencode ? input.providerID : input.auxProviderID,
    opencodeModelID: mainOpencode ? input.modelID : input.auxModelID,
    opencodeApiKey,
    ...(needsPi
      ? {
          pi: {
            providerID: mainPi ? input.providerID : input.auxProviderID,
            modelID: mainPi ? input.modelID : input.auxModelID,
            apiKey: mainPi ? input.apiKey : effectiveAuxApiKey,
          },
        }
      : {}),
  };
}

function cliBackendForProvider(providerID: string): CliBackendID | undefined {
  if (isDevinProvider(providerID)) return DEVIN_PROVIDER_ID;
  if (isCommandCodeProvider(providerID)) return COMMANDCODE_PROVIDER_ID;
  if (isCursorProvider(providerID)) return CURSOR_PROVIDER_ID;
  if (isCodexProvider(providerID)) return CODEX_PROVIDER_ID;
  if (isClineProvider(providerID)) return CLINE_PROVIDER_ID;
  if (isGrokProvider(providerID)) return GROK_PROVIDER_ID;
  if (isKiloProvider(providerID)) return KILO_PROVIDER_ID;
  if (isQoderProvider(providerID)) return QODER_PROVIDER_ID;
  if (isDimProvider(providerID)) return DIM_PROVIDER_ID;
  return undefined;
}

/**
 * Flags candidates whose model id leads with a CLI-backend provider that a
 * pinned provider swallowed — `provider: opencode` + `model: devin/glm-5.2`
 * resolves to `opencode/devin/glm-5.2` and is sent to opencode as the model id
 * `devin/glm-5.2`, which fails only once the session reaches the endpoint.
 *
 * Reachable without a pin — an explicit `opencode/devin/glm-5.2` resolves the
 * same way — so the message states the routing and the remedy without assuming
 * a provider input exists to drop.
 *
 * Two things keep this quiet on correct configs. Only CLI-backend ids qualify:
 * they name tools, so no catalog nests models under them, whereas vendor names
 * legitimately do (OpenRouter's own default is `openrouter/openai/gpt-4o-mini`).
 * And a CLI backend's own catalog may name another tool — `devin/codex` is a
 * real model — so only a non-CLI provider swallowing one is a misconfiguration.
 */
export function swallowedProviderWarnings(pool: string[]): string[] {
  return pool.flatMap((model) => {
    const { providerID, modelID } = parseModelName(model);
    if (cliBackendForProvider(providerID)) return [];
    const slash = modelID.indexOf('/');
    const prefix = slash < 0 ? modelID : modelID.slice(0, slash);
    if (!cliBackendForProvider(prefix)) return [];
    return [
      `"${model}" sends model id "${modelID}" to provider "${providerID}", but "${prefix}" is ` +
        `itself a provider. To review on "${prefix}", name the model under it instead — and drop ` +
        `provider/aux-provider if either is set, since a pin absorbs the prefix.`,
    ];
  });
}
