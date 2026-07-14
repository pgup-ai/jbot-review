import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  limitReviewBackendSessions,
  type ReviewBackend,
  type SessionSlots,
} from '../src/shared/session-concurrency.ts';
import type { SemaphorePriority } from '../src/shared/opencode.ts';

const noLog = (): void => undefined;

function makeBackend(events: string[] = []): ReviewBackend {
  return {
    name: 'fake',
    runReview: async () => {
      events.push('backend');
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

  it('takes a provider slot before a global slot and releases in reverse order', async () => {
    const events: string[] = [];
    const slots = (name: string): SessionSlots => ({
      acquire: async () => {
        events.push(`${name}:acquire`);
        return () => events.push(`${name}:release`);
      },
    });
    const backend = limitReviewBackendSessions(
      makeBackend(events),
      'main',
      slots('global'),
      slots('provider'),
    );

    await backend.runReview('model', 'context', '', noLog);

    assert.deepEqual(events, [
      'provider:acquire',
      'global:acquire',
      'backend',
      'global:release',
      'provider:release',
    ]);
  });
});
