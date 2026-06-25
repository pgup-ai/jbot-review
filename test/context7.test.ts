import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decideContext7Mode,
  isContext7QuotaError,
  parseContext7Mode,
} from '../src/shared/context7.ts';
import { enableContext7Mcp, formatContext7Error } from '../src/shared/opencode.ts';

describe('parseContext7Mode', () => {
  it('accepts auto, enabled, and disabled values', () => {
    assert.equal(parseContext7Mode(''), 'auto');
    assert.equal(parseContext7Mode('auto'), 'auto');
    assert.equal(parseContext7Mode('true'), 'always');
    assert.equal(parseContext7Mode('on'), 'always');
    assert.equal(parseContext7Mode('false'), 'off');
    assert.equal(parseContext7Mode('off'), 'off');
  });

  it('rejects unknown values', () => {
    assert.throws(() => parseContext7Mode('sometimes'), /Invalid context7 value/);
  });
});

describe('decideContext7Mode', () => {
  const apiKey = 'ctx7sk-test';

  it('skips when disabled even if an external API change is present', () => {
    const decision = decideContext7Mode({
      mode: 'off',
      apiKey,
      files: [{ filename: 'src/openai.ts', patch: '+await openai.responses.create({})' }],
    });

    assert.equal(decision.enabled, false);
    assert.match(decision.reason, /disabled/);
  });

  it('skips when no API key is configured', () => {
    const decision = decideContext7Mode({
      mode: 'auto',
      apiKey: '',
      files: [{ filename: 'src/openai.ts', patch: '+await openai.responses.create({})' }],
    });

    assert.equal(decision.enabled, false);
    assert.match(decision.reason, /no Context7 API key/);
  });

  it('uses an explicit reason when Context7 is forced without a key', () => {
    const decision = decideContext7Mode({
      mode: 'always',
      apiKey: '',
      files: [{ filename: 'src/openai.ts', patch: '+await openai.responses.create({})' }],
    });

    assert.equal(decision.enabled, false);
    assert.match(decision.reason, /explicitly enabled/);
  });

  it('enables for workflow changes in auto mode', () => {
    const decision = decideContext7Mode({
      mode: 'auto',
      apiKey,
      files: [{ filename: '.github/workflows/pr.yml', patch: '+permissions:\n+  checks: read' }],
    });

    assert.equal(decision.enabled, true);
    assert.match(decision.reason, /\.github\/workflows\/pr\.yml/);
  });

  it('enables for external SDK usage in auto mode', () => {
    const decision = decideContext7Mode({
      mode: 'auto',
      apiKey,
      files: [
        {
          filename: 'src/review.ts',
          patch: '+const result = await anthropic.messages.create({ model, messages });',
        },
      ],
    });

    assert.equal(decision.enabled, true);
    assert.match(decision.reason, /src\/review\.ts/);
  });

  it('enables for ORM filter-behavior usage in auto mode', () => {
    // Regression: integral-xyz/fms#3133 used em.nativeUpdate, whose filter
    // behavior jbot got wrong 5x. The auto heuristic must turn docs lookup on
    // for ORM usage, not just dependency-manifest or SaaS-SDK changes.
    const decision = decideContext7Mode({
      mode: 'auto',
      apiKey,
      files: [
        {
          filename: 'libs/modules/src/reconciliation/bank/repository/write.repository.ts',
          patch:
            '+    await this.em.nativeUpdate(BankReconciliation, { id }, { deletedAt: new Date() });',
        },
      ],
    });

    assert.equal(decision.enabled, true);
    assert.match(decision.reason, /write\.repository\.ts/);
  });

  it('skips ordinary business logic in auto mode', () => {
    const decision = decideContext7Mode({
      mode: 'auto',
      apiKey,
      files: [{ filename: 'src/totals.ts', patch: '+return subtotal + tax;' }],
    });

    assert.equal(decision.enabled, false);
    assert.match(decision.reason, /no external API/);
  });
});

describe('isContext7QuotaError', () => {
  it('flags out-of-credit / rate-limit / quota responses', () => {
    for (const msg of [
      'HTTP 402 Payment Required',
      'Error 429: too many requests',
      'Request failed with status code 429',
      'insufficient credits remaining',
      'Context7 quota exceeded',
      'rate limit reached, retry-after 60',
      'usage limit hit',
    ]) {
      assert.equal(isContext7QuotaError(msg), true, msg);
    }
  });

  it('does not flag transient or connection faults', () => {
    for (const msg of [
      'Disconnected',
      'network error: ECONNRESET',
      'timeout after 30s',
      'connect timeout after 429 ms', // 429 as a duration, not an HTTP status
      'read 402 bytes before reset',
    ]) {
      assert.equal(isContext7QuotaError(msg), false, msg);
    }
  });
});

describe('enableContext7Mcp', () => {
  it('formats Context7 errors without a secret argument', () => {
    assert.equal(formatContext7Error(new Error('Disconnected')), 'Disconnected');
    assert.equal(formatContext7Error(new Error('Bad ctx7sk-test')), 'Bad [redacted]');
    assert.equal(formatContext7Error(new Error('Bad CTX7SK-TEST')), 'Bad [redacted]');
  });

  it('returns false and redacts the key when Context7 setup fails', async () => {
    const logs: string[] = [];
    const client = {
      mcp: {
        add: async () => {
          throw new Error('Rejected ctx7sk-test');
        },
        connect: async () => true,
      },
    };

    const enabled = await enableContext7Mcp(client as never, 'ctx7sk-test', (msg) =>
      logs.push(msg),
    );

    assert.equal(enabled, false);
    assert.match(logs.join('\n'), /continuing without it/);
    assert.doesNotMatch(logs.join('\n'), /ctx7sk-test/);
    assert.match(logs.join('\n'), /\[redacted\]/);
  });

  it('disconnects after a partial MCP setup failure', async () => {
    let disconnected = false;
    const client = {
      mcp: {
        add: async () => true,
        connect: async () => {
          throw new Error('connect failed');
        },
        disconnect: async () => {
          disconnected = true;
          return true;
        },
      },
    };

    const enabled = await enableContext7Mcp(client as never, 'ctx7sk-test', () => undefined);

    assert.equal(enabled, false);
    assert.equal(disconnected, true);
  });
});
