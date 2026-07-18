import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { InstallationAccessTokenAuthentication } from '@octokit/auth-app';

import { createAppOctokit } from './auth.ts';
import { clonePr } from './clone.ts';
import { runPrReview } from '../shared/runner.ts';
import { defaultModelOptions } from '../shared/config.ts';
import { parseModelName, resolveAuxModelName } from '../shared/model.ts';
import { enqueue } from './queue.ts';

export interface AppConfig {
  appId: string;
  privateKey: string;
  apiKey: string;
  model: string;
  baseURL?: string;
  auxProvider?: string;
  auxApiKey?: string;
  auxBaseURL?: string;
}

// The pull_request webhook event is a union of action-specific payload types.
// Only some actions (like "opened") include an installation. We narrow with
// an "in" check before accessing the installation field.
type PullRequestEvent = EmitterWebhookEvent<'pull_request'>;

export function parseEnvJsonObject(
  name: string,
  defaultValue: Record<string, unknown>,
): Record<string, unknown> {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to default */
  }
  console.warn(`[jbot-review] Ignoring invalid JSON in ${name}; using default.`);
  return defaultValue;
}

export function parseEnvInt(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : defaultValue;
}

/**
 * Boolean env knob. Only the exact lowercased string `'false'` disables;
 * unset or anything else keeps the default-on behavior, mirroring the
 * workflow's `parseBooleanInput` "unset and 'true' both enable" semantics.
 */
export function parseEnvBoolean(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  return defaultValue;
}

export function handlePrEvent(event: PullRequestEvent, cfg: AppConfig): void {
  const { payload } = event;
  if (!payload.pull_request) return;
  if (!('installation' in payload) || !payload.installation) return;
  if (!payload.repository) return;

  const pr = payload.pull_request;
  const repoInfo = payload.repository;
  const owner = repoInfo.owner.login ?? repoInfo.owner.name;
  const repoName = repoInfo.name;
  const installationId = payload.installation.id;

  enqueue(async () => {
    let cleanup: (() => void) | undefined;
    try {
      const octokit = createAppOctokit(cfg.appId, cfg.privateKey, installationId);
      const authRes = (await octokit.auth()) as InstallationAccessTokenAuthentication;
      const cloned = clonePr({
        headCloneUrl: pr.head.repo?.clone_url ?? repoInfo.clone_url,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseCloneUrl: repoInfo.clone_url,
        baseSha: pr.base.sha,
        token: authRes.token,
      });
      cleanup = cloned.cleanup;
      const { providerID } = parseModelName(cfg.model);
      const auxModel = resolveAuxModelName(
        providerID,
        process.env.JBOT_REVIEW_AUX_MODEL,
        cfg.auxProvider,
      );
      await runPrReview({
        octokit,
        owner,
        repo: repoName,
        pullNumber: pr.number,
        pullTitle: pr.title,
        pullBody: pr.body ?? '',
        workspace: cloned.dir,
        model: cfg.model,
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        preparePatchRecovery: cloned.prepareDiff,
        // The multi-pass/verification defaults cost ~3x a single session;
        // the webhook app has no per-run inputs, so expose env knobs.
        options: {
          enhancedContext: true,
          reviewPasses: parseEnvInt('JBOT_REVIEW_PASSES', 1),
          verifyFindings: process.env.JBOT_VERIFY_FINDINGS?.trim() !== 'false',
          auxModel,
          ...(cfg.auxApiKey ? { auxApiKey: cfg.auxApiKey } : {}),
          ...(cfg.auxBaseURL ? { auxBaseURL: cfg.auxBaseURL } : {}),
          timeBudgetMinutes: parseEnvInt('JBOT_TIME_BUDGET_MINUTES', 30),
          reviewShards: parseEnvInt('JBOT_REVIEW_SHARDS', 1),
          dynamicFanout: parseEnvBoolean('JBOT_DYNAMIC_FANOUT', true),
          modelOptions: parseEnvJsonObject('JBOT_MODEL_OPTIONS', defaultModelOptions(providerID)),
          promptCache: parseEnvBoolean('JBOT_PROMPT_CACHE', true),
          skipDocOnly: parseEnvBoolean('JBOT_SKIP_DOC_ONLY', true),
          maxConcurrentSessions: parseEnvInt('JBOT_MAX_CONCURRENT_SESSIONS', 3),
          reviewTelemetry: parseEnvBoolean('JBOT_REVIEW_TELEMETRY', true),
          evidenceQuotes: parseEnvBoolean('JBOT_EVIDENCE_QUOTES', true),
        },
        log: (msg: string) => console.log(`[jbot-review] ${msg}`),
      });
    } catch (error) {
      console.error(
        `[jbot-review] Review failed for ${owner}/${repoName}#${pr.number}: ${(error as Error).message}`,
      );
    } finally {
      cleanup?.();
    }
  });
}
