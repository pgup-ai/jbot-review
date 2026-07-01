import { loadWorkerConfig } from './config.ts';
import { makeClient } from './client.ts';
import type { WorkerClient } from './client.ts';
import { runJob } from './run-job.ts';
import type { ClaimedJob } from '../shared/worker-contract.ts';

function maskGitHubActionsValue(value: string | null | undefined): void {
  if (process.env.GITHUB_ACTIONS !== 'true' || !value) return;
  const escaped = value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::add-mask::${escaped}`);
}

function maskClaimSecrets(job: ClaimedJob): void {
  maskGitHubActionsValue(job.apiKey);
  maskGitHubActionsValue(job.auxApiKey);
  maskGitHubActionsValue(job.installationToken);
  maskGitHubActionsValue(job.claimToken);
}

/** Claim + run + report one job. Returns false if the queue was empty (no job claimed). */
async function processOne(client: WorkerClient, log: (m: string) => void): Promise<boolean> {
  let job: ClaimedJob | null;
  try {
    job = await client.claim();
  } catch (err) {
    log(`claim error: ${String(err)}`);
    return false; // treat as "nothing claimed"; caller decides whether to retry or exit
  }
  if (!job) return false;
  maskClaimSecrets(job);
  log(`claimed ${job.jobId} (${job.repoFullName}#${job.prNumber}, ${job.model})`);
  const result = await runJob(job, log); // already carries claimToken
  try {
    await client.update(job.jobId, result);
    log(`job ${job.jobId} -> ${result.status}`);
  } catch (err) {
    // A failed/unreachable update leaves a 'running' orphan on the control plane; the
    // control plane's claim-time reaper requeues it (a fresh claim re-stamps the fence).
    log(`update ${job.jobId} error: ${String(err)}`);
  }
  return true;
}

async function main(): Promise<void> {
  const cfg = loadWorkerConfig();
  const client = makeClient(cfg);
  const log = (m: string) => console.log(`[worker] ${m}`);
  maskGitHubActionsValue(cfg.controlPlaneUrl);
  maskGitHubActionsValue(cfg.sharedSecret);

  if (cfg.oneShot) {
    // ONE untrusted review per worker, then the runner/sandbox is destroyed. Never claim
    // a second job in the same (possibly tainted) process — that could leak the next
    // tenant's decrypted key/token.
    log(`oneShot: claiming one job from ${cfg.controlPlaneUrl}`);
    await processOne(client, log);
    return; // exit (cleanly, even if the queue was empty)
  }

  // Legacy long-poll (VPS / local dev): many jobs in one process, no isolation guarantee.
  log(`polling ${cfg.controlPlaneUrl} every ${cfg.pollMs}ms`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    if (!(await processOne(client, log))) await sleep(cfg.pollMs);
  }
}

void main();
