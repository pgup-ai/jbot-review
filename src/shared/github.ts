import { Octokit as CoreOctokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';

import type { Finding } from './types.ts';
import type { ReviewCommit } from './review-context.ts';

const Review = CoreOctokit.plugin(paginateRest, restEndpointMethods);
export type Octokit = InstanceType<typeof Review>;

export interface PrFile {
  filename: string;
  patch?: string;
}

export type Verdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

/** Lists changed files (with their patches) in the pull request. */
export async function listPrFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PrFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files.map((f) => ({ filename: f.filename, patch: f.patch }));
}

export async function listPrCommits(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewCommit[]> {
  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return commits.map((commit) => ({
    sha: commit.sha,
    message: commit.commit.message.split('\n')[0],
    author: commit.author?.login ?? commit.commit.author?.name ?? undefined,
  }));
}

export async function getCheckStatusSummary(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  try {
    const runs = await octokit.paginate(octokit.rest.checks.listForRef, {
      owner,
      repo,
      ref,
      per_page: 100,
    });
    if (runs.length === 0) return 'No check runs reported for the PR head commit.';

    const completed = runs.filter((run) => run.status === 'completed');
    const passed = completed.filter(
      (run) => run.conclusion === 'success' || run.conclusion === 'neutral',
    ).length;
    const failed = completed.filter(
      (run) =>
        run.conclusion === 'failure' ||
        run.conclusion === 'action_required' ||
        run.conclusion === 'timed_out' ||
        run.conclusion === 'cancelled',
    ).length;
    const skipped = completed.filter((run) => run.conclusion === 'skipped').length;
    const pending = runs.length - completed.length;
    const other = completed.length - passed - failed - skipped;
    const details = runs
      .slice(0, 10)
      .map((run) => `- ${run.name}: ${run.status}${run.conclusion ? `/${run.conclusion}` : ''}`);

    return [
      `${runs.length} check run(s): ${passed} passed, ${pending} pending, ${failed} failed, ${skipped} skipped, ${other} other.`,
      ...details,
    ].join('\n');
  } catch (error) {
    return `Check status unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Fetches existing review comments (from bots and human reviewers) to
 * give the agent context about what has already been discussed.
 */
export async function listPrComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string[]> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return reviews.map((r) => {
    const user = r.user?.login ?? 'unknown';
    const state = r.state?.replace('_', ' ').toUpperCase() ?? 'COMMENT';
    return `${user} (${state}): ${r.body ?? '(no body)'}`;
  });
}

/**
 * Decision rubric for posting a review: we only ever post COMMENT reviews
 * (inline comments only). We never auto-approve or request-changes because
 * that requires elevated permissions that may fail on forks. The verdict
 * logic is kept for the summary body only.
 */
export function decideVerdict(_findings: Finding[]): Verdict {
  return 'COMMENT';
}

/** Posts one review; inline-anchorable findings become inline comments. */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  verdict: Verdict,
  body: string,
  inlineFindings: Finding[],
): Promise<void> {
  const comments = inlineFindings.map((f) => ({
    path: f.path,
    line: f.line,
    side: 'RIGHT' as const,
    body: `**${f.severity}** — ${f.title}\n\n${f.body}`,
  }));

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: verdict,
      body,
      comments,
    });
  } catch {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: verdict,
        body: `${body}\n\n_(inline comments omitted — failed to anchor to diff lines)_`,
      });
    } catch {
      throw new Error('Failed to post review to GitHub');
    }
  }
}
