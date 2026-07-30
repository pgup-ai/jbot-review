import { createHash } from 'node:crypto';

export interface ParsedModel {
  providerID: string;
  modelID: string;
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
  // resolveModelPool splits before it gets here, so a comma at this point is a
  // pool handed to a single-model input — aux-model being the likely one.
  if (trimmedModel.includes(',')) {
    throw new Error(`Invalid model "${model}"; expected one model id, not a list.`);
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

/**
 * Resolves every candidate up front so a typo in a pool fails the next run
 * outright instead of only the runs that happen to pick it.
 */
export function resolveModelPool(providerID: string, models: string): string[] {
  const pool = models
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => formatModelName(resolveModelName(providerID, entry)));
  if (!pool.length) {
    throw new Error(`Invalid model "${models}"; expected at least one model.`);
  }
  return pool;
}

/**
 * Seeded, not random: re-reviewing the same commit has to reproduce. The seed is
 * hashed rather than read as a number so callers can pass any stable string.
 */
export function pickPooledModel(pool: string[], seed: string): string {
  return pool[createHash('sha256').update(seed).digest().readUInt32BE(0) % pool.length];
}

export function resolveAuxModelName(
  defaultProviderID: string,
  auxModel?: string,
  auxProvider?: string,
): string {
  const input = auxModel?.trim();
  if (!input) return '';
  const providerID = auxProvider?.trim() || defaultProviderID;
  return formatModelName(resolveModelName(providerID, input));
}

export function formatModelName(model: ParsedModel): string {
  return `${model.providerID}/${model.modelID}`;
}
