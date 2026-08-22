import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkAutoApprovalEligibility,
  classifyPriorJbotThread,
  compactJbotReviewBody,
  formatFindingLabel,
  formatPriorJbotThreadsForPrompt,
  isBotAddressedReply,
  listClosingIssues,
  listPriorJbotThreads,
  MAX_PRIOR_JBOT_THREADS_BYTES,
  minimizePullRequestReview,
  postAddressedThreadReply,
  postApprovalReview,
  postReview,
  selectResolvedJbotReviewsToFinalize,
  updateReviewBody,
  type JbotReviewGroup,
  type Octokit,
  type PriorJbotThread,
} from '../src/shared/github.ts';
import {
  decideApprovalContinuity,
  decideAutoApproval,
  isDefinitiveApprovalRejection,
} from '../src/shared/approval.ts';
import type { Finding } from '../src/shared/types.ts';

const REVIEW_BODY = [
  '## J-Bot Code Review',
  '',
  '**Review state:** Needs changes before approval',
  '',
  '### Findings Summary',
  '',
  '| Total | P0 | P1 | P2 | P3 | nit |',
  '| ---: | ---: | ---: | ---: | ---: | ---: |',
  '| 1 | 0 | 0 | 1 | 0 | 0 |',
  '',
  '<!-- jbot-review:review -->',
].join('\n');
const LINKED_REVIEW_BODY = [
  REVIEW_BODY.replace('| 1 | 0 | 0 | 1 | 0 | 0 |', '| 2 | 0 | 0 | 1 | 1 | 0 |'),
  '<!-- jbot-review:linked-comments:200 -->',
].join('\n');

describe('formatFindingLabel', () => {
  it('keeps confidence explicit but visually secondary', () => {
    assert.equal(
      formatFindingLabel({
        severity: 'P3',
        kind: 'investigate',
        confidence: 'low',
      }),
      '**P3 · investigate** (*conf: low*)',
    );
    assert.equal(
      formatFindingLabel({
        severity: 'P2',
        kind: 'bug',
        confidence: 'medium',
      }),
      '**P2 · bug** (*conf: med*)',
    );
  });

  it('omits absent optional metadata', () => {
    assert.equal(formatFindingLabel({ severity: 'P1' }), '**P1**');
  });
});

describe('auto approval', () => {
  const eligible = {
    state: 'open',
    draft: false,
    headSha: 'headsha',
    reviewedHeadSha: 'headsha',
    mergeable: true,
  } as const;
  const pullResponse = (headSha: string) => ({
    data: {
      state: 'open',
      draft: false,
      head: { sha: headSha },
      mergeable: true,
    },
  });
  const approvalOctokit = (pulls: Record<string, unknown>) =>
    ({ rest: { pulls } }) as unknown as Octokit;
  const postApproval = (octokit: Octokit) =>
    postApprovalReview(octokit, 'acme', 'widget', 12, 'review body', 'headsha');

  it('requires the exact open, non-draft, mergeable reviewed head', () => {
    assert.deepEqual(decideAutoApproval(eligible), { status: 'eligible' });
    assert.equal(decideAutoApproval({ ...eligible, state: 'closed' }).status, 'blocked');
    assert.equal(decideAutoApproval({ ...eligible, draft: true }).status, 'blocked');
    assert.equal(decideAutoApproval({ ...eligible, headSha: 'new-head' }).status, 'blocked');
    assert.equal(decideAutoApproval({ ...eligible, mergeable: false }).status, 'blocked');
    assert.equal(decideAutoApproval({ ...eligible, mergeable: null }).status, 'blocked');
    assert.deepEqual(
      decideApprovalContinuity({
        state: 'open',
        draft: false,
        headSha: 'headsha',
        reviewedHeadSha: 'headsha',
      }),
      { status: 'eligible' },
    );
  });

  it('deduplicates only this bot approval on the reviewed head', async () => {
    const listReviews = {};
    let pullReads = 0;
    let approvedCommit = 'headsha';
    const octokit = {
      rest: {
        pulls: {
          listReviews,
          get: async () => {
            pullReads++;
            return pullResponse('headsha');
          },
        },
      },
      paginate: async (endpoint: unknown) => {
        assert.equal(endpoint, listReviews);
        return [
          {
            state: 'APPROVED',
            commit_id: approvedCommit,
            user: { login: 'github-actions[bot]' },
            body: '## J-Bot Code Review\n\n<!-- jbot-review:review -->',
          },
        ];
      },
      graphql: async () => ({ viewer: { login: 'github-actions' } }),
    };

    assert.deepEqual(
      await checkAutoApprovalEligibility(
        octokit as unknown as Octokit,
        'acme',
        'widget',
        12,
        'headsha',
      ),
      { status: 'already-approved' },
    );
    assert.equal(pullReads, 1, 'an existing approval still requires a fresh safety read');

    approvedCommit = 'old-head';
    assert.deepEqual(
      await checkAutoApprovalEligibility(
        octokit as unknown as Octokit,
        'acme',
        'widget',
        12,
        'headsha',
      ),
      { status: 'eligible' },
    );
    assert.equal(pullReads, 2, 'an older approval must not cover the newly reviewed head');
  });

  it('rejects a stale approved head after a fresh safety read', async () => {
    let reviewReads = 0;
    const octokit = {
      rest: {
        pulls: {
          listReviews: {},
          get: async () => pullResponse('new-head'),
        },
      },
      paginate: async () => {
        reviewReads++;
        return [];
      },
      graphql: async () => ({ viewer: { login: 'github-actions' } }),
    };

    assert.deepEqual(
      await checkAutoApprovalEligibility(
        octokit as unknown as Octokit,
        'acme',
        'widget',
        12,
        'headsha',
      ),
      { status: 'blocked', reason: 'the pull request head changed during review' },
    );
    assert.equal(reviewReads, 1);
  });

  it('does not deduplicate an approval superseded by changes requested', async () => {
    const listReviews = {};
    const review = {
      commit_id: 'headsha',
      user: { login: 'github-actions[bot]' },
      body: '## J-Bot Code Review\n\n<!-- jbot-review:review -->',
    };
    const octokit = {
      rest: {
        pulls: {
          listReviews,
          get: async () => pullResponse('headsha'),
        },
      },
      paginate: async () => [
        { ...review, state: 'APPROVED' },
        { ...review, state: 'CHANGES_REQUESTED', commit_id: 'newer-head' },
      ],
      graphql: async () => ({ viewer: { login: 'github-actions' } }),
    };

    assert.deepEqual(
      await checkAutoApprovalEligibility(
        octokit as unknown as Octokit,
        'acme',
        'widget',
        12,
        'headsha',
      ),
      { status: 'eligible' },
    );
  });

  it('pins approval to the reviewed commit and keeps the review marker', async () => {
    let request: Record<string, unknown> | undefined;
    const octokit = approvalOctokit({
      createReview: async (params: Record<string, unknown>) => {
        request = params;
      },
      get: async () => pullResponse('headsha'),
    });

    await postApproval(octokit);

    assert.equal(request?.event, 'APPROVE');
    assert.equal(request?.commit_id, 'headsha');
    assert.match(String(request?.body), /jbot-review:threads:0/);
    assert.match(String(request?.body), /jbot-review:review/);
  });

  it('keeps a confirmed approval when mergeability is temporarily unknown', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const octokit = approvalOctokit({
      createReview: async (params: Record<string, unknown>) => {
        requests.push(params);
      },
      get: async () => ({
        data: {
          state: 'open',
          draft: false,
          head: { sha: 'headsha' },
          mergeable: null,
        },
      }),
    });

    await postApproval(octokit);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.event, 'APPROVE');
  });

  it('fails a raced approval without posting a blocking review', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const octokit = approvalOctokit({
      createReview: async (params: Record<string, unknown>) => {
        requests.push(params);
      },
      get: async () => pullResponse('new-head'),
    });

    await assert.rejects(postApproval(octokit), /may still be active:.*head changed during review/);

    assert.deepEqual(
      requests.map((request) => request.event),
      ['APPROVE'],
    );
  });

  it('fails when the pull request cannot be revalidated without another review', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const octokit = approvalOctokit({
      createReview: async (params: Record<string, unknown>) => {
        requests.push(params);
      },
      get: async () => {
        throw new Error('network');
      },
    });

    await assert.rejects(postApproval(octokit), /may still be active:.*could not be revalidated/);

    assert.deepEqual(
      requests.map((request) => request.event),
      ['APPROVE'],
    );
  });

  it('fails when GitHub does not confirm approval without another review', async () => {
    const requests: Array<Record<string, unknown>> = [];
    let reviewCalls = 0;
    const octokit = approvalOctokit({
      createReview: async (params: Record<string, unknown>) => {
        requests.push(params);
        reviewCalls++;
        if (reviewCalls === 1) throw new Error('network');
      },
    });

    await assert.rejects(
      postApproval(octokit),
      /may still be active:.*did not confirm it was posted/,
    );

    assert.deepEqual(
      requests.map((request) => request.event),
      ['APPROVE'],
    );
  });

  it('falls back only for definitive GitHub approval rejections', () => {
    assert.equal(isDefinitiveApprovalRejection({ status: 403 }), true);
    assert.equal(isDefinitiveApprovalRejection({ status: 422 }), true);
    assert.equal(isDefinitiveApprovalRejection({ status: 500 }), false);
    assert.equal(isDefinitiveApprovalRejection(new Error('network')), false);
  });
});

describe('isBotAddressedReply', () => {
  it('counts the addressed marker only from the bot itself', () => {
    const marker = 'done\n\n<!-- jbot-review:addressed -->';
    assert.equal(isBotAddressedReply('jbot', marker, 'jbot'), true);
    // On GitHub Actions the viewer is `github-actions` but replies are authored
    // as `github-actions[bot]` — the bot must still recognize its own marker.
    assert.equal(isBotAddressedReply('github-actions[bot]', marker, 'github-actions'), true);
    // A PR author copying the hidden marker must NOT close the finding.
    assert.equal(isBotAddressedReply('attacker', marker, 'github-actions'), false);
    assert.equal(isBotAddressedReply('attacker', marker, 'jbot'), false);
    assert.equal(isBotAddressedReply('jbot', 'no marker here', 'jbot'), false);
    assert.equal(isBotAddressedReply(undefined, marker, 'jbot'), false);
  });
});

describe('classifyPriorJbotThread', () => {
  it('sends an addressed-but-unresolved thread to resolve-only, else context or skip', () => {
    assert.equal(
      classifyPriorJbotThread({ addressed: false, isResolved: false }),
      'review-context',
    );
    assert.equal(classifyPriorJbotThread({ addressed: true, isResolved: false }), 'resolve-only');
    assert.equal(classifyPriorJbotThread({ addressed: true, isResolved: true }), 'skip');
  });
});

describe('resolved review finalization', () => {
  it('selects only reviews whose full finding count is represented by resolved threads', () => {
    const review = (overrides: Partial<JbotReviewGroup>): JbotReviewGroup => ({
      id: 1,
      nodeId: 'PRR_1',
      body: REVIEW_BODY,
      isMinimized: false,
      threads: [{ id: 't1', isResolved: true }],
      ...overrides,
    });
    const selected = selectResolvedJbotReviewsToFinalize(
      [
        review({ id: 1 }),
        review({ id: 2, threads: [{ id: 't2', isResolved: false }] }),
        review({ id: 3, threads: [{ id: 't3', isResolved: false }] }),
        review({
          id: 4,
          threads: [
            { id: 't4', isResolved: true },
            { id: 't5', isResolved: true },
          ],
        }),
        review({
          id: 5,
          body: `${REVIEW_BODY}\n<!-- jbot-review:compacted -->`,
          isMinimized: true,
        }),
        review({ id: 6, body: `${REVIEW_BODY}\n<!-- jbot-review:compacted -->` }),
      ],
      ['t3'],
    );

    assert.deepEqual(
      selected.map((item) => item.id),
      [1, 3, 6],
    );
  });

  it('finalizes a review whose body-only findings were never going to have threads', () => {
    // The summary total counts outside-the-diff findings, which render in the
    // body and never become threads — so total-vs-threads can never balance and
    // such a review would stay expanded forever.
    const twoFindings = REVIEW_BODY.replace(
      '| 1 | 0 | 0 | 1 | 0 | 0 |',
      '| 2 | 0 | 0 | 1 | 1 | 0 |',
    );
    const base = {
      nodeId: 'PRR_1',
      isMinimized: false,
      threads: [{ id: 't1', isResolved: true }],
    };
    const select = (body: string, id: number) =>
      selectResolvedJbotReviewsToFinalize([{ id, body, ...base }], []).map((r) => r.id);

    assert.deepEqual(select(`${twoFindings}\n<!-- jbot-review:threads:1 -->`, 1), [1]);
    assert.deepEqual(
      select(twoFindings, 2),
      [],
      'without the marker the old total-vs-threads rule stands, so old reviews are unchanged',
    );
    assert.deepEqual(
      select(`${twoFindings}\n<!-- jbot-review:threads:2 -->`, 3),
      [],
      'a thread the run expected but did not find is still a reason to refuse',
    );
  });

  it('hides the stale body in a details block and preserves review markers', () => {
    const body = compactJbotReviewBody(REVIEW_BODY, 1);
    const pluralBody = compactJbotReviewBody(REVIEW_BODY, 2);
    const linkedBody = compactJbotReviewBody(LINKED_REVIEW_BODY, 2);

    assert.match(body, /✅ \*\*All 1 review thread resolved\.\*\*/);
    assert.match(pluralBody, /✅ \*\*All 2 review threads resolved\.\*\*/);
    assert.match(body, /<summary>Show original review<\/summary>/);
    assert.match(body, /Review state:\*\* Needs changes before approval/);
    assert.equal(body.match(/jbot-review:review/g)?.length, 1);
    assert.equal(body.match(/jbot-review:compacted/g)?.length, 1);
    assert.match(linkedBody, /jbot-review:linked-comments:200 -->$/);
    assert.equal(compactJbotReviewBody(body, 1), body);
  });

  it('updates the submitted review summary body', async () => {
    let request: unknown;
    const octokit = {
      rest: {
        pulls: {
          updateReview: async (params: unknown) => {
            request = params;
          },
        },
      },
    };

    await updateReviewBody(octokit as unknown as Octokit, 'acme', 'widget', 12, 77, 'compacted');

    assert.deepEqual(request, {
      owner: 'acme',
      repo: 'widget',
      pull_number: 12,
      review_id: 77,
      body: 'compacted',
    });
  });

  it('minimizes the submitted review as resolved', async () => {
    let query = '';
    let variables: unknown;
    const octokit = {
      graphql: async (request: string, params: unknown) => {
        query = request;
        variables = params;
      },
    };

    await minimizePullRequestReview(octokit as unknown as Octokit, 'PRR_77');

    assert.match(query, /minimizeComment/);
    assert.match(query, /classifier: RESOLVED/);
    assert.deepEqual(variables, { reviewNodeId: 'PRR_77' });
  });

  it('reads summary minimization while grouping direct and linked threads', async () => {
    const listReviews = {};
    const listReviewComments = {};
    let minimizationVariables: unknown;
    const octokit = {
      rest: { pulls: { listReviews, listReviewComments } },
      paginate: async (endpoint: unknown) => {
        if (endpoint === listReviews) {
          return [
            {
              id: 77,
              node_id: 'PRR_77',
              user: { login: 'github-actions[bot]' },
              body: LINKED_REVIEW_BODY,
            },
          ];
        }
        if (endpoint === listReviewComments) {
          return [
            {
              id: 100,
              user: { login: 'github-actions[bot]' },
              pull_request_review_id: 77,
              in_reply_to_id: null,
              body: 'finding\n\n<!-- jbot-review:finding -->',
            },
            {
              id: 101,
              user: { login: 'github-actions[bot]' },
              pull_request_review_id: 77,
              in_reply_to_id: 100,
              body: '✅ Addressed.\n\n<!-- jbot-review:addressed -->',
            },
            {
              id: 200,
              user: { login: 'github-actions[bot]' },
              pull_request_review_id: 88,
              in_reply_to_id: null,
              body: 'file finding\n\n<!-- jbot-review:finding -->',
            },
            {
              id: 201,
              user: { login: 'github-actions[bot]' },
              pull_request_review_id: 88,
              in_reply_to_id: 200,
              body: '✅ Addressed.\n\n<!-- jbot-review:addressed -->',
            },
          ];
        }
        throw new Error('unexpected pagination endpoint');
      },
      graphql: async (query: string, variables: unknown) => {
        if (query.includes('JbotReviewMinimization')) {
          minimizationVariables = variables;
          return { nodes: [{ id: 'PRR_77', isMinimized: true }] };
        }
        return {
          viewer: { login: 'github-actions' },
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'PRRT_resolved',
                    isResolved: true,
                    path: 'src/example.ts',
                    line: 4,
                    originalLine: 4,
                    comments: {
                      nodes: [
                        null,
                        {
                          databaseId: 100,
                          body: 'finding\n\n<!-- jbot-review:finding -->',
                          url: 'https://github.com/acme/widget/pull/1#discussion_r100',
                          author: { login: 'github-actions[bot]' },
                        },
                        {
                          databaseId: 101,
                          body: '✅ Addressed.\n\n<!-- jbot-review:addressed -->',
                          url: 'https://github.com/acme/widget/pull/1#discussion_r101',
                          author: { login: 'github-actions[bot]' },
                        },
                      ],
                    },
                  },
                  {
                    id: 'PRRT_file',
                    isResolved: true,
                    path: 'src/other.ts',
                    line: null,
                    originalLine: null,
                    comments: {
                      nodes: [
                        {
                          databaseId: 200,
                          body: 'file finding\n\n<!-- jbot-review:finding -->',
                          url: 'https://github.com/acme/widget/pull/1#discussion_r200',
                          author: { login: 'github-actions[bot]' },
                        },
                        {
                          databaseId: 201,
                          body: '✅ Addressed.\n\n<!-- jbot-review:addressed -->',
                          url: 'https://github.com/acme/widget/pull/1#discussion_r201',
                          author: { login: 'github-actions[bot]' },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        };
      },
    };

    const result = await listPriorJbotThreads(octokit as unknown as Octokit, 'acme', 'widget', 1);

    assert.deepEqual(result.threads, []);
    assert.deepEqual(result.unresolvedAddressedThreadIds, []);
    // Outcomes cover even the skip-classified threads the review context omits.
    assert.deepEqual(
      result.outcomes.map(({ threadId, addressed, resolved, humanReplies }) => ({
        threadId,
        addressed,
        resolved,
        humanReplies,
      })),
      [
        { threadId: 'PRRT_resolved', addressed: true, resolved: true, humanReplies: 0 },
        { threadId: 'PRRT_file', addressed: true, resolved: true, humanReplies: 0 },
      ],
    );
    assert.deepEqual(minimizationVariables, { ids: ['PRR_77'] });
    assert.deepEqual(result.reviewGroups, [
      {
        id: 77,
        nodeId: 'PRR_77',
        body: LINKED_REVIEW_BODY,
        isMinimized: true,
        threads: [
          { id: 'PRRT_resolved', isResolved: true },
          { id: 'PRRT_file', isResolved: true },
        ],
      },
    ]);
    assert.deepEqual(
      selectResolvedJbotReviewsToFinalize(result.reviewGroups, []).map((review) => review.id),
      [77],
    );
  });
});

describe('prior thread outcomes', () => {
  it('counts human replies and User reactions, excluding bot accounts from both', async () => {
    const octokit = {
      rest: { pulls: { listReviews: {}, listReviewComments: {} } },
      paginate: async () => [],
      graphql: async () => ({
        viewer: { login: 'github-actions' },
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'PRRT_live',
                  isResolved: false,
                  path: 'src/x.ts',
                  line: 7,
                  originalLine: 7,
                  comments: {
                    nodes: [
                      {
                        databaseId: 300,
                        body: 'finding\n\n<!-- jbot-review:finding -->',
                        url: 'https://github.com/acme/widget/pull/1#discussion_r300',
                        author: { login: 'github-actions[bot]' },
                        reactionGroups: [
                          {
                            content: 'THUMBS_UP',
                            reactors: { nodes: [{ __typename: 'User' }, { __typename: 'User' }] },
                          },
                          {
                            content: 'THUMBS_DOWN',
                            reactors: { nodes: [{ __typename: 'User' }, { __typename: 'Bot' }] },
                          },
                          { content: 'HEART', reactors: { nodes: [{ __typename: 'User' }] } },
                        ],
                      },
                      {
                        databaseId: 301,
                        body: 'this is a false positive',
                        url: 'https://github.com/acme/widget/pull/1#discussion_r301',
                        author: { login: 'alice' },
                      },
                      {
                        databaseId: 302,
                        body: 'noted',
                        url: 'https://github.com/acme/widget/pull/1#discussion_r302',
                        author: { login: 'dependabot[bot]' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      }),
    };

    const result = await listPriorJbotThreads(octokit as unknown as Octokit, 'acme', 'widget', 1);

    assert.equal(result.threads.length, 1, 'the live thread still reaches review context');
    assert.deepEqual(result.outcomes, [
      {
        threadId: 'PRRT_live',
        path: 'src/x.ts',
        line: 7,
        resolved: false,
        addressed: false,
        humanReplies: 1,
        thumbsUp: 2,
        thumbsDown: 1,
        confused: 0,
      },
    ]);
  });
});

describe('listClosingIssues', () => {
  it('keeps same-repo issues up to the cap and counts every other closing reference as omitted', async () => {
    const octokit = {
      graphql: async () => ({
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              totalCount: 6,
              nodes: [
                {
                  number: 1,
                  title: 'A',
                  body: 'body a',
                  repository: { name: 'widget', owner: { login: 'ACME' } },
                },
                {
                  number: 2,
                  title: 'B',
                  body: null,
                  repository: { name: 'widget', owner: { login: 'acme' } },
                },
                {
                  number: 3,
                  title: 'X',
                  body: 'cross-repo',
                  repository: { name: 'other', owner: { login: 'acme' } },
                },
                null,
              ],
            },
          },
        },
      }),
    };

    const result = await listClosingIssues(octokit as unknown as Octokit, 'acme', 'widget', 1);

    assert.deepEqual(result, {
      issues: [
        { number: 1, title: 'A', body: 'body a' },
        { number: 2, title: 'B', body: '' },
      ],
      omitted: 4,
    });
  });
});

describe('review posting', () => {
  it('links standalone file-level comments from the submitted review body', async () => {
    let request: { body?: string } | undefined;
    const octokit = {
      rest: {
        pulls: {
          createReview: async (params: { body?: string }) => {
            request = params;
          },
        },
      },
    };

    await postReview(
      octokit as unknown as Octokit,
      'acme',
      'widget',
      12,
      'COMMENT',
      'review body',
      [],
      [200, 200, 201],
      'headsha',
    );

    assert.match(request?.body ?? '', /jbot-review:linked-comments:200,201/);
    assert.doesNotMatch(request?.body ?? '', /200,200/);
    // The expected-thread count must be built from the same deduped ids as the
    // footer, or finalization waits forever for a thread that never existed.
    assert.match(request?.body ?? '', /jbot-review:threads:2 -->/);
    assert.match(request?.body ?? '', /jbot-review:linked-comments:200,201 -->$/);

    await postReview(
      octokit as unknown as Octokit,
      'acme',
      'widget',
      12,
      'COMMENT',
      'review body\n<!-- jbot-review:linked-comments:999 -->',
      [],
      [],
      'headsha',
    );
    assert.doesNotMatch(request?.body ?? '', /jbot-review:linked-comments/);
  });

  const finding = (line: number): Finding => ({
    path: 'a.ts',
    line,
    severity: 'P2',
    title: `t${line}`,
    body: 'b',
  });

  /** Stub whose batched createReview fails with `status`; per-comment posts reject `badLine`. */
  function rejectingOctokit(status: number, badLine?: number) {
    const state = { posted: [] as number[], body: '' };
    const octokit = {
      rest: {
        pulls: {
          createReview: async (params: { body?: string; comments?: unknown[] }) => {
            if (params.comments?.length) throw Object.assign(new Error('rejected'), { status });
            state.body = params.body ?? '';
          },
          createReviewComment: async (params: { line: number }) => {
            if (params.line === badLine) throw Object.assign(new Error('bad'), { status: 422 });
            state.posted.push(params.line);
            return { data: { id: 300 + params.line } };
          },
        },
      },
    };
    return { octokit: octokit as unknown as Octokit, state };
  }

  const post = (octokit: Octokit, findings: Finding[]) =>
    postReview(octokit, 'acme', 'widget', 12, 'COMMENT', 'review body', findings, [], 'headsha');

  it('salvages the still-anchorable comments when GitHub rejects the batch', async () => {
    const partial = rejectingOctokit(422, 99);
    const result = await post(partial.octokit, [finding(5), finding(99), finding(7)]);

    assert.deepEqual(partial.state.posted, [5, 7], 'one bad anchor no longer costs the good ones');
    assert.deepEqual(result, { inlinePosted: 2, inlineDropped: 1 });
    assert.match(partial.state.body, /1 inline comment/, 'the body reports what was lost');
    assert.match(
      partial.state.body,
      /jbot-review:linked-comments:305,307/,
      'salvaged comments are linked so the review can still be finalized',
    );

    // Everything salvaged: no omission note, or the body would claim a loss that did not happen.
    const full = rejectingOctokit(422);
    const allSaved = await post(full.octokit, [finding(5), finding(7)]);
    assert.deepEqual(allSaved, { inlinePosted: 2, inlineDropped: 0 });
    assert.doesNotMatch(full.state.body, /omitted/);
  });

  it('does not re-post comments when the batch failure was not a rejection', async () => {
    // A 500 may have been applied server-side; salvaging would duplicate every comment.
    const flaky = rejectingOctokit(500);
    const result = await post(flaky.octokit, [finding(5), finding(7)]);

    assert.deepEqual(flaky.state.posted, [], 'no comment is re-posted on an ambiguous failure');
    assert.deepEqual(result, { inlinePosted: 0, inlineDropped: 2 });
  });
});

describe('formatPriorJbotThreadsForPrompt', () => {
  it('bounds the rendered block at the byte budget, dropping resolved threads first', () => {
    // Count caps alone allow ≈133KB (25 threads × 1000-char bodies × 5×800-char
    // replies); the byte budget is the invariant-#4 backstop. Unresolved
    // threads sort first, so the budget evicts resolved ones preferentially.
    const thread = (index: number, isResolved: boolean): PriorJbotThread => ({
      id: `PRRT_${isResolved ? 'resolved' : 'open'}_${index}`,
      isResolved,
      replyToCommentId: index,
      path: 'src/example.ts',
      line: index + 1,
      body: `**P3** finding ${index} ${'b'.repeat(1000)}`,
      url: `https://github.com/example/repo/pull/1#discussion_r${index}`,
      replies: Array.from({ length: 5 }, (_, reply) => ({
        author: 'dev',
        body: `reply ${reply} ${'r'.repeat(800)}`,
        url: `https://github.com/example/repo/pull/1#discussion_r${index}${reply}`,
      })),
    });
    const threads = [
      ...Array.from({ length: 20 }, (_, i) => thread(i, true)),
      ...Array.from({ length: 5 }, (_, i) => thread(100 + i, false)),
    ];

    const prompt = formatPriorJbotThreadsForPrompt(threads);

    assert.ok(
      Buffer.byteLength(prompt, 'utf8') <= MAX_PRIOR_JBOT_THREADS_BYTES,
      `rendered block ${Buffer.byteLength(prompt, 'utf8')} bytes exceeds the budget`,
    );
    for (let index = 0; index < 5; index += 1) {
      assert.match(prompt, new RegExp(`PRRT_open_${100 + index}\\b`));
    }
    assert.match(prompt, /Showing \d+ of 25 prior jbot-review threads/);
    assert.doesNotMatch(prompt, /PRRT_resolved_19\b/);
  });

  it('includes human thread replies so declined suggestions are not re-raised', () => {
    const thread: PriorJbotThread = {
      id: 'PRRT_example',
      isResolved: false,
      replyToCommentId: 1001,
      path: 'src/example/order-line.ts',
      line: 207,
      body: [
        '**P3** - Safe access pattern on config',
        '',
        'Consider using `line.config?.id ?? ""`.',
        '',
        '<!-- jbot-review:finding -->',
      ].join('\n'),
      url: 'https://github.com/example/repo/pull/1#discussion_r1001',
      replies: [
        {
          author: 'jingbof',
          body: [
            'Not applied: `config` is required on `LineDto`, and the backend contract test covers it.',
          ].join('\n'),
          url: 'https://github.com/example/repo/pull/1#discussion_r1002',
        },
      ],
    };

    const prompt = formatPriorJbotThreadsForPrompt([thread]);

    assert.match(prompt, /Thread replies:/);
    assert.match(prompt, /jingbof:/);
    assert.match(prompt, /Not applied: `config` is required/);
    assert.match(prompt, /do not re-post it and do not mark it addressed/);
    assert.doesNotMatch(prompt, /jbot-review:finding/);
    assert.match(prompt, /Canonical rules for these threads:/);
    assert.match(prompt, /unless a newer commit creates a materially different problem/);
    assert.match(prompt, /not re-raising an issue does not make it addressed/);
  });

  it('keeps only the latest thread replies in prompt context', () => {
    const thread: PriorJbotThread = {
      id: 'PRRT_example',
      isResolved: false,
      replyToCommentId: 1001,
      path: 'src/example.ts',
      line: 42,
      body: 'Original finding',
      url: 'https://github.com/example/repo/pull/1#discussion_r1',
      replies: Array.from({ length: 7 }, (_, index) => ({
        author: `reviewer-${index + 1}`,
        body: `reply ${index + 1}`,
        url: `https://github.com/example/repo/pull/1#discussion_r${index + 2}`,
      })),
    };

    const prompt = formatPriorJbotThreadsForPrompt([thread]);

    assert.match(prompt, /Thread replies: latest 5 of 7/);
    assert.doesNotMatch(prompt, /reply 1/);
    assert.doesNotMatch(prompt, /reply 2/);
    assert.match(prompt, /reply 3/);
    assert.match(prompt, /reply 7/);
  });
});

describe('postAddressedThreadReply', () => {
  it('posts a concise addressed reply with the hidden marker', async () => {
    let postedBody = '';
    const octokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: async (params: { body: string }) => {
            postedBody = params.body;
          },
        },
      },
    };

    await postAddressedThreadReply({
      octokit: octokit as Parameters<typeof postAddressedThreadReply>[0]['octokit'],
      owner: 'acme',
      repo: 'widget',
      pullNumber: 12,
      thread: {
        id: 'PRRT_example',
        isResolved: false,
        replyToCommentId: 123,
        path: 'src/example.ts',
        line: 9,
        body: 'Prior finding',
        url: 'https://github.com/acme/widget/pull/12#discussion_r123',
        replies: [],
      },
      addressedByCommit: 'abcdef1234567890',
    });

    assert.equal(
      postedBody,
      [
        '✅ Addressed in [abcdef1](https://github.com/acme/widget/commit/abcdef1234567890).',
        '',
        '<!-- jbot-review:addressed -->',
      ].join('\n'),
    );
  });
});
