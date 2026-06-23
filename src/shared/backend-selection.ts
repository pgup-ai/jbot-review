import { COMMANDCODE_PROVIDER_ID, isCommandCodeProvider } from './commandcode.ts';
import { DEVIN_PROVIDER_ID, isDevinProvider } from './devin.ts';

export type CliBackendID = typeof DEVIN_PROVIDER_ID | typeof COMMANDCODE_PROVIDER_ID;

export interface ReviewBackendSelectionInput {
  providerID: string;
  modelID: string;
  apiKey: string;
  auxProviderID: string;
  auxModelID: string;
  auxApiKey: string;
}

export interface ReviewBackendSelection {
  mainCliBackend?: CliBackendID;
  auxCliBackend?: CliBackendID;
  needsOpencode: boolean;
  devinApiKey: string;
  commandCodeAccessKey: string;
  opencodeProviderID: string;
  opencodeModelID: string;
  opencodeApiKey: string;
}

export function selectReviewBackends(input: ReviewBackendSelectionInput): ReviewBackendSelection {
  const mainCliBackend = cliBackendForProvider(input.providerID);
  const auxCliBackend = cliBackendForProvider(input.auxProviderID);
  return {
    ...(mainCliBackend ? { mainCliBackend } : {}),
    ...(auxCliBackend ? { auxCliBackend } : {}),
    needsOpencode: !mainCliBackend || !auxCliBackend,
    devinApiKey:
      mainCliBackend === DEVIN_PROVIDER_ID
        ? input.apiKey
        : auxCliBackend === DEVIN_PROVIDER_ID
          ? input.auxApiKey
          : '',
    commandCodeAccessKey:
      mainCliBackend === COMMANDCODE_PROVIDER_ID
        ? input.apiKey
        : auxCliBackend === COMMANDCODE_PROVIDER_ID
          ? input.auxApiKey
          : '',
    opencodeProviderID: mainCliBackend ? input.auxProviderID : input.providerID,
    opencodeModelID: mainCliBackend ? input.auxModelID : input.modelID,
    opencodeApiKey: mainCliBackend ? input.auxApiKey : input.apiKey,
  };
}

function cliBackendForProvider(providerID: string): CliBackendID | undefined {
  if (isDevinProvider(providerID)) return DEVIN_PROVIDER_ID;
  if (isCommandCodeProvider(providerID)) return COMMANDCODE_PROVIDER_ID;
  return undefined;
}
