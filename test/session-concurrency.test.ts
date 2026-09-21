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
  it('rotates paged auxiliary passes ahead of optional bookkeeping without delaying verification', async () => {
    const slots = new Semaphore(1);
    const release = await slots.acquire();
    const order: string[] = [];
    const backend = limitReviewBackendSessions(
      {
        ...makeBackend(),
        runReview: async (_m, context) => {
          order.push(context);
          return { summary: '', findings: [] };
        },
        runGuidelineComplianceCheck: async (_m, context) => {
          order.push(context);
          return [];
        },
        runFindingVerification: async () => {
          order.push('verify');
          return [];
        },
        runChangesSinceLastReview: async () => {
          order.push('summary');
          return '';
        },
      },
      'aux',
      slots,
    );
    const queued = [
      backend.runChangesSinceLastReview('m', '', noLog),
      ...[1, 2, 3].map((n) =>
        backend.runGuidelineComplianceCheck('m', `guideline-${n}`, '', noLog),
      ),
      ...[1, 2].map((n) =>
        backend.runReview('m', `interaction-${n}`, '', noLog, { label: 'review-interactions' }),
      ),
      backend.runReview('m', 'security', '', noLog, { label: 'review-security' }),
      backend.runFindingVerification('m', '', [], noLog),
    ];
    release();
    await Promise.all(queued);
    assert.deepEqual(order, [
      'verify',
      'guideline-1',
      'interaction-1',
      'security',
      'guideline-2',
      'interaction-2',
      'guideline-3',
      'summary',
    ]);
    assert.equal(slots.isBusy(), false);
  });
  it('keeps verification capacity at both queues while auxiliary pages are still active', async () => {
    for (const sharedProvider of [true, false]) {
      const global = new Semaphore(3, true);
      const provider = createProviderSessionLimiters(['test'], () => 2).forProvider('test');
      let finish!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const backend = limitReviewBackendSessions(
        makeBackend(async () => {
          started();
          await blocked;
        }),
        'aux',
        global,
        sharedProvider ? provider : undefined,
      );
      const first = backend.runReview('m', '', '', noLog);
      await running;
      const next = backend.runReview('m', '', '', noLog);
      await backend.runFindingVerification('m', '', [], noLog);
      assert.equal(global.isBusy(), true, 'verification must not wait for auxiliary completion');
      finish();
      await Promise.all([first, next]);
      assert.equal(global.isBusy(), false);
      assert.equal((provider as Semaphore).isBusy(), false);
    }
  });

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

  it('acquires verification slots ahead of main and auxiliary work', async () => {
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

    assert.deepEqual(priorities, ['verification', 'verification', 'normal', 'normal']);
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
      finalizeSessionsByLabel: (label: string, _log: unknown, budgetMs: number) => {
        aborted.push(`finalize:${label}:${budgetMs}`);
        return 1;
      },
    };
    const limited = limitReviewBackendSessions(backend, 'aux', {
      acquire: async () => () => undefined,
    });

    assert.equal(limited.canReadWorkspace, true);
    limited.abortSessionsByLabel?.('review-frontend', () => {});
    assert.equal(
      limited.finalizeSessionsByLabel?.('review-frontend', () => {}, 60_000),
      1,
    );
    assert.deepEqual(aborted, ['review-frontend', 'finalize:review-frontend:60000']);
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
      const rejected = assert.rejects(pending, /stopped while queued/);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(backend.abortSessionsByLabel?.('abandoned', noLog), 1);
      await rejected;
      assert.equal(started, 0);
      release();
      await backend.runReview('model', 'ctx', '', noLog, { label: 'abandoned' });
      assert.equal(started, 1);
      assert.equal(provider.isBusy(), false);
      assert.equal(global.isBusy(), false);
      await backend.runFindingVerification('model', 'ctx', [], noLog);
      assert.equal(global.isBusy(), false);
    }
  });

  it('passes the verifier model options through the limiter', async () => {
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

  it('bounds a lens after queueing and cancels at the run deadline', async () => {
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
      throw new Error('Cancellation failed');
    };
    const limited = limitReviewBackendSessions(backend, 'aux', slots);
    const call = limited.runReview('model', '', '', noLog, {
      label: 'review-interactions',
      timeoutMs: 20,
    });
    const rejected = assert.rejects(call, /timed out; timeout cancellation failed/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(started, false);
    release();
    await rejected;
    assert.equal(started, true);
    assert.deepEqual(aborted, ['review-interactions']);
    let replacementStarted = false;
    const replacement = limited.runGuidelineComplianceCheck('model', '', '', noLog).then(() => {
      replacementStarted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(replacementStarted, false);
    finish();
    await replacement;

    for (const label of ['review-interactions', 'review-frontend']) {
      const releaseAgain = await slots.acquire();
      started = false;
      await assert.rejects(
        limited.runReview('model', '', '', noLog, {
          label,
          deadlineAt: Date.now() + 10,
        }),
        /deadline expired/,
      );
      assert.equal(started, false);
      releaseAgain();
      await assert.rejects(
        limited.runReview('model', '', '', noLog, {
          label,
          timeoutMs: 1000,
          deadlineAt: Date.now() + 10,
        }),
        /timed out/,
      );
      assert.equal(started, true);
      assert.equal(aborted.at(-1), label);
      finish();
    }
    const fast = makeBackend();
    const observedTimeouts: Array<number | undefined> = [];
    const run = fast.runReview;
    fast.runReview = async (...args) => {
      observedTimeouts.push(args[4]?.timeoutMs);
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
    await limitReviewBackendSessions(fast, 'aux', undefined).runReview('model', '', '', noLog, {
      label: 'review-interactions',
    });
    // No lens-specific clamp: the runway floor and run deadline bound every lens alike.
    assert.deepEqual(observedTimeouts, [10, 1_200_000, undefined]);
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

describe('Semaphore', () => {
  it('gives auxiliary pages a turn before main drains and leaves room for verification', async () => {
    for (const limit of [2, 3, 5]) {
      const slots = new Semaphore(limit, true);
      const activeMain = await Promise.all(
        Array.from({ length: limit }, () => slots.acquire('high')),
      );
      let nextMainStarted = false;
      const nextMain = slots.acquire('high').then((release) => {
        nextMainStarted = true;
        return release;
      });
      const auxiliary = slots.acquire('normal');
      activeMain.shift()!();
      const releaseAuxiliary = await auxiliary;
      assert.equal(nextMainStarted, false, 'main backlog must not starve the first auxiliary');
      activeMain.shift()!();
      (await nextMain)();
      activeMain.forEach((release) => release());
      const otherAuxiliary = await Promise.all(
        Array.from({ length: limit - 2 }, () => slots.acquire('normal')),
      );
      const abort = new AbortController();
      const queued = slots.acquire('normal', abort.signal);
      const rejected = assert.rejects(queued, /cancelled/);
      const releaseVerifier = await slots.acquire('verification');
      assert.equal(slots.isBusy(), true);
      abort.abort(new Error('cancelled'));
      await rejected;
      releaseVerifier();
      releaseAuxiliary();
      otherAuxiliary.forEach((release) => release());
      assert.equal(slots.isBusy(), false);
    }
  });

  it('alternates main and auxiliary work on serial providers, with verification first', async () => {
    const slots = new Semaphore(1, true);
    const release = await slots.acquire('high');
    const order: string[] = [];
    const pending = (['high', 'high', 'normal', 'normal', 'verification'] as const).map(
      async (priority) => {
        const done = await slots.acquire(priority);
        order.push(priority);
        done();
      },
    );
    release();
    await Promise.all(pending);
    assert.deepEqual(order, ['verification', 'normal', 'high', 'normal', 'high']);
    assert.equal(slots.isBusy(), false);
  });

  it('treats 0 as unlimited and frees one slot per acquisition even when released twice', async () => {
    await Promise.all([new Semaphore(0).acquire(), new Semaphore(0).acquire()]);
    const one = new Semaphore(1);
    const releaseA = await one.acquire();
    let b: (() => void) | undefined;
    let c: (() => void) | undefined;
    const waitB = one.acquire().then((release) => (b = release));
    const waitC = one.acquire().then((release) => (c = release));
    releaseA();
    releaseA();
    await waitB;
    assert.ok(b);
    assert.equal(c, undefined, 'a double release must not admit a second waiter');
    b!();
    await waitC;
    assert.ok(c);
  });
});
