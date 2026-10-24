import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyProviderRejection,
  planModelFallback,
  withModelFallback,
  type ModelRejection,
} from '../src/shared/model-fallback.ts';
import type { ReviewBackend } from '../src/shared/session-concurrency.ts';

const PRIVACY =
  "Upstream request failed: This Go model trains on request data. Allow paid endpoints that train on request data in your workspace's Privacy settings to use it.";

describe('classifyProviderRejection', () => {
  it('names the observed permanent rejections and leaves transient failures alone', () => {
    assert.equal(classifyProviderRejection(new Error(PRIVACY)), 'privacy-setting');
    for (const message of [
      'commandcode review-retry exited 10 (usage exceeded): Error: Insufficient credits for Command Code.',
      'CommandCode monthly plan credits exhausted for all reachable keys.',
      'Your credit balance is too low to access the Anthropic API.',
    ])
      assert.equal(classifyProviderRejection(new Error(message)), 'credits', message);
    assert.equal(
      classifyProviderRejection(
        "commandcode review exited 4: Error: 403 meta/muse-spark-1.3-contributor is not available in your region per Meta's Geographic Use Policy.",
      ),
      'region',
    );
    for (const message of [
      'opencode review-retry prompt stopped on a provider rate limit: Upstream request failed: Endpoint is unavailable. (attempt 4, next in 9s)',
      'main-review timed out after 600s',
      '401 Unauthorized',
    ])
      assert.equal(classifyProviderRejection(new Error(message)), undefined, message);
  });
});

describe('planModelFallback', () => {
  const pool = ['go/deepseek', 'go/glm', 'cc/muse'];

  it('moves a rejected main model to the next pool model and keeps an unaffected aux', () => {
    assert.deepEqual(
      planModelFallback(pool, { model: 'cc/muse', auxModel: 'go/glm' }, [
        { model: 'cc/muse', rejection: 'region' },
      ]),
      {
        model: 'go/deepseek',
        auxModel: 'go/glm',
        fallbacks: [{ role: 'main', model: 'cc/muse', rejection: 'region', to: 'go/deepseek' }],
      },
    );
  });

  it('excludes every model on a provider whose credits ran out', () => {
    const credits: ModelRejection[] = [{ model: 'go/deepseek', rejection: 'credits' }];
    assert.deepEqual(
      planModelFallback(pool, { model: 'go/deepseek', auxModel: 'go/glm' }, credits),
      {
        model: 'cc/muse',
        auxModel: 'cc/muse',
        fallbacks: [
          { role: 'main', model: 'go/deepseek', rejection: 'credits', to: 'cc/muse' },
          { role: 'auxiliary', model: 'go/glm', rejection: 'credits', to: 'cc/muse' },
        ],
      },
    );
  });

  it('gives up when every pool model is out or nothing drawn was rejected', () => {
    assert.equal(
      planModelFallback(pool, { model: 'cc/muse', auxModel: 'cc/muse' }, [
        { model: 'cc/muse', rejection: 'region' },
        { model: 'go/glm', rejection: 'credits' },
      ]),
      undefined,
    );
    assert.equal(
      planModelFallback(pool, { model: 'go/glm', auxModel: 'go/glm' }, [
        { model: 'cc/muse', rejection: 'region' },
      ]),
      undefined,
    );
  });
});

describe('withModelFallback', () => {
  const backend = (name: string, calls: string[], fail?: string) =>
    ({
      name,
      runChangesSinceLastReview: async (model: string) => {
        calls.push(model);
        if (fail) throw new Error(fail);
        return model;
      },
      runGuidelineComplianceCheck: async (...args: unknown[]) => {
        calls.push(`${String(args[0])} ${JSON.stringify(args[6])}`);
        return [];
      },
      abortSessionsByLabel: () => {
        calls.push(`abort ${name}`);
        return 1;
      },
    }) as unknown as ReviewBackend;

  it('reroutes a rejected aux model once, without its options, and skips it afterwards', async () => {
    const calls: string[] = [];
    const rejections: ModelRejection[] = [];
    const wrapped = withModelFallback(
      backend('aux', calls, PRIVACY),
      'go/muse',
      { backend: backend('main', calls), model: 'go/deepseek' },
      (rejection) => rejections.push(rejection),
    );
    assert.equal(await wrapped.runChangesSinceLastReview('go/muse', '', () => {}), 'go/deepseek');
    assert.equal(await wrapped.runChangesSinceLastReview('go/muse', '', () => {}), 'go/deepseek');
    await wrapped.runGuidelineComplianceCheck('go/muse', '', '', () => {}, 1, undefined, {
      reasoningEffort: 'low',
    });
    wrapped.abortSessionsByLabel!('guideline-compliance', () => {});
    assert.deepEqual(calls, [
      'go/muse',
      'go/deepseek',
      'go/deepseek',
      'go/deepseek undefined',
      'abort aux',
      'abort main',
    ]);
    assert.deepEqual(rejections, [{ model: 'go/muse', rejection: 'privacy-setting' }]);
  });

  it('keeps failing open on errors the fallback model would share', async () => {
    for (const fail of ['Insufficient credits for Command Code.', 'socket hang up']) {
      const calls: string[] = [];
      const wrapped = withModelFallback(
        backend('aux', calls, fail),
        'cc/muse',
        { backend: backend('main', calls), model: 'cc/deepseek' },
        () => assert.fail('no fallback'),
      );
      await assert.rejects(wrapped.runChangesSinceLastReview('cc/muse', '', () => {}));
      assert.deepEqual(calls, ['cc/muse']);
    }
  });
});
