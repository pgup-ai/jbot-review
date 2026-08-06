import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { InstallationAccessTokenAuthentication } from '@octokit/auth-app';

import { createAppOctokit } from './auth.ts';
import { clonePr } from './clone.ts';
import { runPrReview } from '../shared/runner.ts';
import { defaultModelOptions, type ProviderCredential } from '../shared/config.ts';
import { parseModelName } from '@symma/protocol';
import { pickAuxModel, pickPooledModel, resolveAuxModel } from '../shared/model.ts';
import { enqueue } from './queue.ts';

export interface AppConfig {
  appId: string;
  privateKey: string;
  /** Candidate models for this deployment; one is picked per PR head. */
  modelPool: string[];
  /** Raw aux-model input; resolved per PR, since a bare id follows the pick. */
  auxModelInput: string;
  /** Legacy aux-provider pin, when one is configured. */
  auxPinned?: string;
  /** Credential per provider either pool draws on, keyed by provider id. */
  credentials: Map<string, ProviderCredential>;
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
    let workspaceDir: string | undefined;
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
      workspaceDir = cloned.dir;
      const model = pickPooledModel(cfg.modelPool, pr.head.sha);
      const { providerID } = parseModelName(model);
      const { apiKey, baseURL } = cfg.credentials.get(providerID)!;
      const auxModel = pickAuxModel(
        resolveAuxModel(cfg.auxModelInput, providerID, cfg.auxPinned),
        pr.head.sha,
      );
      const auxProviderID = auxModel ? parseModelName(auxModel).providerID : providerID;
      const auxCredential =
        auxProviderID === providerID ? undefined : cfg.credentials.get(auxProviderID);
      // A run that fails before posting has no review metadata block naming the model.
      console.log(`[jbot-review] Reviewing ${owner}/${repoName}#${pr.number} with ${model}.`);
      await runPrReview({
        octokit,
        owner,
        repo: repoName,
        pullNumber: pr.number,
        pullTitle: pr.title,
        pullBody: pr.body ?? '',
        workspace: cloned.dir,
        model,
        apiKey,
        baseURL,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        preparePatchRecovery: cloned.prepareDiff,
        // The multi-pass/verification defaults cost ~3x a single session;
        // the webhook app has no per-run inputs, so expose env knobs.
        options: {
          enhancedContext: true,
          // The app runs reviews concurrently; the env scrub's spawn window
          // would race sibling runs' credential reads (see ReviewRunOptions).
          scrubSessionEnv: false,
          reviewPasses: parseEnvInt('JBOT_REVIEW_PASSES', 1),
          verifyFindings: process.env.JBOT_VERIFY_FINDINGS?.trim() !== 'false',
          auxModel,
          ...(auxCredential ? { auxApiKey: auxCredential.apiKey } : {}),
          ...(auxCredential?.baseURL ? { auxBaseURL: auxCredential.baseURL } : {}),
          timeBudgetMinutes: parseEnvInt('JBOT_TIME_BUDGET_MINUTES', 30),
          reviewShards: parseEnvInt('JBOT_REVIEW_SHARDS', 1),
          dynamicFanout: parseEnvBoolean('JBOT_DYNAMIC_FANOUT', true),
          modelOptions: parseEnvJsonObject('JBOT_MODEL_OPTIONS', defaultModelOptions(providerID)),
          promptCache: parseEnvBoolean('JBOT_PROMPT_CACHE', true),
          skipDocOnly: parseEnvBoolean('JBOT_SKIP_DOC_ONLY', true),
          maxConcurrentSessions: parseEnvInt('JBOT_MAX_CONCURRENT_SESSIONS', 3),
          reviewTelemetry: parseEnvBoolean('JBOT_REVIEW_TELEMETRY', true),
          evidenceQuotes: parseEnvBoolean('JBOT_EVIDENCE_QUOTES', true),
          // Opt-in here, unlike the Action's RUNNER_TEMP default: this host is
          // long-lived with no per-job wipe or actions/cache retention behind
          // it, so the operator picks a path they prune.
          shardCachePath: process.env.JBOT_SHARD_CACHE_DIR?.trim() ?? '',
        },
        log: (msg: string) => console.log(`[jbot-review] ${msg}`),
      });
    } catch (error) {
      console.error(
        `[jbot-review] Review failed for ${owner}/${repoName}#${pr.number}: ${(error as Error).message}`,
      );
    } finally {
      // Copy from the clone in the finally, not an on-success hook: the runner
      // emits telemetry.jsonl on failed runs too, and failures are exactly
      // when a persistent copy is most valuable. The clone dies right after.
      if (process.env.JBOT_TELEMETRY_DIR && workspaceDir) {
        try {
          const dir = process.env.JBOT_TELEMETRY_DIR;
          mkdirSync(dir, { recursive: true });
          copyFileSync(
            join(workspaceDir, '.jbot-review', 'telemetry.jsonl'),
            join(dir, `${owner}-${repoName}-pr${pr.number}-${Date.now()}.jsonl`),
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`[jbot-review] telemetry persist failed: ${(err as Error).message}`);
          }
        }
      }
      cleanup?.();
    }
  });
}
