import { Octokit as CoreOctokit } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import { restEndpointMethods } from '@octokit/plugin-rest-endpoint-methods';

import type { Finding } from './types.ts';
import type { LinkedIssue, ReviewCommit } from './review-context.ts';
import type { PriorThreadOutcome } from './telemetry.ts';
import {
  decideApprovalContinuity,
  decideAutoApproval,
  isDefinitiveApprovalRejection,
  type AutoApprovalDecision,
} from './approval.ts';

const Review = CoreOctokit.plugin(paginateRest, restEndpointMethods);
export type Octokit = InstanceType<typeof Review>;
const REVIEW_MARKER = '<!-- jbot-review:review -->';
const FINDING_MARKER = '<!-- jbot-review:finding -->';
const ADDRESSED_MARKER = '<!-- jbot-review:addressed -->';
const COMPACTED_REVIEW_MARKER = '<!-- jbot-review:compacted -->';
const LINKED_COMMENTS_MARKER = 'jbot-review:linked-comments';
const THREAD_COUNT_MARKER = 'jbot-review:threads';
const LINKED_COMMENTS_FOOTER = new RegExp(
  `\\n?<!--\\s*${LINKED_COMMENTS_MARKER}:([\\d,]*)\\s*-->\\s*$`,
);
const MAX_PRIOR_JBOT_THREADS_FOR_PROMPT = 25;
const MAX_PRIOR_JBOT_COMMENT_CHARS = 1000;
const MAX_PRIOR_JBOT_REPLIES_FOR_PROMPT = 5;
const MAX_PRIOR_JBOT_REPLY_CHARS = 800;

export interface PrFile {
  filename: string;
  patch?: string;
  changes?: number;
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

export interface JbotReviewGroup {
  id: number;
  nodeId: string;
  body: string;
  isMinimized: boolean;
  threads: Array<{ id: string; isResolved: boolean }>;
}

/**
 * Narrowed rather than widened: these ids are map keys and marker text, and a
 * bigint key never matches its number twin. The union is forward-looking —
 * octokit parses plain JSON, so ids arrive as numbers and this is identity.
 */
const asId = (id: number | bigint): number => Number(id);

export type Verdict = 'APPROVE' | 'COMMENT';

interface ReviewDecision {
  state: string;
  commit_id: string | null;
  user?: { login?: string } | null;
  body?: string | null;
}

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
  return files.map((f) => ({
    filename: f.filename,
    patch: f.patch,
    changes: f.changes,
  }));
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
              reactionGroups?: Array<{
                content: string;
                reactors: { nodes?: Array<{ __typename: string } | null> | null };
              }> | null;
            } | null> | null;
          };
        } | null>;
      };
    } | null;
  } | null;
}

interface JbotReviewCommentState {
  addressedTopLevelIds: ReadonlySet<number>;
  reviewIdByTopLevelId: ReadonlyMap<number, number>;
  reviewGroupsById: ReadonlyMap<number, JbotReviewGroup>;
}

interface ReviewNodesResponse {
  nodes: Array<{
    id: string;
    isMinimized: boolean;
  } | null>;
}

/**
 * Lists prior inline review threads created by the authenticated jbot actor.
 * Prompt context omits threads already acknowledged as addressed; review
 * groups retain them so fully resolved reviews can be compacted and minimized.
 */
export interface PriorJbotThreads {
  /** Open jbot finding threads — review context + duplicate-suppression input. */
  threads: PriorJbotThread[];
  /** Jbot reviews with their finding threads, including resolved threads. */
  reviewGroups: JbotReviewGroup[];
  /**
   * Threads jbot already replied to as addressed (marker present) but that are
   * still unresolved — e.g. a prior run's resolve call failed. They need a
   * mechanical resolve retry, no re-reply.
   */
  unresolvedAddressedThreadIds: string[];
  /**
   * Observed human-outcome state of EVERY prior jbot finding thread — including
   * the addressed/resolved ones the review context omits. Outcome telemetry
   * input, independent of includePriorComments.
   */
  outcomes: PriorThreadOutcome[];
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
  // GitHub's GraphQL node estimator budgets 500k nodes per request, counted
  // multiplicatively from the `first` args: 100 threads × 100 comments ×
  // reactors(first: N) must stay under it. N=50 estimated to 510,100 and the
  // whole lookup was rejected (dogfooded 2026-08-03); N=10 estimates ~110k.
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
                  reactionGroups {
                    content
                    reactors(first: 10) {
                      nodes {
                        __typename
                      }
                    }
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
  const outcomes: PriorThreadOutcome[] = [];
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
    if (!page) return { threads, reviewGroups: [], unresolvedAddressedThreadIds, outcomes };
    commentState ??= await listJbotReviewCommentState(
      octokit,
      owner,
      repo,
      pullNumber,
      viewerLogin,
    );
    const state = commentState;

    for (const thread of page.nodes) {
      if (!thread) continue;
      const comments = (thread.comments.nodes ?? []).filter(
        (comment): comment is NonNullable<typeof comment> => Boolean(comment),
      );
      const topLevel =
        comments.find(
          (comment) =>
            comment.databaseId !== null &&
            comment.databaseId !== undefined &&
            state.reviewIdByTopLevelId.has(comment.databaseId),
        ) ?? comments[0];
      if (!topLevel?.databaseId) continue;
      if (
        !isJbotFinding(
          topLevel.body,
          topLevel.author?.login,
          viewerLogin,
          state.reviewIdByTopLevelId,
          topLevel.databaseId,
        )
      )
        continue;
      const reviewId = state.reviewIdByTopLevelId.get(topLevel.databaseId);
      if (reviewId !== undefined) {
        const review = state.reviewGroupsById.get(reviewId)!;
        review.threads.push({
          id: thread.id,
          isResolved: thread.isResolved,
        });
      }
      const addressed =
        comments.some((comment) =>
          isBotAddressedReply(comment.author?.login, comment.body, viewerLogin),
        ) || state.addressedTopLevelIds.has(topLevel.databaseId);
      // Before the disposition gates: outcomes cover skip/resolve-only threads too.
      // A bot's 👍 is not a human outcome — mirrors the [bot] exclusion in humanReplies.
      const count = (content: string) =>
        topLevel.reactionGroups
          ?.find((group) => group.content === content)
          ?.reactors.nodes?.filter((reactor) => reactor?.__typename === 'User').length ?? 0;
      outcomes.push({
        threadId: thread.id,
        path: thread.path,
        line: thread.line ?? thread.originalLine ?? undefined,
        resolved: thread.isResolved,
        addressed,
        humanReplies: comments.filter(
          (comment) =>
            comment !== topLevel &&
            comment.author?.login !== viewerLogin &&
            !comment.author?.login?.endsWith('[bot]'),
        ).length,
        thumbsUp: count('THUMBS_UP'),
        thumbsDown: count('THUMBS_DOWN'),
        confused: count('CONFUSED'),
      });
      const disposition = classifyPriorJbotThread({ addressed, isResolved: thread.isResolved });
      if (disposition === 'skip') continue;
      if (disposition === 'resolve-only') {
        unresolvedAddressedThreadIds.push(thread.id);
        continue;
      }

      const replies = comments
        .filter((comment) => comment !== topLevel)
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

  const reviewGroups = commentState
    ? [...commentState.reviewGroupsById.values()].filter((review) => review.threads.length > 0)
    : [];
  return { threads, reviewGroups, unresolvedAddressedThreadIds, outcomes };
}

/** Same-repo issues GitHub records this PR as closing (closing keywords or
 * manual links) — intent input for the claims-verification pass. Cross-repo
 * references are dropped (the query over-fetches to leave headroom for that);
 * the formatter budgets the bytes. `omitted` counts every closing reference
 * not returned — beyond the cap or cross-repo — so the context block can
 * disclose that its list is incomplete (invariant #4). */
const MAX_LINKED_ISSUES = 3;

// Aux-context lookup: bounded like blast-radius' git grep — a stalled request
// must fail open in seconds, not at undici's multi-minute defaults.
const LINKED_ISSUES_TIMEOUT_MS = 10_000;

export async function listClosingIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<{ issues: LinkedIssue[]; omitted: number }> {
  const response = (await octokit.graphql(
    `
      query ClosingIssues($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            closingIssuesReferences(first: 10) {
              totalCount
              nodes {
                number
                title
                body
                repository {
                  name
                  owner {
                    login
                  }
                }
              }
            }
          }
        }
      }
    `,
    {
      owner,
      repo,
      number: pullNumber,
      request: { signal: AbortSignal.timeout(LINKED_ISSUES_TIMEOUT_MS) },
    },
  )) as {
    repository?: {
      pullRequest?: {
        closingIssuesReferences?: {
          totalCount?: number;
          nodes?: Array<{
            number: number;
            title: string;
            body?: string | null;
            repository: { name: string; owner: { login: string } };
          } | null> | null;
        } | null;
      } | null;
    } | null;
  };
  const refs = response.repository?.pullRequest?.closingIssuesReferences;
  const nodes = refs?.nodes ?? [];
  const issues = nodes
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .filter(
      (node) =>
        node.repository.owner.login.toLowerCase() === owner.toLowerCase() &&
        node.repository.name.toLowerCase() === repo.toLowerCase(),
    )
    .slice(0, MAX_LINKED_ISSUES)
    .map((node) => ({ number: node.number, title: node.title, body: node.body ?? '' }));
  return { issues, omitted: (refs?.totalCount ?? nodes.length) - issues.length };
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
  const jbotReviews = reviews.filter(
    (review) =>
      isViewerActor(review.user?.login, viewerLogin) && isJbotReviewBody(review.body ?? ''),
  );
  const jbotReviewIds = new Set(jbotReviews.map((review) => asId(review.id)));
  const reviewNodes = jbotReviews.length
    ? ((await octokit.graphql(
        `
          query JbotReviewMinimization($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on PullRequestReview {
                id
                isMinimized
              }
            }
          }
        `,
        { ids: jbotReviews.map((review) => review.node_id) },
      )) as ReviewNodesResponse)
    : { nodes: [] };
  const minimizedReviewNodeIds = new Set(
    reviewNodes.nodes.flatMap((review) => (review?.isMinimized ? [review.id] : [])),
  );
  const reviewGroupsById = new Map(
    jbotReviews.map((review) => [
      asId(review.id),
      {
        id: asId(review.id),
        nodeId: review.node_id,
        body: review.body ?? '',
        isMinimized: minimizedReviewNodeIds.has(review.node_id),
        threads: [],
      } satisfies JbotReviewGroup,
    ]),
  );
  const linkedReviewIdByCommentId = new Map<number, number>();
  for (const review of jbotReviews) {
    for (const commentId of parseLinkedCommentIds(review.body ?? '')) {
      linkedReviewIdByCommentId.set(commentId, asId(review.id));
    }
  }

  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });

  const reviewIdByTopLevelId = new Map<number, number>();
  for (const comment of comments) {
    const reviewId = comment.pull_request_review_id;
    if (!isViewerActor(comment.user?.login, viewerLogin) || comment.in_reply_to_id) continue;
    const commentId = asId(comment.id);
    if (reviewId !== null && reviewId !== undefined && jbotReviewIds.has(asId(reviewId))) {
      reviewIdByTopLevelId.set(commentId, asId(reviewId));
      continue;
    }
    const linkedReviewId = linkedReviewIdByCommentId.get(commentId);
    if (linkedReviewId !== undefined && hasInternalMarker(comment.body, FINDING_MARKER)) {
      reviewIdByTopLevelId.set(commentId, linkedReviewId);
    }
  }
  const addressedTopLevelIds = new Set(
    comments
      .filter(
        (comment) =>
          isBotAddressedReply(comment.user?.login, comment.body, viewerLogin) &&
          comment.in_reply_to_id !== null &&
          comment.in_reply_to_id !== undefined,
      )
      .map((comment) => asId(comment.in_reply_to_id as number | bigint)),
  );

  return { addressedTopLevelIds, reviewIdByTopLevelId, reviewGroupsById };
}

/** Finding reviews are advisory; clean-run approval is handled separately. */
export function decideVerdict(_findings: Finding[]): Verdict {
  return 'COMMENT';
}

export async function checkAutoApprovalEligibility(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewedHeadSha: string,
): Promise<AutoApprovalDecision> {
  const latestDecision = await getLatestJbotDecision(octokit, owner, repo, pullNumber);

  const pull = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });
  const decision = decideAutoApproval({
    state: pull.data.state,
    draft: pull.data.draft === true,
    headSha: pull.data.head.sha,
    reviewedHeadSha,
    mergeable: pull.data.mergeable,
  });
  if (decision.status === 'blocked') return decision;
  if (latestDecision?.state === 'APPROVED' && latestDecision.commit_id === reviewedHeadSha) {
    return { status: 'already-approved' };
  }
  return decision;
}

export async function postApprovalReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  headSha: string,
): Promise<void> {
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: headSha,
      event: 'APPROVE',
      body: formatReviewBody(body, 0),
    });
  } catch (error) {
    if (isDefinitiveApprovalRejection(error)) throw error;
    throw new Error('Auto-approval may still be active: GitHub did not confirm it was posted.', {
      cause: error,
    });
  }

  const pull = await octokit.rest.pulls
    .get({ owner, repo, pull_number: pullNumber })
    .catch((error: unknown) => {
      throw new Error(
        'Auto-approval may still be active: the pull request could not be revalidated.',
        {
          cause: error,
        },
      );
    });
  const decision = decideApprovalContinuity({
    state: pull.data.state,
    draft: pull.data.draft === true,
    headSha: pull.data.head.sha,
    reviewedHeadSha: headSha,
  });
  if (decision.status === 'blocked') {
    throw new Error(`Auto-approval may still be active: ${decision.reason}.`);
  }
}

/**
 * Posts one review; inline-anchorable findings become inline comments.
 *
 * GitHub rejects the whole createReview call if any single comment fails to
 * anchor, so a rejected batch is retried one comment at a time: a stale or
 * unanchorable line costs itself, not every other finding in the run. Only a
 * 422 counts as a rejection — any other failure may already have been applied
 * server-side, where re-posting would duplicate every comment.
 */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  verdict: Verdict,
  body: string,
  inlineFindings: Finding[],
  linkedCommentIds: readonly number[],
  headSha: string,
): Promise<{ inlinePosted: number; inlineDropped: number }> {
  const base = stripLinkedCommentsFooter(body);
  // The footer stores unique ids, so the expected-thread count must be built
  // from the same set — a duplicate would wait forever for a thread that never was.
  const linkedIds = [...new Set(linkedCommentIds)];
  let rejected = false;
  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: verdict,
      body: formatReviewBody(base, inlineFindings.length + linkedIds.length, linkedIds),
      comments: inlineFindings.map((f) => ({
        path: f.path,
        line: f.line,
        side: 'RIGHT' as const,
        body: formatFindingCommentBody(f),
      })),
    });
    return { inlinePosted: inlineFindings.length, inlineDropped: 0 };
  } catch (error) {
    rejected = (error as { status?: number } | null)?.status === 422;
  }

  // Salvage first so the body can state the true dropped count and link the
  // survivors: like file-level comments, they hang off the PR, not this review.
  // GitHub does not name the offending comment, so every one is retried.
  const salvagedIds: number[] = [];
  if (rejected) {
    for (const finding of inlineFindings) {
      try {
        const response = await octokit.rest.pulls.createReviewComment({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: headSha,
          path: finding.path,
          line: finding.line,
          side: 'RIGHT',
          body: formatFindingCommentBody(finding),
        });
        salvagedIds.push(asId(response.data.id));
      } catch {
        /* this one could not anchor; counted below */
      }
    }
  }
  const inlineDropped = inlineFindings.length - salvagedIds.length;
  // Nothing posted with the batch, so every surviving thread is a linked one.
  const salvagedLinkedIds = [...new Set([...linkedIds, ...salvagedIds])];

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: verdict,
      body: formatReviewBody(
        inlineDropped > 0
          ? `${base}\n\n_(${inlineDropped} inline comment(s) omitted — failed to anchor to diff lines)_`
          : base,
        salvagedLinkedIds.length,
        salvagedLinkedIds,
      ),
    });
  } catch {
    throw new Error('Failed to post review to GitHub');
  }
  return { inlinePosted: salvagedIds.length, inlineDropped };
}

export async function updateReviewBody(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewId: number,
  body: string,
): Promise<void> {
  await octokit.rest.pulls.updateReview({
    owner,
    repo,
    pull_number: pullNumber,
    review_id: reviewId,
    body,
  });
}

export function formatFindingLabel(
  finding: Pick<Finding, 'severity' | 'kind' | 'confidence'>,
): string {
  const kind = finding.kind ? ` · ${finding.kind}` : '';
  const confidence = finding.confidence
    ? ` (*conf: ${finding.confidence === 'medium' ? 'med' : finding.confidence}*)`
    : '';
  return `**${finding.severity}${kind}**${confidence}`;
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
  return `${formatFindingLabel(finding)} — ${finding.title}\n\n${finding.body}\n\n${FINDING_MARKER}`;
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
): Promise<number> {
  const response = await octokit.rest.pulls.createReviewComment({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: headSha,
    path: finding.path,
    subject_type: 'file',
    body: formatFindingCommentBody(finding),
  });
  return asId(response.data.id);
}

/** The fixed set of reaction contents GitHub accepts (no ✅ / checkmark). */
export type PrReactionContent =
  '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';

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
    if (!isViewerActor(login, viewerLogin)) continue;
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

export async function minimizePullRequestReview(
  octokit: Octokit,
  reviewNodeId: string,
): Promise<void> {
  await octokit.graphql(
    `
      mutation MinimizeResolvedReview($reviewNodeId: ID!) {
        minimizeComment(input: { subjectId: $reviewNodeId, classifier: RESOLVED }) {
          minimizedComment {
            isMinimized
          }
        }
      }
    `,
    { reviewNodeId },
  );
}

/**
 * Byte backstop over the count caps above (invariant #4): the count caps
 * alone allow ≈133KB. Unresolved threads sort first, so the budget evicts
 * resolved threads preferentially.
 */
export const MAX_PRIOR_JBOT_THREADS_BYTES = 32 * 1024;

export function formatPriorJbotThreadsForPrompt(threads: PriorJbotThread[]): string {
  if (threads.length === 0) return '';
  const promptThreads = [...threads]
    .sort((a, b) => Number(a.isResolved) - Number(b.isResolved))
    .slice(0, MAX_PRIOR_JBOT_THREADS_FOR_PROMPT);
  const header = [
    '## Prior jbot-review inline comments',
    'Canonical rules for these threads:',
    '- Do not re-raise an issue an existing thread already covers, unless a newer commit creates a materially different problem.',
    '- If later thread replies say the finding was not applied, intentionally declined, accepted as-is, or not worth fixing, treat the issue as already discussed: do not re-post it and do not mark it addressed.',
    '- When a task asks you to report addressed threads: only mark a thread addressed when the current branch verifiably fixes the specific issue raised, and use the exact thread id; not re-raising an issue does not make it addressed.',
  ];
  const disclosureFor = (shown: number) =>
    `Showing ${shown} of ${threads.length} prior jbot-review threads to keep review context bounded.`;
  let used = Buffer.byteLength(header.join('\n\n'), 'utf8');
  const reserve = Buffer.byteLength(`\n\n${disclosureFor(threads.length)}`, 'utf8');
  const sections: string[] = [];
  for (const thread of promptThreads) {
    const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
    const section = [
      `### ${thread.id}`,
      `Status: ${thread.isResolved ? 'resolved' : 'unresolved'}`,
      `Location: ${location}`,
      `URL: ${thread.url}`,
      'Comment:',
      truncateForPrompt(stripJbotMarkers(thread.body), MAX_PRIOR_JBOT_COMMENT_CHARS),
      formatPriorThreadRepliesForPrompt(thread.replies),
    ].join('\n');
    const cost = Buffer.byteLength(`\n\n${section}`, 'utf8');
    if (used + cost + reserve > MAX_PRIOR_JBOT_THREADS_BYTES) break;
    sections.push(section);
    used += cost;
  }
  const lines = [...header];
  if (sections.length < threads.length) lines.push(disclosureFor(sections.length));
  return [...lines, ...sections].join('\n\n');
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
  reviewIdByCommentId: ReadonlyMap<number, number>,
  commentId?: number,
): boolean {
  if (hasInternalMarker(body, FINDING_MARKER)) return true;
  if (!isViewerActor(authorLogin, viewerLogin)) return false;
  return commentId !== undefined && reviewIdByCommentId.has(commentId);
}

function hasInternalMarker(body: string | undefined, marker: string): boolean {
  return body?.includes(marker) ?? false;
}

/**
 * True only when the ADDRESSED marker was posted by the bot/viewer itself. The
 * marker is jbot's own "I addressed this" signal — a PR author who copies the
 * hidden marker into a reply must not be able to close (or resolve) an open
 * finding they never fixed.
 */
export function isBotAddressedReply(
  authorLogin: string | undefined,
  body: string | undefined,
  viewerLogin: string,
): boolean {
  // Match the bot's own identity like isJbotFinding/removeOwnPrReaction do: on
  // GitHub Actions the viewer is `github-actions` but replies are authored as
  // `github-actions[bot]`. The alias only matches the bot's Actions identity,
  // never a human, so marker forgery by a PR author is still rejected.
  const isBot = isViewerActor(authorLogin, viewerLogin);
  return isBot && hasInternalMarker(body, ADDRESSED_MARKER);
}

function isViewerActor(authorLogin: string | undefined, viewerLogin: string): boolean {
  return (
    authorLogin === viewerLogin ||
    (authorLogin === 'github-actions[bot]' && viewerLogin === 'github-actions')
  );
}

function findLatestJbotDecision(
  reviews: readonly ReviewDecision[],
  viewerLogin: string,
): ReviewDecision | undefined {
  // COMMENT reviews do not replace an approval or changes-requested decision.
  return [...reviews]
    .reverse()
    .find(
      (review) =>
        (review.state === 'APPROVED' ||
          review.state === 'CHANGES_REQUESTED' ||
          review.state === 'DISMISSED') &&
        isViewerActor(review.user?.login, viewerLogin) &&
        isJbotReviewBody(review.body ?? ''),
    );
}

async function getLatestJbotDecision(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<ReviewDecision | undefined> {
  const [viewerLogin, reviews] = await Promise.all([
    getViewerLogin(octokit),
    octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    }),
  ]);
  return findLatestJbotDecision(reviews, viewerLogin);
}

export interface PullFreshness {
  state: 'open' | 'closed';
  merged: boolean;
  headSha: string;
}

/**
 * Current PR liveness for the pre-retry stale check (TASK-155): merged,
 * closed, or a moved head makes a main-shard retry pointless — its output
 * could never be posted against the reviewed state.
 */
export async function getPullFreshness(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullFreshness> {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  return {
    state: data.state === 'closed' ? 'closed' : 'open',
    merged: Boolean(data.merged),
    headSha: data.head?.sha ?? '',
  };
}

export function isJbotReviewBody(body: string): boolean {
  return body.includes(REVIEW_MARKER) || /^## j-?bot code review\b/i.test(body);
}

export function selectResolvedJbotReviewsToFinalize(
  reviews: readonly JbotReviewGroup[],
  resolvedThisRun: readonly string[],
): JbotReviewGroup[] {
  const resolved = new Set(resolvedThisRun);
  return reviews.filter((review) => {
    if (review.threads.length === 0) return false;
    // The summary total counts findings that never get a thread (outside-the-diff
    // ones, and any inline comment a salvage could not place), so it can never
    // balance for those reviews. Reviews posted since record the count they
    // actually expected; older ones fall back to the total.
    const expected = parseExpectedThreadCount(review.body) ?? parseReviewFindingCount(review.body);
    if (expected !== review.threads.length) return false;
    if (!review.threads.every((thread) => thread.isResolved || resolved.has(thread.id)))
      return false;
    return !review.isMinimized || !hasInternalMarker(review.body, COMPACTED_REVIEW_MARKER);
  });
}

export function compactJbotReviewBody(body: string, threadCount: number): string {
  if (hasInternalMarker(body, COMPACTED_REVIEW_MARKER)) return body;
  const linkedCommentIds = parseLinkedCommentIds(body);
  const original = stripLinkedCommentsFooter(body)
    .replaceAll(REVIEW_MARKER, '')
    .replaceAll(COMPACTED_REVIEW_MARKER, '')
    .trim()
    .replace(/^## j-?bot code review\s*/i, '')
    .trim();
  const noun = threadCount === 1 ? 'thread' : 'threads';
  return appendLinkedCommentsFooter(
    appendReviewMarker(
      [
        '## J-Bot Code Review',
        '',
        `✅ **All ${threadCount} review ${noun} resolved.**`,
        '',
        '<details>',
        '<summary>Show original review</summary>',
        '',
        original,
        '',
        '</details>',
        '',
        COMPACTED_REVIEW_MARKER,
      ].join('\n'),
    ),
    linkedCommentIds,
  );
}

function parseReviewFindingCount(body: string): number | undefined {
  const lines = body.split('\n');
  const headerIndex = lines.findIndex((line) => /^\|\s*Total\s*\|\s*P0\s*\|/i.test(line));
  if (headerIndex < 0) return undefined;
  const count = lines[headerIndex + 2]?.match(/^\|\s*(\d+)\s*\|/)?.[1];
  return count === undefined ? undefined : Number.parseInt(count, 10);
}

/** Records how many threads this review expected, so finalization has a target that can be met. */
function withThreadCount(body: string, threads: number): string {
  return `${body}\n<!-- ${THREAD_COUNT_MARKER}:${threads} -->`;
}

function formatReviewBody(
  body: string,
  threads: number,
  linkedCommentIds: readonly number[] = [],
): string {
  return appendLinkedCommentsFooter(
    appendReviewMarker(withThreadCount(body, threads)),
    linkedCommentIds,
  );
}

function parseExpectedThreadCount(body: string): number | undefined {
  const count = body.match(new RegExp(`<!--\\s*${THREAD_COUNT_MARKER}:(\\d+)\\s*-->`))?.[1];
  return count === undefined ? undefined : Number.parseInt(count, 10);
}

function appendLinkedCommentsFooter(body: string, commentIds: readonly number[]): string {
  const strippedBody = stripLinkedCommentsFooter(body);
  const ids = [...new Set(commentIds)].join(',');
  return ids ? `${strippedBody}\n\n<!-- ${LINKED_COMMENTS_MARKER}:${ids} -->` : strippedBody;
}

function parseLinkedCommentIds(body: string): number[] {
  const ids = body.match(LINKED_COMMENTS_FOOTER)?.[1];
  return ids ? ids.split(',').map((id) => Number.parseInt(id, 10)) : [];
}

function stripLinkedCommentsFooter(body: string): string {
  return body.replace(LINKED_COMMENTS_FOOTER, '').trimEnd();
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
