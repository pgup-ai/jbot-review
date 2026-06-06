import { createAppOctokit } from "./auth.ts";
import { clonePr } from "./clone.ts";
import { runPrReview } from "../shared/runner.ts";
import { enqueue } from "./queue.ts";

export interface AppConfig {
  appId: string;
  privateKey: string;
  keyEnv: string;
  apiKey: string;
  model: string;
}

export function handlePrEvent(
  event: { payload: any },
  cfg: AppConfig,
): void {
  const { payload } = event;
  if (!payload.pull_request || !payload.installation) return;

  const pr = payload.pull_request;
  const repoInfo = payload.repository;
  if (!repoInfo) return;

  const owner = repoInfo.owner.login ?? repoInfo.owner.name;
  const repoName = repoInfo.name as string;
  const installationId = payload.installation.id as number;

  enqueue(async () => {
    const octokit = createAppOctokit(cfg.appId, cfg.privateKey, installationId);
    const authRes = await octokit.auth() as unknown as { token: string };
    const { dir, cleanup } = clonePr(
      repoInfo.clone_url as string,
      pr.head.ref as string,
      pr.base.ref as string,
      authRes.token,
    );

    try {
      await runPrReview({
        octokit,
        owner,
        repo: repoName,
        pullNumber: pr.number as number,
        pullTitle: pr.title as string,
        pullBody: (pr.body ?? "") as string,
        workspace: dir,
        model: cfg.model,
        keyEnv: cfg.keyEnv,
        apiKey: cfg.apiKey,
        log: (msg) => console.log(`[jbot-review] ${msg}`),
      });
    } catch (error) {
      console.error(`[jbot-review] Review failed for ${owner}/${repoName}#${pr.number}: ${(error as Error).message}`);
    } finally {
      cleanup();
    }
  });
}
