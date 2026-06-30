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
      cursorApiKey: '',
      codexAuth: '',
      clineAuth: '',
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
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
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
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
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
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
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
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
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
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('skips OpenCode when both main and aux sessions use CommandCode', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'commandcode',
        modelID: 'default',
        apiKey: 'commandcode-key',
        auxProviderID: 'commandcode',
        auxModelID: 'Qwen/Qwen3.7-Max',
      }),
      {
        mainCliBackend: 'commandcode',
        auxCliBackend: 'commandcode',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: 'commandcode-key',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        opencodeProviderID: 'commandcode',
        opencodeModelID: 'Qwen/Qwen3.7-Max',
        opencodeApiKey: '',
      },
    );
  });

  it('uses Cursor for main review and OpenCode for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'cursor',
        modelID: 'gpt-5',
        apiKey: 'cursor-key',
        auxApiKey: 'opencode-key',
      }),
      {
        mainCliBackend: 'cursor',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: 'cursor-key',
        codexAuth: '',
        clineAuth: '',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });

  it('uses OpenCode for main review and Cursor for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        auxProviderID: 'cursor',
        auxModelID: 'gpt-5',
        auxApiKey: 'cursor-key',
      }),
      {
        auxCliBackend: 'cursor',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: 'cursor-key',
        codexAuth: '',
        clineAuth: '',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('skips OpenCode when both main and aux sessions use Cursor', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'cursor',
        modelID: 'gpt-5',
        apiKey: 'cursor-key',
        auxProviderID: 'cursor',
        auxModelID: 'sonnet-4-thinking',
      }),
      {
        mainCliBackend: 'cursor',
        auxCliBackend: 'cursor',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: 'cursor-key',
        codexAuth: '',
        clineAuth: '',
        opencodeProviderID: 'cursor',
        opencodeModelID: 'sonnet-4-thinking',
        opencodeApiKey: '',
      },
    );
  });

  it('routes keys when main and aux sessions use different CLI backends', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'cursor',
        modelID: 'gpt-5',
        apiKey: 'cursor-key',
        auxProviderID: 'commandcode',
        auxModelID: 'default',
        auxApiKey: 'commandcode-key',
      }),
      {
        mainCliBackend: 'cursor',
        auxCliBackend: 'commandcode',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: 'commandcode-key',
        cursorApiKey: 'cursor-key',
        codexAuth: '',
        clineAuth: '',
        opencodeProviderID: 'commandcode',
        opencodeModelID: 'default',
        opencodeApiKey: 'commandcode-key',
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
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        opencodeProviderID: 'commandcode',
        opencodeModelID: 'default',
        opencodeApiKey: 'commandcode-key',
      },
    );
  });

  it('uses Codex for main review and OpenCode for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'codex',
        modelID: 'default',
        apiKey: 'codex-auth',
        auxApiKey: 'opencode-key',
      }),
      {
        mainCliBackend: 'codex',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: 'codex-auth',
        clineAuth: '',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });

  it('uses OpenCode for main review and Codex for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        auxProviderID: 'codex',
        auxModelID: 'default',
        auxApiKey: 'codex-auth',
      }),
      {
        auxCliBackend: 'codex',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: 'codex-auth',
        clineAuth: '',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('skips OpenCode when both main and aux sessions use Codex', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'codex',
        modelID: 'default',
        apiKey: 'codex-auth',
        auxProviderID: 'codex',
        auxModelID: 'gpt-5.1-codex',
      }),
      {
        mainCliBackend: 'codex',
        auxCliBackend: 'codex',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: 'codex-auth',
        clineAuth: '',
        opencodeProviderID: 'codex',
        opencodeModelID: 'gpt-5.1-codex',
        opencodeApiKey: '',
      },
    );
  });

  it('uses Cline for main review and OpenCode for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'cline',
        modelID: 'default',
        apiKey: 'cline-auth',
        auxApiKey: 'opencode-key',
      }),
      {
        mainCliBackend: 'cline',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: 'cline-auth',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });

  it('uses OpenCode for main review and Cline for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        auxProviderID: 'cline',
        auxModelID: 'default',
        auxApiKey: 'cline-auth',
      }),
      {
        auxCliBackend: 'cline',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: 'cline-auth',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('skips OpenCode when both main and aux sessions use Cline', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'cline',
        modelID: 'default',
        apiKey: 'cline-auth',
        auxProviderID: 'cline',
        auxModelID: 'deepseek-v4-flash',
      }),
      {
        mainCliBackend: 'cline',
        auxCliBackend: 'cline',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: 'cline-auth',
        opencodeProviderID: 'cline',
        opencodeModelID: 'deepseek-v4-flash',
        opencodeApiKey: '',
      },
    );
  });

  it('routes Cline-pass (subscription mode) through the shared cline backend', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'cline-pass',
        modelID: 'default',
        apiKey: 'cline-auth',
        auxApiKey: 'opencode-key',
      }),
      {
        mainCliBackend: 'cline',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: 'cline-auth',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });
});
