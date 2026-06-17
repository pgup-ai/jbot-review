import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatPriorJbotThreadsForPrompt,
  postAddressedThreadReply,
  type PriorJbotThread,
} from '../src/shared/github.ts';

describe('formatPriorJbotThreadsForPrompt', () => {
  it('includes human thread replies so declined suggestions are not re-raised', () => {
    const thread: PriorJbotThread = {
      id: 'PRRT_example',
      isResolved: false,
      replyToCommentId: 3376207111,
      path: 'src/components/agreements/new-agreement/utils.ts',
      line: 207,
      body: [
        '**P3** - Safe access pattern on chartAccount',
        '',
        'Consider using `line.chartAccount?.id ?? ""`.',
        '',
        '<!-- jbot-review:finding -->',
      ].join('\n'),
      url: 'https://github.com/integral-xyz/fms-frontend/pull/1748#discussion_r3376207111',
      replies: [
        {
          author: 'jingbof',
          body: [
            'Not applied: `chartAccount` is required on `OrderLineDto`, and the backend contract test covers it.',
          ].join('\n'),
          url: 'https://github.com/integral-xyz/fms-frontend/pull/1748#discussion_r3376239403',
        },
      ],
    };

    const prompt = formatPriorJbotThreadsForPrompt([thread]);

    assert.match(prompt, /Thread replies:/);
    assert.match(prompt, /jingbof:/);
    assert.match(prompt, /Not applied: `chartAccount` is required/);
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
      replyToCommentId: 3376207111,
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
