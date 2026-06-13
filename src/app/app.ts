import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { InstallationAccessTokenAuthentication } from '@octokit/auth-app';

import { createAppOctokit } from './auth.ts';
import { clonePr } from './clone.ts';
import { runPrReview } from '../shared/runner.ts';
import { formatModelName, parseModelName, resolveModelName } from '../shared/model.ts';
import { enqueue } from './queue.ts';

export interface AppConfig {
  appId: string;
  privateKey: string;
  apiKey: string;
  model: string;
}

// The pull_request webhook event is a union of action-specific payload types.
// Only some actions (like "opened") include an installation. We narrow with
// an "in" check before accessing the installation field.
type PullRequestEvent = EmitterWebhookEvent<'pull_request'>;

function parseEnvJsonObject(
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

export function resolveAuxModelForMainModel(mainModel: string, auxModelInput?: string): string {
  const input = auxModelInput?.trim();
  if (!input) return '';
  const { providerID } = parseModelName(mainModel);
  return formatModelName(resolveModelName(providerID, input));
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
    const octokit = createAppOctokit(cfg.appId, cfg.privateKey, installationId);
    const authRes = (await octokit.auth()) as InstallationAccessTokenAuthentication;
    const { dir, cleanup } = clonePr(repoInfo.clone_url, pr.head.ref, pr.base.ref, authRes.token);

    try {
      const auxModel = resolveAuxModelForMainModel(cfg.model, process.env.JBOT_REVIEW_AUX_MODEL);
      await runPrReview({
        octokit,
        owner,
        repo: repoName,
        pullNumber: pr.number,
        pullTitle: pr.title,
        pullBody: pr.body ?? '',
        workspace: dir,
        model: cfg.model,
        apiKey: cfg.apiKey,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        // The multi-pass/verification defaults cost ~3x a single session;
        // the webhook app has no per-run inputs, so expose env knobs.
        options: {
          enhancedContext: true,
          reviewPasses: parseEnvInt('JBOT_REVIEW_PASSES', 1),
          verifyFindings: process.env.JBOT_VERIFY_FINDINGS?.trim() !== 'false',
          auxModel,
          timeBudgetMinutes: parseEnvInt('JBOT_TIME_BUDGET_MINUTES', 30),
          reviewShards: parseEnvInt('JBOT_REVIEW_SHARDS', 0),
          modelOptions: parseEnvJsonObject('JBOT_MODEL_OPTIONS', { reasoningEffort: 'medium' }),
          maxConcurrentSessions: parseEnvInt('JBOT_MAX_CONCURRENT_SESSIONS', 0),
        },
        log: (msg: string) => console.log(`[jbot-review] ${msg}`),
      });
    } catch (error) {
      console.error(
        `[jbot-review] Review failed for ${owner}/${repoName}#${pr.number}: ${(error as Error).message}`,
      );
    } finally {
      cleanup();
    }
  });
}
