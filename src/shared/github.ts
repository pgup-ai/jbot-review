import { Octokit as CoreOctokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';

import type { Finding } from './types.ts';
import type { ReviewCommit } from './review-context.ts';

const Review = CoreOctokit.plugin(paginateRest, restEndpointMethods);
export type Octokit = InstanceType<typeof Review>;
const REVIEW_MARKER = '<!-- jbot-review:review -->';
const FINDING_MARKER = '<!-- jbot-review:finding -->';
const ADDRESSED_MARKER = '<!-- jbot-review:addressed -->';
const MAX_PRIOR_JBOT_THREADS_FOR_PROMPT = 25;
const MAX_PRIOR_JBOT_COMMENT_CHARS = 1000;

export interface PrFile {
  filename: string;
  patch?: string;
}

export interface PriorJbotThread {
  id: string;
  isResolved: boolean;
  replyToCommentId: number;
  path: string;
  line?: number;
  body: string;
  url: string;
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

interface ReviewThreadsResponse {
  viewer: {
    login: string;
  };
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path: string;
          line?: number | null;
          comments: {
            nodes: Array<{
              databaseId?: number | null;
              body: string;
              url: string;
              author?: {
                login: string;
              } | null;
            }>;
          };
        }>;
      };
    } | null;
  } | null;
}

interface JbotReviewCommentState {
  ownedTopLevelIds: ReadonlySet<number>;
  addressedTopLevelIds: ReadonlySet<number>;
}

/**
 * Lists prior inline review threads created by the authenticated jbot actor.
 * Threads already acknowledged as addressed are omitted to avoid duplicate
 * replies on later review runs.
 */
export async function listPriorJbotThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PriorJbotThread[]> {
  const query = `
    query JbotReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) {
      viewer {
        login
      }
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100, after: $after) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              isResolved
              path
              line
              comments(first: 100) {
                nodes {
                  databaseId
                  body
                  url
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const threads: PriorJbotThread[] = [];
  let commentState: JbotReviewCommentState | undefined;
  let after: string | null = null;
  do {
    const response = (await octokit.graphql(query, {
      owner,
      repo,
      number: pullNumber,
      after,
    })) as ReviewThreadsResponse;
    const viewerLogin = response.viewer.login;
    const page = response.repository?.pullRequest?.reviewThreads;
    if (!page) return threads;
    commentState ??= await listJbotReviewCommentState(
      octokit,
      owner,
      repo,
      pullNumber,
      viewerLogin,
    );

    for (const thread of page.nodes) {
      const topLevel = thread.comments.nodes[0];
      if (!topLevel?.databaseId) continue;
      if (
        !isJbotFinding(
          topLevel.body,
          topLevel.author?.login,
          viewerLogin,
          commentState.ownedTopLevelIds,
          topLevel.databaseId,
        )
      )
        continue;
      const alreadyAcknowledged = thread.comments.nodes.some(
        (comment) =>
          comment.author?.login === viewerLogin && comment.body.includes(ADDRESSED_MARKER),
      );
      if (alreadyAcknowledged || commentState.addressedTopLevelIds.has(topLevel.databaseId))
        continue;

      threads.push({
        id: thread.id,
        isResolved: thread.isResolved,
        replyToCommentId: topLevel.databaseId,
        path: thread.path,
        line: thread.line ?? undefined,
        body: topLevel.body,
        url: topLevel.url,
      });
    }

    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return threads;
}

async function listJbotReviewCommentState(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  viewerLogin: string,
): Promise<JbotReviewCommentState> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const jbotReviewIds = new Set(
    reviews
      .filter((review) => review.user?.login === viewerLogin && isJbotReviewBody(review.body ?? ''))
      .map((review) => review.id),
  );
  if (jbotReviewIds.size === 0) {
    return { ownedTopLevelIds: new Set(), addressedTopLevelIds: new Set() };
  }

  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const ownedTopLevelIds = new Set(
    comments
      .filter((comment) => {
        const reviewId = comment.pull_request_review_id;
        return (
          comment.user?.login === viewerLogin &&
          !comment.in_reply_to_id &&
          reviewId !== null &&
          reviewId !== undefined &&
          jbotReviewIds.has(reviewId)
        );
      })
      .map((comment) => comment.id),
  );
  const addressedTopLevelIds = new Set(
    comments
      .filter(
        (comment) =>
          comment.user?.login === viewerLogin &&
          comment.body.includes(ADDRESSED_MARKER) &&
          comment.in_reply_to_id !== null &&
          comment.in_reply_to_id !== undefined,
      )
      .map((comment) => comment.in_reply_to_id as number),
  );

  return { ownedTopLevelIds, addressedTopLevelIds };
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
    body: `**${f.severity}** — ${f.title}\n\n${f.body}\n\n${FINDING_MARKER}`,
  }));

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: verdict,
      body: appendReviewMarker(body),
      comments,
    });
  } catch {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: verdict,
        body: appendReviewMarker(
          `${body}\n\n_(inline comments omitted — failed to anchor to diff lines)_`,
        ),
      });
    } catch {
      throw new Error('Failed to post review to GitHub');
    }
  }
}

export async function postAddressedThreadReply(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  thread: PriorJbotThread;
  addressedByCommit: string;
  note?: string;
}): Promise<void> {
  const commitLabel = formatCommitLabel(params.owner, params.repo, params.addressedByCommit);
  const note = params.note?.trim();
  const body = [`Addressed in ${commitLabel}.${note ? ` ${note}` : ''}`, '', ADDRESSED_MARKER].join(
    '\n',
  );

  await params.octokit.rest.pulls.createReplyForReviewComment({
    owner: params.owner,
    repo: params.repo,
    pull_number: params.pullNumber,
    comment_id: params.thread.replyToCommentId,
    body,
  });
}

export async function resolveReviewThread(octokit: Octokit, threadId: string): Promise<void> {
  await octokit.graphql(
    `
      mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread {
            id
            isResolved
          }
        }
      }
    `,
    { threadId },
  );
}

export function formatPriorJbotThreadsForPrompt(threads: PriorJbotThread[]): string {
  if (threads.length === 0) return '';
  const promptThreads = [...threads]
    .sort((a, b) => Number(a.isResolved) - Number(b.isResolved))
    .slice(0, MAX_PRIOR_JBOT_THREADS_FOR_PROMPT);
  const lines = [
    '## Prior jbot-review inline comments',
    'If a prior jbot-review comment is now definitively addressed by the current PR branch, include its id in "addressedPriorComments". Do not mark a comment addressed merely because you are not re-raising it.',
  ];
  if (threads.length > promptThreads.length) {
    lines.push(
      `Showing ${promptThreads.length} of ${threads.length} prior jbot-review threads to keep review context bounded.`,
    );
  }
  for (const thread of promptThreads) {
    const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
    lines.push(
      [
        `### ${thread.id}`,
        `Status: ${thread.isResolved ? 'resolved' : 'unresolved'}`,
        `Location: ${location}`,
        `URL: ${thread.url}`,
        'Comment:',
        truncateForPrompt(stripJbotMarkers(thread.body), MAX_PRIOR_JBOT_COMMENT_CHARS),
      ].join('\n'),
    );
  }
  return lines.join('\n\n');
}

function isJbotFinding(
  body: string,
  authorLogin: string | undefined,
  viewerLogin: string,
  jbotCommentIds: ReadonlySet<number>,
  commentId?: number,
): boolean {
  if (authorLogin !== viewerLogin) return false;
  if (body.includes(FINDING_MARKER)) return true;
  return commentId !== undefined && jbotCommentIds.has(commentId);
}

function isJbotReviewBody(body: string): boolean {
  return body.includes(REVIEW_MARKER) || /^## jbot code review\b/m.test(body);
}

function appendReviewMarker(body: string): string {
  return body.includes(REVIEW_MARKER) ? body : `${body}\n\n${REVIEW_MARKER}`;
}

function formatCommitLabel(owner: string, repo: string, commit: string): string {
  const trimmed = commit.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) return `\`${trimmed || 'the latest commit'}\``;
  const short = trimmed.slice(0, 7);
  return `[${short}](https://github.com/${owner}/${repo}/commit/${trimmed})`;
}

function stripJbotMarkers(body: string): string {
  return body.replaceAll(FINDING_MARKER, '').replaceAll(ADDRESSED_MARKER, '').trim();
}

function truncateForPrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const previewLength = Math.max(0, maxLength - 15);
  return `${text.slice(0, previewLength).trimEnd()}\n...[truncated]`;
}
