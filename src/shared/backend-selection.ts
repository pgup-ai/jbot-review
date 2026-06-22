import { isDevinProvider } from './devin.ts';

export interface ReviewBackendSelectionInput {
  providerID: string;
  modelID: string;
  apiKey: string;
  auxProviderID: string;
  auxModelID: string;
  auxApiKey: string;
}

export interface ReviewBackendSelection {
  mainUsesDevin: boolean;
  auxUsesDevin: boolean;
  needsOpencode: boolean;
  devinApiKey: string;
  opencodeProviderID: string;
  opencodeModelID: string;
  opencodeApiKey: string;
}

export function selectReviewBackends(input: ReviewBackendSelectionInput): ReviewBackendSelection {
  const mainUsesDevin = isDevinProvider(input.providerID);
  const auxUsesDevin = isDevinProvider(input.auxProviderID);
  return {
    mainUsesDevin,
    auxUsesDevin,
    needsOpencode: !mainUsesDevin || !auxUsesDevin,
    devinApiKey: mainUsesDevin ? input.apiKey : input.auxApiKey,
    opencodeProviderID: mainUsesDevin ? input.auxProviderID : input.providerID,
    opencodeModelID: mainUsesDevin ? input.auxModelID : input.modelID,
    opencodeApiKey: mainUsesDevin ? input.auxApiKey : input.apiKey,
  };
}
