import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyPriorJbotThread,
  formatPriorJbotThreadsForPrompt,
  isBotAddressedReply,
  postAddressedThreadReply,
  type PriorJbotThread,
} from '../src/shared/github.ts';

describe('isBotAddressedReply', () => {
  it('counts the addressed marker only from the bot itself', () => {
    const marker = 'done\n\n<!-- jbot-review:addressed -->';
    assert.equal(isBotAddressedReply('jbot', marker, 'jbot'), true);
    // A PR author copying the hidden marker must NOT close the finding.
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
