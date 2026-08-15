/**
 * Routing policy for reviews served by a remote companion through the ACP
 * gateway. `@symma/client` owns the transport; the decisions stay here.
 * Spec: docs/superpowers/specs/2026-07-24-acp-gateway-m2-design.md.
 */
import { checkEndpointReady, runRemotePrompt, type RemoteAcpConfig } from '@symma/client';
import { parseModelName } from '@symma/protocol';

import { createAcpReviewBackend } from './acp.ts';
import type { ReviewBackend } from './session-concurrency.ts';

/** Run ids become directory names in the journal, so they are clamped here. */
const RUN_ID_MAX_LENGTH = 128;

/**
 * Run id for a local review. CI takes one from the workflow run and attempt;
 * locally there is none, and without one every local review falls through to
 * the `jbot` fallback below and piles into a single entry. The timestamp is
 * what separates attempts, so a long branch gives up characters rather than
 * letting the clamp above eat the suffix.
 */
export function localRunId(branch: string, when: Date): string {
  // Milliseconds kept: two attempts a second apart are ordinary, and dropping
  // them would merge exactly the runs this id exists to separate.
  const stamp = when
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/Z$/, '')
    .replace('T', '-')
    .replace('.', '-');
  const room = RUN_ID_MAX_LENGTH - `local--${stamp}`.length;
  return `local-${branch.slice(0, room)}-${stamp}`;
}

/** Providers the gateway can serve — the ones with an ACP engine (see acp.ts). */
export const ACP_GATEWAY_PROVIDERS = ['devin', 'cursor', 'codex', 'kilo'] as const;

/**
 * Whether any of these models would reach a companion. Gateway *routing*, not
 * merely gateway config, is what forces local mode onto the committed ref — a
 * run configured with gateway vars but pointed elsewhere stays local and must
 * keep reviewing the working tree.
 */
export function gatewayRoutedModels(models: (string | undefined)[]): boolean {
  return models.some(
    (name) =>
      name &&
      (ACP_GATEWAY_PROVIDERS as readonly string[]).includes(parseModelName(name).providerID),
  );
}

/** The gateway URL opts into remote ACP routing; its credentials are then required. */
export function remoteAcpConfigFromEnv(): Omit<RemoteAcpConfig, 'agent'> | undefined {
  const gateway = process.env.JBOT_ACP_GATEWAY_URL?.trim();
  if (!gateway) return undefined;
  const token = process.env.JBOT_ACP_GATEWAY_TOKEN?.trim();
  const endpoint = process.env.JBOT_ACP_GATEWAY_ENDPOINT?.trim();
  if (!token || !endpoint) {
    const missing = [
      !token && 'JBOT_ACP_GATEWAY_TOKEN',
      !endpoint && 'JBOT_ACP_GATEWAY_ENDPOINT',
    ].filter(Boolean);
    throw new Error(`JBOT_ACP_GATEWAY_URL enables ACP routing; also set ${missing.join(' and ')}.`);
  }
  const rawRun =
    process.env.JBOT_ACP_GATEWAY_RUN?.trim() || process.env.JBOT_OBSERVER_RUN?.trim() || 'jbot';
  return {
    gateway: gateway.replace(/\/+$/, ''),
    token,
    endpoint,
    // Must satisfy the gateway's isSafeId: alphanumeric first character.
    runId:
      rawRun
        .replaceAll(/[^A-Za-z0-9._-]/g, '-')
        .replace(/^[^A-Za-z0-9]+/, '')
        .slice(0, RUN_ID_MAX_LENGTH) || 'jbot',
    ...(process.env.JBOT_ACP_GATEWAY_REPO?.trim()
      ? { repo: process.env.JBOT_ACP_GATEWAY_REPO.trim() }
      : {}),
    ...(process.env.JBOT_ACP_GATEWAY_REF?.trim()
      ? { ref: process.env.JBOT_ACP_GATEWAY_REF.trim() }
      : {}),
    ...(process.env.JBOT_ACP_GATEWAY_BASE?.trim()
      ? { base: process.env.JBOT_ACP_GATEWAY_BASE.trim() }
      : {}),
  };
}

/** Preflight, with the variables to go fix. `@symma/client` serves any caller
 * and cannot name ours, so the mapping's owner re-attaches it. */
export async function checkGatewayEndpointReady(
  config: Omit<RemoteAcpConfig, 'agent'>,
  agent: string,
): Promise<{ freeSessions: number }> {
  try {
    return await checkEndpointReady(config, agent);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Gateway config comes from ` +
        `JBOT_ACP_GATEWAY_URL, JBOT_ACP_GATEWAY_TOKEN and JBOT_ACP_GATEWAY_ENDPOINT.`,
    );
  }
}

export async function checkAuxGatewayEndpointReady(
  config: Omit<RemoteAcpConfig, 'agent'>,
  agent: string,
): Promise<{ freeSessions: number } | { error: unknown }> {
  try {
    return await checkGatewayEndpointReady(config, agent);
  } catch (error) {
    return { error };
  }
}

// No tee on a relayed session: the companion signs and journals it itself, so
// teeing here would duplicate every frame unsigned. Journaling it twice is a
// bug this repo already shipped once.
export function createRemoteAcpBackend(config: RemoteAcpConfig): ReviewBackend {
  return createAcpReviewBackend(`acp-gateway:${config.agent}@${config.endpoint}`, (...args) =>
    runRemotePrompt(config, ...args),
  );
}
