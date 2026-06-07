import type { Finding } from './types.ts';

import { Octokit as CoreOctokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';

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
 * Decision rubric: P0/P1 block merges, P2 warns, P3/nit are advisory.
 *   - any P0 or P1          -> REQUEST_CHANGES (blocks merge)
 *   - one or more P2        -> COMMENT (does not block)
 *   - P3 / nit only / none  -> APPROVE
 */
export function decideVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'P0' || f.severity === 'P1')) return 'REQUEST_CHANGES';
  if (findings.some((f) => f.severity === 'P2')) return 'COMMENT';
  return 'APPROVE';
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
