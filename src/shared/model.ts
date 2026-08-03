import { createHash } from 'node:crypto';

import { providerConfig } from './config.ts';

interface ParsedModel {
  providerID: string;
  modelID: string;
}

const DEFAULT_PROVIDER_ID = 'opencode';

interface ProviderResolution {
  /** Legacy provider input. Pins every ref, absorbing one matching prefix. */
  pinned?: string;
  /** Provider for a ref that carries no provider segment. */
  fallback: string;
}

/**
 * A model ref is `<routing provider>/<provider-specific model id>`. Only the
 * first segment routes; the rest is opaque and may hold more slashes, so
 * `kilo/zai/glm-5.2` and `devin/glm-5.2` stay distinct routes to what may be
 * the same underlying model.
 */
function parseModelRef(model: string, { pinned, fallback }: ProviderResolution): ParsedModel {
  const trimmed = model.trim();
  // resolveModelSelection splits before it gets here, so a comma at this point
  // is a pool handed to a single-model input — aux-model being the likely one.
  if (trimmed.includes(',')) {
    throw new Error(`Invalid model "${model}"; expected one model id, not a list.`);
  }

  const slash = trimmed.indexOf('/');
  const parsed = pinned
    ? {
        providerID: pinned,
        modelID: trimmed.startsWith(`${pinned}/`) ? trimmed.slice(pinned.length + 1) : trimmed,
      }
    : slash < 0
      ? { providerID: fallback, modelID: trimmed }
      : { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
  if (!parsed.providerID || !parsed.modelID) {
    throw new Error(`Invalid model "${model}"; expected a non-empty model id.`);
  }
  return parsed;
}

interface ModelSelection {
  providerID: string;
  /** Canonical `provider/model` candidates; one is picked per run. */
  pool: string[];
}

/**
 * Resolves the main review pool and the provider serving it. `pinnedProviderID`
 * is the legacy provider input: when set it pins every candidate, otherwise the
 * provider comes from the refs, which must therefore agree on one. Every
 * candidate is resolved up front so a typo in a pool fails the next run
 * outright instead of only the runs that happen to pick it.
 */
export function resolveModelSelection(models?: string, pinnedProviderID?: string): ModelSelection {
  const pinned = pinnedProviderID?.trim();
  const input = models?.trim() || defaultModelOf(pinned || DEFAULT_PROVIDER_ID);

  const pool = input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseModelRef(entry, { pinned, fallback: DEFAULT_PROVIDER_ID }));
  if (!pool.length) throw new Error(`Invalid model "${input}"; expected at least one model.`);

  const [first] = pool;
  const mixed = pool.find((entry) => entry.providerID !== first.providerID);
  if (mixed) {
    throw new Error(
      `Model pool mixes providers "${first.providerID}" and "${mixed.providerID}"; ` +
        'every pooled model must name the same provider.',
    );
  }
  // A pinned provider was named outright, so only a derived one cites its model.
  providerConfig(first.providerID, pinned ? undefined : formatModelName(first));

  return { providerID: first.providerID, pool: pool.map(formatModelName) };
}

function defaultModelOf(providerID: string): string {
  const { defaultModel } = providerConfig(providerID);
  if (!defaultModel) {
    throw new Error(
      `Missing model for provider "${providerID}". Pass model/JBOT_REVIEW_MODEL (MODEL outside the Action).`,
    );
  }
  return defaultModel;
}

/**
 * Seeded, not random: re-reviewing the same commit has to reproduce. The seed is
 * hashed rather than read as a number so callers can pass any stable string.
 */
export function pickPooledModel(pool: string[], seed: string): string {
  return pool[createHash('sha256').update(seed).digest().readUInt32BE(0) % pool.length];
}

/**
 * Resolves the auxiliary model. `pinnedProviderID` is the legacy aux-provider
 * input; without one an unqualified ref stays on the main provider and a
 * qualified one names its own. An absent aux model reports the main provider,
 * so callers can compare the two to decide whether separate credentials apply.
 */
export function resolveAuxModel(
  auxModel: string | undefined,
  mainProviderID: string,
  pinnedProviderID?: string,
): { model: string; providerID: string } {
  const input = auxModel?.trim();
  if (!input) return { model: '', providerID: mainProviderID };
  const pinned = pinnedProviderID?.trim();

  const parsed = parseModelRef(input, { pinned, fallback: mainProviderID });
  const model = formatModelName(parsed);
  providerConfig(parsed.providerID, pinned ? undefined : model);
  return { model, providerID: parsed.providerID };
}

function formatModelName(model: ParsedModel): string {
  return `${model.providerID}/${model.modelID}`;
}
