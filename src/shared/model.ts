import { createHash } from 'node:crypto';

import { type ParsedModel, parseModelName } from '@symma/protocol';

import { providerConfig } from './config.ts';

const DEFAULT_PROVIDER_ID = 'opencode';

interface ProviderResolution {
  /** Legacy provider input. Pins every ref, absorbing one matching prefix. */
  pinned?: string;
  /** Provider for a ref that carries no provider segment. */
  fallback: string;
  /** Input this came from, so an error points at the field to fix. */
  label: 'model';
}

/**
 * A model ref is `<routing provider>/<provider-specific model id>`. Only the
 * first segment routes; the rest is opaque and may hold more slashes, so
 * `kilo/zai/glm-5.2` and `devin/glm-5.2` stay distinct routes to what may be
 * the same underlying model.
 */
function parseModelRef(
  model: string,
  { pinned, fallback, label }: ProviderResolution,
): ParsedModel {
  const trimmed = model.trim();
  // Ahead of the split: a pinned provider would otherwise absorb a leading
  // slash into the model id as `provider//id` instead of rejecting it.
  if (!trimmed || trimmed.startsWith('/')) {
    throw new Error(`Invalid ${label} "${model}"; expected a non-empty model id.`);
  }

  if (pinned) {
    const modelID = trimmed.startsWith(`${pinned}/`) ? trimmed.slice(pinned.length + 1) : trimmed;
    if (!modelID) throw new Error(`Invalid ${label} "${model}"; expected a non-empty model id.`);
    return { providerID: pinned, modelID };
  }
  // Derived refs go through the protocol parser, so this boundary and every
  // downstream consumer of the ref share one grammar.
  return trimmed.includes('/')
    ? parseModelName(trimmed)
    : { providerID: fallback, modelID: trimmed };
}

/**
 * Every candidate is resolved up front so a typo fails the next run outright
 * instead of only the runs that happen to pick it. Candidates may name
 * different providers — only one runs per PR, and each provider's credential
 * is resolved separately (see resolvePoolCredentials).
 */
function resolveSelection(input: string, resolution: ProviderResolution): string[] {
  const { pinned, label } = resolution;
  const pool = input
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => parseModelRef(entry, resolution));
  if (!pool.length) throw new Error(`Invalid ${label} "${input}"; expected at least one model.`);

  for (const entry of pool) {
    // A pinned provider was named outright, so only a derived one cites its model.
    providerConfig(entry.providerID, pinned ? undefined : formatModelName(entry));
  }
  return pool.map(formatModelName);
}

/**
 * Resolves the main review pool. `pinnedProviderID` is the legacy provider
 * input: when set it pins every candidate, otherwise each candidate's own
 * first segment selects its provider.
 */
export function resolveModelSelection(models?: string, pinnedProviderID?: string): string[] {
  const pinned = pinnedProviderID?.trim();
  const input = models?.trim() || defaultModelOf(pinned || DEFAULT_PROVIDER_ID);
  return resolveSelection(input, { pinned, fallback: DEFAULT_PROVIDER_ID, label: 'model' });
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

/** Stable first picks spread load; reruns advance past a failing candidate. */
export function pickPooledModel(pool: string[], seed: string, attempt = 1): string {
  const first = createHash('sha256').update(seed).digest().readUInt32BE(0) % pool.length;
  return pool[(first + attempt - 1) % pool.length];
}

/**
 * Salted so the aux pick is not index-locked to the main one: on the raw seed,
 * both roles would always draw the same entry.
 */
export function pickAuxModel(pool: string[], seed: string): string {
  return pool.length ? pickPooledModel(pool, `aux:${seed}`) : '';
}

/** `aux-model`/`aux-provider` are gone; a config still setting them changed behavior. */
export function removedAuxInputWarnings(read: (input: string, env: string) => string): string[] {
  return [
    ['aux-model', 'JBOT_REVIEW_AUX_MODEL'],
    ['aux-provider', 'JBOT_AUX_PROVIDER'],
  ].flatMap(([input, env]) =>
    read(input, env)
      ? [`\`${input}\` was removed and is ignored: both roles draw from \`model\`.`]
      : [],
  );
}

/**
 * Both review roles draw from one pool. A single-entry pool necessarily lands
 * them on the same model, which is what makes the aux session share the main
 * options entry and its effort rather than the low aux default.
 */
export function pickReviewModels(
  pool: string[],
  seed: string,
  attempt = 1,
): { model: string; auxModel: string } {
  return { model: pickPooledModel(pool, seed, attempt), auxModel: pickAuxModel(pool, seed) };
}

function formatModelName(model: ParsedModel): string {
  return `${model.providerID}/${model.modelID}`;
}
