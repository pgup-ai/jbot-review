import { Octokit as CoreOctokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';
import type { Octokit } from '../shared/github.ts';
import { clonePr } from '../app/clone.ts';
import { defaultModelOptions } from '../shared/config.ts';
import { parseModelName } from '../shared/model.ts';
import { runPrReview } from '../shared/runner.ts';
import type { Severity } from '../shared/types.ts';
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
  let cleanup: (() => void) | null = null;
  // Captured from runPrReview's onReviewResult hook → forwarded so the control plane's
  // check-run can gate on real per-severity counts.
  let findingsBySeverity: Partial<Record<Severity, number>> | undefined;
  try {
    // Exactly "owner/repo" — reject empty segments AND extra slashes (e.g. "a/b/c").
    // Parsing lives inside the try so a malformed/absent repoFullName fails the
    // job rather than throwing out of runJob (which is documented never-throws).
    const parts = job.repoFullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      log(`job ${job.jobId}: malformed repoFullName "${job.repoFullName}"`);
      return { claimToken: job.claimToken, status: 'failed', durationMs: Date.now() - startedAt };
    }
    const [owner, repo] = parts;
    const octokit = octokitForToken(job.installationToken);
    const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: job.prNumber });
    // Clone the contributor's fork when present; clonePr fetches the upstream
    // base separately so the checkout always has both sides of a three-dot diff.
    const headCloneUrl = pr.data.head.repo?.clone_url ?? pr.data.base.repo.clone_url;
    const cloned = clonePr({
      headCloneUrl,
      headRef: pr.data.head.ref,
      headSha: pr.data.head.sha,
      baseCloneUrl: pr.data.base.repo.clone_url,
      baseSha: pr.data.base.sha,
      token: job.installationToken,
    });
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
      preparePatchRecovery: cloned.prepareDiff,
      options: {
        enhancedContext: true,
        reviewPasses: 1,
        verifyFindings: true,
        // Match the hosted app / Action defaults explicitly. The runner otherwise
        // auto-shards when reviewShards is unset (default 0) — bad on one BYOK key
        // and a small VPS — so pin a single shard, plus a 30-min wall-clock cap so
        // one slow job can't starve the worker. Reasoning follows the selected
        // provider's default, including Poolside's low-effort guardrail.
        reviewShards: 1,
        timeBudgetMinutes: 30,
        modelOptions: defaultModelOptions(parseModelName(job.model).providerID),
        onReviewResult: (r) => {
          const counts: Partial<Record<Severity, number>> = {};
          for (const f of r.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
          findingsBySeverity = counts;
        },
        ...(job.auxModel ? { auxModel: job.auxModel } : {}),
        ...(job.auxApiKey ? { auxApiKey: job.auxApiKey } : {}),
      },
      log,
    });
    return {
      claimToken: job.claimToken,
      status: 'success',
      durationMs: Date.now() - startedAt,
      ...(findingsBySeverity ? { findingsBySeverity } : {}),
    };
  } catch (err) {
    log(`job ${job.jobId} failed: ${String(err)}`);
    return { claimToken: job.claimToken, status: 'failed', durationMs: Date.now() - startedAt };
  } finally {
    cleanup?.();
  }
}
