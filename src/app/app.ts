import type { EmitterWebhookEvent } from '@octokit/webhooks';
import type { InstallationAccessTokenAuthentication } from '@octokit/auth-app';

import { createAppOctokit } from './auth.ts';
import { clonePr } from './clone.ts';
import { runPrReview } from '../shared/runner.ts';
import { enqueue } from './queue.ts';

export interface AppConfig {
  appId: string;
  privateKey: string;
  keyEnv: string;
  apiKey: string;
  model: string;
}

// The pull_request webhook event is a union of action-specific payload types.
// Only some actions (like "opened") include an installation. We narrow with
// an "in" check before accessing the installation field.
type PullRequestEvent = EmitterWebhookEvent<'pull_request'>;

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
      await runPrReview({
        octokit,
        owner,
        repo: repoName,
        pullNumber: pr.number,
        pullTitle: pr.title,
        pullBody: pr.body ?? '',
        workspace: dir,
        model: cfg.model,
        keyEnv: cfg.keyEnv,
        apiKey: cfg.apiKey,
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
