export interface ParsedModel {
  providerID: string;
  modelID: string;
}

export function parseModelName(model: string): ParsedModel {
  const [providerID, ...rest] = model.trim().split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) {
    throw new Error(`Invalid model "${model}"; expected "provider/model".`);
  }
  return { providerID, modelID };
}

export function resolveModelName(providerID: string, model: string): ParsedModel {
  const trimmedProviderID = providerID.trim();
  const trimmedModel = model.trim();
  if (!trimmedProviderID) {
    throw new Error('Invalid provider; expected a non-empty provider id.');
  }
  if (!trimmedModel || trimmedModel.startsWith('/')) {
    throw new Error(`Invalid model "${model}"; expected a non-empty model id.`);
  }

  const providerPrefix = `${trimmedProviderID}/`;
  const modelID = trimmedModel.startsWith(providerPrefix)
    ? trimmedModel.slice(providerPrefix.length)
    : trimmedModel;
  if (!modelID) {
    throw new Error(`Invalid model "${model}"; expected a non-empty model id.`);
  }

  return {
    providerID: trimmedProviderID,
    modelID,
  };
}

export function formatModelName(model: ParsedModel): string {
  return `${model.providerID}/${model.modelID}`;
}
