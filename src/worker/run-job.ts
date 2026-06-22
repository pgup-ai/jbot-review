import { Octokit as CoreOctokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import type { Octokit } from '../shared/github.ts';
import { clonePr } from '../app/clone.ts';
import { runPrReview } from '../shared/runner.ts';
import type { ClaimedJob, JobUpdate } from '../shared/worker-contract.ts';

const TokenOctokit = CoreOctokit.plugin(paginateRest, restEndpointMethods);

/**
 * Build a token-authed Octokit. Unlike the hosted app (which holds the App
 * private key and mints its own token), the worker receives a short-lived
 * installation token from the control plane per job and never holds the App key.
 */
export function octokitForToken(token: string): Octokit {
  return new TokenOctokit({ auth: token }) as Octokit;
}

/** Run one claimed job; resolves to the terminal JobUpdate (never throws). */
export async function runJob(job: ClaimedJob, log: (m: string) => void): Promise<JobUpdate> {
  const startedAt = Date.now();
  // Exactly "owner/repo" — reject empty segments AND extra slashes (e.g. "a/b/c").
  const parts = job.repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    log(`job ${job.jobId}: malformed repoFullName "${job.repoFullName}"`);
    return { status: 'failed', durationMs: Date.now() - startedAt };
  }
  const [owner, repo] = parts;
  const octokit = octokitForToken(job.installationToken);
  let cleanup: (() => void) | null = null;
  try {
    const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: job.prNumber });
    // Clone the base repo (the one the App is installed on) and check out the
    // PR head + base — mirrors the hosted-app flow in src/app/app.ts.
    const cloned = clonePr(
      pr.data.base.repo.clone_url,
      pr.data.head.ref,
      pr.data.base.ref,
      job.installationToken,
    );
    cleanup = cloned.cleanup;
    await runPrReview({
      octokit,
      owner,
      repo,
      pullNumber: job.prNumber,
      pullTitle: pr.data.title,
      pullBody: pr.data.body ?? '',
      workspace: cloned.dir,
      model: job.model,
      apiKey: job.apiKey,
      headSha: pr.data.head.sha,
      baseRef: pr.data.base.ref,
      baseSha: pr.data.base.sha,
      options: {
        enhancedContext: true,
        reviewPasses: 1,
        verifyFindings: true,
        // Match the hosted app / Action defaults explicitly. The runner otherwise
        // auto-shards when reviewShards is unset (default 0) — bad on one BYOK key
        // and a small VPS — so pin a single shard, plus a 30-min wall-clock cap so
        // one slow job can't starve the worker, and medium reasoning effort.
        reviewShards: 1,
        timeBudgetMinutes: 30,
        modelOptions: { reasoningEffort: 'medium' },
        ...(job.auxModel ? { auxModel: job.auxModel } : {}),
      },
      log,
    });
    return { status: 'success', durationMs: Date.now() - startedAt };
  } catch (err) {
    log(`job ${job.jobId} failed: ${String(err)}`);
    return { status: 'failed', durationMs: Date.now() - startedAt };
  } finally {
    cleanup?.();
  }
}
