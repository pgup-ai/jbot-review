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
const MAX_PRIOR_JBOT_REPLIES_FOR_PROMPT = 5;
const MAX_PRIOR_JBOT_REPLY_CHARS = 800;

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
  replies: PriorJbotThreadReply[];
}

export interface PriorJbotThreadReply {
  author: string;
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

// GitHub's compare endpoint returns at most 300 files with no pagination.
const COMPARE_FILES_CAP = 300;

/**
 * Changed files (with patches) between two commits — the incremental delta for a
 * re-review. Three-dot/merge-base semantics (invariant #7). A response at the
 * `COMPARE_FILES_CAP` is a TRUNCATED (incomplete) delta — a trigger could sit in
 * an omitted file — so throw rather than return partial evidence; the caller
 * fails open to full lenses.
 */
export async function compareCommitFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<PrFile[]> {
  const res = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${base}...${head}`,
  });
  const files = res.data.files ?? [];
  if (files.length >= COMPARE_FILES_CAP) {
    throw new Error(
      `compare returned ${files.length} files (capped); incremental delta incomplete`,
    );
  }
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
          originalLine?: number | null;
          comments: {
            nodes?: Array<{
              databaseId?: number | null;
              body: string;
              url: string;
              author?: {
                login: string;
              } | null;
            } | null> | null;
          };
        } | null>;
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
export interface PriorJbotThreads {
  /** Open jbot finding threads — review context + duplicate-suppression input. */
  threads: PriorJbotThread[];
  /**
   * Threads jbot already replied to as addressed (marker present) but that are
   * still unresolved — e.g. a prior run's resolve call failed. They need a
   * mechanical resolve retry, no re-reply.
   */
  unresolvedAddressedThreadIds: string[];
}

/**
 * Disposition of a prior jbot finding thread: feed it to the reviewer as
 * context, resolve-only (already addressed but the thread never closed), or
 * skip (already addressed AND resolved). Pure — the traversal supplies the two
 * booleans.
 */
export function classifyPriorJbotThread(input: {
  addressed: boolean;
  isResolved: boolean;
}): 'review-context' | 'resolve-only' | 'skip' {
  if (!input.addressed) return 'review-context';
  return input.isResolved ? 'skip' : 'resolve-only';
}

export async function listPriorJbotThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PriorJbotThreads> {
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
              originalLine
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
  const unresolvedAddressedThreadIds: string[] = [];
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
    if (!page) return { threads, unresolvedAddressedThreadIds };
    commentState ??= await listJbotReviewCommentState(
      octokit,
      owner,
      repo,
      pullNumber,
      viewerLogin,
    );

    for (const thread of page.nodes) {
      if (!thread) continue;
      const comments = thread.comments.nodes ?? [];
      const topLevel = comments[0];
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
      const addressed =
        comments.some((comment) => hasInternalMarker(comment?.body, ADDRESSED_MARKER)) ||
        commentState.addressedTopLevelIds.has(topLevel.databaseId);
      const disposition = classifyPriorJbotThread({ addressed, isResolved: thread.isResolved });
      if (disposition === 'skip') continue;
      if (disposition === 'resolve-only') {
        unresolvedAddressedThreadIds.push(thread.id);
        continue;
      }

      const replies = comments
        .slice(1)
        .filter((comment): comment is NonNullable<typeof comment> => Boolean(comment?.body))
        .map((comment) => ({
          author: comment.author?.login ?? 'unknown',
          body: comment.body,
          url: comment.url,
        }));

      threads.push({
        id: thread.id,
        isResolved: thread.isResolved,
        replyToCommentId: topLevel.databaseId,
        path: thread.path,
        // `line` is null both for file-level comments AND for outdated
        // inline threads. Falling back to originalLine keeps outdated
        // threads line-anchored so duplicate suppression matches them
        // against inline findings, not against file-level ones.
        line: thread.line ?? thread.originalLine ?? undefined,
        body: topLevel.body,
        url: topLevel.url,
        replies,
      });
    }

    if (!page.pageInfo.hasNextPage) {
      after = null;
    } else if (page.pageInfo.endCursor) {
      after = page.pageInfo.endCursor;
    } else {
      break;
    }
  } while (after);

  return { threads, unresolvedAddressedThreadIds };
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
    body: formatFindingCommentBody(f),
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

export function formatFindingMetadata(finding: Pick<Finding, 'kind' | 'confidence'>): string {
  const parts = [finding.kind, finding.confidence].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** `path:line` for an anchored finding, or just `path` for a file-level one. */
export function formatFindingLocation(finding: Pick<Finding, 'path' | 'line'>): string {
  return finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
}

/**
 * Single source of the posted comment body. The trailing FINDING_MARKER is
 * load-bearing: isJbotFinding and duplicate suppression recognize prior
 * findings by it, so every posting path must go through here.
 */
function formatFindingCommentBody(finding: Finding): string {
  return `**${finding.severity}${formatFindingMetadata(finding)}** — ${finding.title}\n\n${finding.body}\n\n${FINDING_MARKER}`;
}

/**
 * Posts one file-level review comment (subject_type "file") for a finding
 * anchored to line 0 — absence/contract findings that no single added line
 * can carry. The createReview comments array does not support file-level
 * anchors, so these go through the standalone review-comment endpoint.
 */
export async function postFileLevelComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  headSha: string,
  finding: Finding,
): Promise<void> {
  await octokit.rest.pulls.createReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: headSha,
    path: finding.path,
    subject_type: 'file',
    body: formatFindingCommentBody(finding),
  });
}

/** The fixed set of reaction contents GitHub accepts (no ✅ / checkmark). */
export type PrReactionContent =
  | '+1'
  | '-1'
  | 'laugh'
  | 'confused'
  | 'heart'
  | 'hooray'
  | 'rocket'
  | 'eyes';

async function getViewerLogin(octokit: Octokit): Promise<string> {
  const response = (await octokit.graphql('query { viewer { login } }')) as {
    viewer: { login: string };
  };
  return response.viewer.login;
}

/**
 * Removes the bot's own prior reaction of the given content from the PR.
 * Scoped to OUR reactions (viewer login, with the github-actions[bot] alias)
 * so a human's reaction is never touched. Used to clear the "review done"
 * marker at the start of a new run so it only reappears when the run
 * finishes.
 */
export async function removeOwnPrReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  content: PrReactionContent,
): Promise<void> {
  const viewerLogin = await getViewerLogin(octokit);
  const reactions = await octokit.paginate(octokit.rest.reactions.listForIssue, {
    owner,
    repo,
    issue_number: pullNumber,
    content,
    per_page: 100,
  });
  for (const reaction of reactions) {
    if (reaction.content !== content) continue;
    const login = reaction.user?.login;
    if (login !== viewerLogin && !isGithubActionsAlias(login, viewerLogin)) continue;
    await octokit.rest.reactions.deleteForIssue({
      owner,
      repo,
      issue_number: pullNumber,
      reaction_id: reaction.id,
    });
  }
}

/** Adds a reaction to the PR (the "review done" marker). Idempotent server-side. */
export async function addPrReaction(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  content: PrReactionContent,
): Promise<void> {
  await octokit.rest.reactions.createForIssue({
    owner,
    repo,
    issue_number: pullNumber,
    content,
  });
}

export async function postAddressedThreadReply(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  thread: PriorJbotThread;
  addressedByCommit: string;
}): Promise<void> {
  const commitLabel = formatCommitLabel(params.owner, params.repo, params.addressedByCommit);
  const body = [`✅ Addressed in ${commitLabel}.`, '', ADDRESSED_MARKER].join('\n');

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
    'Canonical rules for these threads:',
    '- Do not re-raise an issue an existing thread already covers, unless a newer commit creates a materially different problem.',
    '- If later thread replies say the finding was not applied, intentionally declined, accepted as-is, or not worth fixing, treat the issue as already discussed: do not re-post it and do not mark it addressed.',
    '- When a task asks you to report addressed threads: only mark a thread addressed when the current branch verifiably fixes the specific issue raised, and use the exact thread id; not re-raising an issue does not make it addressed.',
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
        formatPriorThreadRepliesForPrompt(thread.replies),
      ].join('\n'),
    );
  }
  return lines.join('\n\n');
}

function formatPriorThreadRepliesForPrompt(replies: PriorJbotThreadReply[]): string {
  if (replies.length === 0) return 'Thread replies: none';
  const promptReplies = replies.slice(-MAX_PRIOR_JBOT_REPLIES_FOR_PROMPT);
  return [
    replies.length > promptReplies.length
      ? `Thread replies: latest ${promptReplies.length} of ${replies.length}`
      : 'Thread replies:',
    ...promptReplies.map((reply) =>
      [
        `- ${reply.author}:`,
        truncateForPrompt(stripJbotMarkers(reply.body), MAX_PRIOR_JBOT_REPLY_CHARS),
        `  URL: ${reply.url}`,
      ].join('\n  '),
    ),
  ].join('\n');
}

function isJbotFinding(
  body: string,
  authorLogin: string | undefined,
  viewerLogin: string,
  jbotCommentIds: ReadonlySet<number>,
  commentId?: number,
): boolean {
  if (hasInternalMarker(body, FINDING_MARKER)) return true;
  if (authorLogin !== viewerLogin && !isGithubActionsAlias(authorLogin, viewerLogin)) return false;
  return commentId !== undefined && jbotCommentIds.has(commentId);
}

function hasInternalMarker(body: string | undefined, marker: string): boolean {
  return body?.includes(marker) ?? false;
}

function isGithubActionsAlias(authorLogin: string | undefined, viewerLogin: string): boolean {
  return (
    authorLogin === 'github-actions[bot]' &&
    (viewerLogin === 'github-actions' || viewerLogin === 'github-actions[bot]')
  );
}

export function isJbotReviewBody(body: string): boolean {
  return body.includes(REVIEW_MARKER) || /^## j-?bot code review\b/i.test(body);
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
  if (maxLength <= 0) return '';
  if (maxLength <= 15) return text.slice(0, maxLength);
  const previewLength = Math.max(0, maxLength - 15);
  return `${text.slice(0, previewLength).trimEnd()}\n...[truncated]`;
}
