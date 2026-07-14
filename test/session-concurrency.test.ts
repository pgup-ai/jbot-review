import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  limitReviewBackendSessions,
  type ReviewBackend,
  type SessionSlots,
} from '../src/shared/session-concurrency.ts';
import { Semaphore, type SemaphorePriority } from '../src/shared/opencode.ts';

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
  it('gives main sessions priority over auxiliary sessions', async () => {
    const priorities: SemaphorePriority[] = [];
    const slots: SessionSlots = {
      acquire: async (priority = 'normal') => {
        priorities.push(priority);
        return () => undefined;
      },
    };

    await limitReviewBackendSessions(makeBackend(), 'main', slots).runReview(
      'model',
      'context',
      '',
      noLog,
    );
    await limitReviewBackendSessions(makeBackend(), 'aux', slots).runReview(
      'model',
      'context',
      '',
      noLog,
    );

    assert.deepEqual(priorities, ['high', 'normal']);
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
});
