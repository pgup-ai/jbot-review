import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyPriorJbotThread,
  compactJbotReviewBody,
  formatPriorJbotThreadsForPrompt,
  isBotAddressedReply,
  listPriorJbotThreads,
  minimizePullRequestReview,
  postAddressedThreadReply,
  selectResolvedJbotReviewsToFinalize,
  updateReviewBody,
  type JbotReviewGroup,
  type Octokit,
  type PriorJbotThread,
} from '../src/shared/github.ts';

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

  it('hides the stale body in a details block and preserves review markers', () => {
    const body = compactJbotReviewBody(REVIEW_BODY, 1);
    const pluralBody = compactJbotReviewBody(REVIEW_BODY, 2);

    assert.match(body, /✅ \*\*All 1 review thread resolved\.\*\*/);
    assert.match(pluralBody, /✅ \*\*All 2 review threads resolved\.\*\*/);
    assert.match(body, /<summary>Show original review<\/summary>/);
    assert.match(body, /Review state:\*\* Needs changes before approval/);
    assert.equal(body.match(/jbot-review:review/g)?.length, 1);
    assert.equal(body.match(/jbot-review:compacted/g)?.length, 1);
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

  it('keeps resolved addressed threads in their review group after omitting prompt context', async () => {
    const listReviews = {};
    const listReviewComments = {};
    const octokit = {
      rest: { pulls: { listReviews, listReviewComments } },
      paginate: async (endpoint: unknown) => {
        if (endpoint === listReviews) {
          return [
            {
              id: 77,
              node_id: 'PRR_77',
              user: { login: 'github-actions[bot]' },
              body: REVIEW_BODY,
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
          ];
        }
        throw new Error('unexpected pagination endpoint');
      },
      graphql: async () => ({
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
                        pullRequestReview: { isMinimized: true },
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
              ],
            },
          },
        },
      }),
    };

    const result = await listPriorJbotThreads(octokit as unknown as Octokit, 'acme', 'widget', 1);

    assert.deepEqual(result.threads, []);
    assert.deepEqual(result.unresolvedAddressedThreadIds, []);
    assert.deepEqual(result.reviewGroups, [
      {
        id: 77,
        nodeId: 'PRR_77',
        body: REVIEW_BODY,
        isMinimized: true,
        threads: [{ id: 'PRRT_resolved', isResolved: true }],
      },
    ]);
  });
});

describe('formatPriorJbotThreadsForPrompt', () => {
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
