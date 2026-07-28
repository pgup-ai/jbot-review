/**
 * Routing policy for reviews served by a remote companion through the ACP
 * gateway. The transport itself is `@symma/client`; what stays here is which
 * providers the gateway serves, how this run is named and how its config is
 * read from the environment.
 * Spec: docs/superpowers/specs/2026-07-24-acp-gateway-m2-design.md.
 */
import { runRemotePrompt, type RemoteAcpConfig } from '@symma/client';
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

/** Present only when all three required vars are set; the agent comes from the
 * selected provider, so no separate agent var. */
export function remoteAcpConfigFromEnv(): Omit<RemoteAcpConfig, 'agent'> | undefined {
  const gateway = process.env.JBOT_ACP_GATEWAY_URL?.trim();
  const token = process.env.JBOT_ACP_GATEWAY_TOKEN?.trim();
  const endpoint = process.env.JBOT_ACP_GATEWAY_ENDPOINT?.trim();
  if (!gateway || !token || !endpoint) return undefined;
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

export function createRemoteAcpBackend(config: RemoteAcpConfig): ReviewBackend {
  return createAcpReviewBackend(`acp-gateway:${config.agent}@${config.endpoint}`, (...args) =>
    runRemotePrompt(config, ...args),
  );
}
