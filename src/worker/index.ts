import { loadWorkerConfig } from './config.ts';
import { makeClient } from './client.ts';
import { runJob } from './run-job.ts';
import type { ClaimedJob } from '../shared/worker-contract.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadWorkerConfig();
  const client = makeClient(cfg);
  const log = (m: string) => console.log(`[worker] ${m}`);
  log(`polling ${cfg.controlPlaneUrl} every ${cfg.pollMs}ms`);

  for (;;) {
    let job: ClaimedJob | null;
    try {
      job = await client.claim();
    } catch (err) {
      log(`claim error: ${String(err)}`);
      await sleep(cfg.pollMs);
      continue;
    }
    if (!job) {
      await sleep(cfg.pollMs);
      continue;
    }
    log(`claimed ${job.jobId} (${job.repoFullName}#${job.prNumber}, ${job.model})`);
    const result = await runJob(job, log);
    try {
      await client.update(job.jobId, result);
      log(`job ${job.jobId} -> ${result.status}`);
    } catch (err) {
      // A failed/unreachable update leaves a 'running' orphan on the control
      // plane; the control plane's claim-time reaper requeues it (a fresh claim
      // re-stamps the fence). Keep polling.
      log(`update ${job.jobId} error: ${String(err)}`);
    }
  }
}

void main();
