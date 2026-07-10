import { CLINE_PROVIDER_ID, isClineProvider } from './cline.ts';
import { CODEX_PROVIDER_ID, isCodexProvider } from './codex.ts';
import { COMMANDCODE_PROVIDER_ID, isCommandCodeProvider } from './commandcode.ts';
import { CURSOR_PROVIDER_ID, isCursorProvider } from './cursor.ts';
import { DEVIN_PROVIDER_ID, isDevinProvider } from './devin.ts';
import { KILO_PROVIDER_ID, isKiloProvider } from './kilo.ts';
import { piSupportsProvider } from './pi.ts';

export type CliBackendID =
  | typeof DEVIN_PROVIDER_ID
  | typeof COMMANDCODE_PROVIDER_ID
  | typeof CURSOR_PROVIDER_ID
  | typeof CODEX_PROVIDER_ID
  | typeof CLINE_PROVIDER_ID
  | typeof KILO_PROVIDER_ID;

export interface ReviewBackendSelectionInput {
  providerID: string;
  modelID: string;
  apiKey: string;
  auxProviderID: string;
  auxModelID: string;
  auxApiKey: string;
  /** Whether the pi engine may be used at all (see resolvePiEngine). */
  piEnabled?: boolean;
}

export interface PiEngineConfig {
  providerID: string;
  modelID: string;
  apiKey: string;
}

export interface ReviewBackendSelection {
  mainCliBackend?: CliBackendID;
  auxCliBackend?: CliBackendID;
  /** Present only when the role routes to the pi engine. */
  mainSdkEngine?: 'pi';
  auxSdkEngine?: 'pi';
  needsOpencode: boolean;
  devinApiKey: string;
  commandCodeAccessKey: string;
  cursorApiKey: string;
  codexAuth: string;
  clineAuth: string;
  kiloAuth: string;
  opencodeProviderID: string;
  opencodeModelID: string;
  opencodeApiKey: string;
  /** pi engine init config (main role wins), present only when needsPi. */
  pi?: PiEngineConfig;
}

export function selectReviewBackends(input: ReviewBackendSelectionInput): ReviewBackendSelection {
  const mainCliBackend = cliBackendForProvider(input.providerID);
  const auxCliBackend = cliBackendForProvider(input.auxProviderID);
  const mainPi = !mainCliBackend && !!input.piEnabled && piSupportsProvider(input.providerID);
  const auxPi = !auxCliBackend && !!input.piEnabled && piSupportsProvider(input.auxProviderID);
  const mainOpencode = !mainCliBackend && !mainPi;
  const auxOpencode = !auxCliBackend && !auxPi;
  const needsPi = mainPi || auxPi;
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
    ...(mainPi ? { mainSdkEngine: 'pi' as const } : {}),
    ...(auxPi ? { auxSdkEngine: 'pi' as const } : {}),
    needsOpencode: mainOpencode || auxOpencode,
    devinApiKey: keyFor(DEVIN_PROVIDER_ID),
    commandCodeAccessKey: keyFor(COMMANDCODE_PROVIDER_ID),
    cursorApiKey: keyFor(CURSOR_PROVIDER_ID),
    codexAuth: keyFor(CODEX_PROVIDER_ID),
    clineAuth: keyFor(CLINE_PROVIDER_ID),
    kiloAuth: keyFor(KILO_PROVIDER_ID),
    // The opencode server boots with the config of the role it serves: main
    // when main is on opencode, else aux (a CLI or pi main defers to aux).
    opencodeProviderID: mainOpencode ? input.providerID : input.auxProviderID,
    opencodeModelID: mainOpencode ? input.modelID : input.auxModelID,
    opencodeApiKey: mainOpencode ? input.apiKey : input.auxApiKey,
    ...(needsPi
      ? {
          pi: {
            providerID: mainPi ? input.providerID : input.auxProviderID,
            modelID: mainPi ? input.modelID : input.auxModelID,
            apiKey: mainPi ? input.apiKey : input.auxApiKey,
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
  if (isKiloProvider(providerID)) return KILO_PROVIDER_ID;
  return undefined;
}
