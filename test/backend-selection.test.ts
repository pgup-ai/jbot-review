import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectReviewBackends } from '../src/shared/backend-selection.ts';

describe('selectReviewBackends', () => {
  const base = {
    providerID: 'opencode',
    modelID: 'deepseek-v4-flash-free',
    apiKey: 'main-key',
    auxProviderID: 'opencode',
    auxModelID: 'deepseek-v4-flash-free',
    auxApiKey: '',
  };

  it('uses only opencode for default main and aux providers', () => {
    assert.deepEqual(selectReviewBackends(base), {
      mainUsesDevin: false,
      auxUsesDevin: false,
      needsOpencode: true,
      devinApiKey: '',
      opencodeProviderID: 'opencode',
      opencodeModelID: 'deepseek-v4-flash-free',
      opencodeApiKey: 'main-key',
    });
  });

  it('uses Devin for main review and OpenCode for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'devin',
        modelID: 'glm-5.2',
        apiKey: 'devin-key',
        auxApiKey: 'opencode-key',
      }),
      {
        mainUsesDevin: true,
        auxUsesDevin: false,
        needsOpencode: true,
        devinApiKey: 'devin-key',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });

  it('uses OpenCode for main review and Devin for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        auxProviderID: 'devin',
        auxModelID: 'codex',
        auxApiKey: 'devin-key',
      }),
      {
        mainUsesDevin: false,
        auxUsesDevin: true,
        needsOpencode: true,
        devinApiKey: 'devin-key',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('skips OpenCode when both main and aux sessions use Devin', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'devin',
        modelID: 'glm-5.2',
        apiKey: 'devin-key',
        auxProviderID: 'devin',
        auxModelID: 'codex',
      }),
      {
        mainUsesDevin: true,
        auxUsesDevin: true,
        needsOpencode: false,
        devinApiKey: 'devin-key',
        opencodeProviderID: 'devin',
        opencodeModelID: 'codex',
        opencodeApiKey: '',
      },
    );
  });
});
