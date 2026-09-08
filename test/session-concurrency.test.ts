import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createProviderSessionLimiters,
  limitReviewBackendSessions,
  type ReviewBackend,
  type SessionSlots,
} from '../src/shared/session-concurrency.ts';
import { Semaphore, type SemaphorePriority } from '../src/shared/opencode.ts';
import { createPhaseTelemetryTracker, createTelemetryRecorder } from '../src/shared/telemetry.ts';
import { createToolTelemetryAccumulator } from '../src/shared/tool-telemetry.ts';

const noLog = (): void => undefined;

function makeBackend(onReview: () => void | Promise<void> = () => undefined): ReviewBackend {
  return {
    name: 'fake',
    runReview: async () => {
      await onReview();
      return { summary: 'ok', findings: [], addressedPriorComments: [] };
    },
    runAddressedPriorCommentsCheck: async () => [],
    runGuidelineComplianceCheck: async () => [],
    runFindingVerification: async () => [],
    runChangesSinceLastReview: async () => 'summary',
  };
}

describe('limitReviewBackendSessions', () => {
  it('owns provider slots independently for mixed-provider runs', () => {
    const limiters = createProviderSessionLimiters(['nvidia', 'openai', 'nvidia'], (providerID) =>
      providerID === 'nvidia' ? 1 : undefined,
    );

    assert.deepEqual(limiters.configured, [{ providerID: 'nvidia', limit: 1 }]);
    assert.ok(limiters.forProvider('nvidia'));
    assert.equal(limiters.forProvider('openai'), undefined);
  });

  it('gives main sessions priority over auxiliary sessions', async () => {
    const priorities: SemaphorePriority[] = [];
    const slots: SessionSlots = {
      acquire: async (priority = 'normal') => {
        priorities.push(priority);
        return () => undefined;
      },
    };

    const main = makeBackend();
    main.supportsGuidelineSweep = true;
    const limited = limitReviewBackendSessions(main, 'main', slots);
    assert.equal(limited.supportsGuidelineSweep, true);
    await limited.runReview('model', 'context', '', noLog);
    await limitReviewBackendSessions(makeBackend(), 'aux', slots).runReview(
      'model',
      'context',
      '',
      noLog,
    );

    assert.deepEqual(priorities, ['high', 'normal']);
  });

  it('acquires verification slots at high priority even on the aux backend', async () => {
    const priorities: SemaphorePriority[] = [];
    const slots: SessionSlots = {
      acquire: async (priority = 'normal') => {
        priorities.push(priority);
        return () => undefined;
      },
    };
    const aux = limitReviewBackendSessions(makeBackend(), 'aux', slots, slots);

    await aux.runFindingVerification('model', 'context', [], noLog);
    await aux.runGuidelineComplianceCheck('model', 'context', '', noLog);

    assert.deepEqual(priorities, ['high', 'high', 'normal', 'normal']);
  });

  it('preserves backend capabilities and the abort handle through the limiter (TASK-076)', () => {
    const aborted: string[] = [];
    const backend = {
      ...makeBackend(),
      canReadWorkspace: true,
      abortSessionsByLabel: (label: string) => {
        aborted.push(label);
        return 1;
      },
    };
    const limited = limitReviewBackendSessions(backend, 'aux', {
      acquire: async () => () => undefined,
    });

    assert.equal(limited.canReadWorkspace, true);
    limited.abortSessionsByLabel?.('review-frontend', () => {});
    assert.deepEqual(aborted, ['review-frontend']);
  });

  it('cancels waiters at either queue without launching or leaking a slot', async () => {
    for (const blockedQueue of ['provider', 'global']) {
      const provider = new Semaphore(1);
      const global = new Semaphore(1);
      const release = await (blockedQueue === 'provider' ? provider : global).acquire();
      let started = 0;
      const backend = limitReviewBackendSessions(
        makeBackend(() => {
          started++;
        }),
        'aux',
        global,
        provider,
      );
      const pending = backend.runReview('model', 'ctx', '', noLog, { label: 'abandoned' });
      const rejected = assert.rejects(pending, /aborted while queued/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(backend.abortSessionsByLabel?.('abandoned', noLog), 1);
      await rejected;
      assert.equal(started, 0);
      release();
      await backend.runReview('model', 'ctx', '', noLog, { label: 'abandoned' });
      assert.equal(started, 1);
      assert.equal(provider.isBusy(), false);
      assert.equal(global.isBusy(), false);
    }
  });

  it('passes the verifier model options through the limiter (TASK-157)', async () => {
    const seen: unknown[] = [];
    const backend = makeBackend();
    backend.runFindingVerification = async (...args) => {
      seen.push(args[6]);
      return [];
    };
    const limited = limitReviewBackendSessions(backend, 'aux', {
      acquire: async () => () => undefined,
    });

    await limited.runFindingVerification('model', 'context', [], noLog, undefined, undefined, {
      reasoningEffort: 'medium',
    });

    assert.deepEqual(seen, [{ reasoningEffort: 'medium' }]);
  });

  it('takes and hands off a provider slot before the global slot', async () => {
    const events: string[] = [];
    const slots = (name: string): SessionSlots => ({
      acquire: async () => {
        events.push(`${name}:acquire`);
        return () => events.push(`${name}:release`);
      },
    });
    const backend = limitReviewBackendSessions(
      makeBackend(() => events.push('backend')),
      'main',
      slots('global'),
      slots('provider'),
    );

    await backend.runReview('model', 'context', '', noLog);

    assert.deepEqual(events, [
      'provider:acquire',
      'global:acquire',
      'backend',
      'provider:release',
      'global:release',
    ]);
  });

  it('keeps a queued provider-limited main session ahead of auxiliary work', async () => {
    const globalSlots = new Semaphore(1);
    const providerSlots = new Semaphore(1);
    const order: string[] = [];
    let mainRun = 0;
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const main = limitReviewBackendSessions(
      makeBackend(async () => {
        mainRun += 1;
        order.push(`main-${mainRun}`);
        if (mainRun === 1) {
          signalFirstStarted();
          await firstBlocked;
        }
      }),
      'main',
      globalSlots,
      providerSlots,
    );
    const aux = limitReviewBackendSessions(
      makeBackend(() => order.push('aux')),
      'aux',
      globalSlots,
    );

    const first = main.runReview('model', 'context', '', noLog);
    await firstStarted;
    const second = main.runReview('model', 'context', '', noLog);
    const auxiliary = aux.runReview('model', 'context', '', noLog);
    releaseFirst();
    await Promise.all([first, second, auxiliary]);

    assert.deepEqual(order, ['main-1', 'main-2', 'aux']);
  });

  it('bounds interactions after queueing and cancels at the run deadline', async () => {
    const slots = new Semaphore(1);
    const release = await slots.acquire();
    let started = false;
    let finish!: () => void;
    const aborted: string[] = [];
    const backend = makeBackend(async () => {
      started = true;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    backend.abortSessionsByLabel = (label) => {
      aborted.push(label);
      finish();
      return 1;
    };
    const limited = limitReviewBackendSessions(backend, 'aux', slots);
    const call = limited.runReview('model', '', '', noLog, {
      label: 'review-interactions',
      timeoutMs: 20,
    });
    const rejected = assert.rejects(call, /timed out/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(started, false);
    release();
    await rejected;
    assert.equal(started, true);
    assert.deepEqual(aborted, ['review-interactions']);
    const releaseAgain = await slots.acquire();
    started = false;
    await assert.rejects(
      limited.runReview('model', '', '', noLog, {
        label: 'review-interactions',
        deadlineAt: Date.now() + 10,
      }),
      /deadline expired/,
    );
    assert.equal(started, false);
    releaseAgain();
    const fast = makeBackend();
    const observedTimeouts: number[] = [];
    const run = fast.runReview;
    fast.runReview = async (...args) => {
      observedTimeouts.push(args[4]!.timeoutMs!);
      return run(...args);
    };
    fast.abortSessionsByLabel = () => {
      throw new Error('Completed session was aborted');
    };
    await limitReviewBackendSessions(fast, 'aux', undefined).runReview('model', '', '', noLog, {
      label: 'review-interactions',
      timeoutMs: 10,
    });
    await limitReviewBackendSessions(fast, 'aux', undefined).runReview('model', '', '', noLog, {
      label: 'review-interactions',
      timeoutMs: 1_200_000,
    });
    assert.deepEqual(observedTimeouts, [10, 600_000]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('emits complete queue/execution terminal rows on success and timeout', async () => {
    const recorder = createTelemetryRecorder(true);
    const telemetry = {
      phases: createPhaseTelemetryTracker(recorder),
      tools: createToolTelemetryAccumulator(recorder, 'salt'),
    };
    await limitReviewBackendSessions(
      makeBackend(),
      'main',
      undefined,
      undefined,
      telemetry,
    ).runReview('model', 'context', '', noLog, { label: 'success' });
    const timeoutBackend = makeBackend(() => {
      throw new Error('prompt timed out');
    });
    await assert.rejects(
      limitReviewBackendSessions(timeoutBackend, 'aux', undefined, undefined, telemetry).runReview(
        'model',
        'context',
        '',
        noLog,
        { label: 'timeout' },
      ),
      /timed out/,
    );

    const phases = recorder
      .toJsonl()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.kind === 'phase');
    assert.deepEqual(
      phases.map((row) => [row.session, row.phase, row.stopReason]),
      [
        ['success', 'main-queue', 'completed'],
        ['success', 'main-execution', 'completed'],
        ['timeout', 'auxiliary-queue', 'completed'],
        ['timeout', 'auxiliary-execution', 'timeout'],
      ],
    );
  });
});
