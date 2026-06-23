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
      needsOpencode: true,
      devinApiKey: '',
      commandCodeAccessKey: '',
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
        mainCliBackend: 'devin',
        needsOpencode: true,
        devinApiKey: 'devin-key',
        commandCodeAccessKey: '',
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
        auxCliBackend: 'devin',
        needsOpencode: true,
        devinApiKey: 'devin-key',
        commandCodeAccessKey: '',
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
        mainCliBackend: 'devin',
        auxCliBackend: 'devin',
        needsOpencode: false,
        devinApiKey: 'devin-key',
        commandCodeAccessKey: '',
        opencodeProviderID: 'devin',
        opencodeModelID: 'codex',
        opencodeApiKey: '',
      },
    );
  });

  it('uses CommandCode for main review and OpenCode for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'commandcode',
        modelID: 'default',
        apiKey: 'commandcode-key',
        auxApiKey: 'opencode-key',
      }),
      {
        mainCliBackend: 'commandcode',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: 'commandcode-key',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });

  it('uses OpenCode for main review and CommandCode for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        auxProviderID: 'commandcode',
        auxModelID: 'default',
        auxApiKey: 'commandcode-key',
      }),
      {
        auxCliBackend: 'commandcode',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: 'commandcode-key',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('skips OpenCode when main and aux sessions use different CLI backends', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'devin',
        modelID: 'glm-5.2',
        apiKey: 'devin-key',
        auxProviderID: 'commandcode',
        auxModelID: 'default',
        auxApiKey: 'commandcode-key',
      }),
      {
        mainCliBackend: 'devin',
        auxCliBackend: 'commandcode',
        needsOpencode: false,
        devinApiKey: 'devin-key',
        commandCodeAccessKey: 'commandcode-key',
        opencodeProviderID: 'commandcode',
        opencodeModelID: 'default',
        opencodeApiKey: 'commandcode-key',
      },
    );
  });
});
