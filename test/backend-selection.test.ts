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
      kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
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
        kiloAuth: '',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });

  it('routes Cline-pass as the aux backend with the aux auth', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        auxProviderID: 'cline-pass',
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
        kiloAuth: '',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('routes cline (main) + cline-pass (aux) to the shared backend; main auth wins', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'cline',
        modelID: 'default',
        apiKey: 'cline-auth',
        auxProviderID: 'cline-pass',
        auxModelID: 'default',
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
        kiloAuth: '',
        opencodeProviderID: 'cline-pass',
        opencodeModelID: 'default',
        opencodeApiKey: '',
      },
    );
  });

  it('uses Kilo for main review and OpenCode for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'kilo',
        modelID: 'kilo-auto/free',
        apiKey: 'kilo-auth',
        auxApiKey: 'opencode-key',
      }),
      {
        mainCliBackend: 'kilo',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        kiloAuth: 'kilo-auth',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'opencode-key',
      },
    );
  });

  it('uses OpenCode for main review and Kilo for aux sessions', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...base,
        auxProviderID: 'kilo',
        auxModelID: 'kilo-auto/free',
        auxApiKey: 'kilo-auth',
      }),
      {
        auxCliBackend: 'kilo',
        needsOpencode: true,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        kiloAuth: 'kilo-auth',
        opencodeProviderID: 'opencode',
        opencodeModelID: 'deepseek-v4-flash-free',
        opencodeApiKey: 'main-key',
      },
    );
  });

  it('routes kilo as a main CLI backend and carries kiloAuth (skips OpenCode when aux is also kilo)', () => {
    const sel = selectReviewBackends({
      providerID: 'kilo',
      modelID: 'kilo-auto/free',
      apiKey: 'AUTH_JSON',
      auxProviderID: 'kilo',
      auxModelID: 'kilo-auto/free',
      auxApiKey: '',
    });
    assert.deepEqual(sel, {
      mainCliBackend: 'kilo',
      auxCliBackend: 'kilo',
      needsOpencode: false,
      devinApiKey: '',
      commandCodeAccessKey: '',
      cursorApiKey: '',
      codexAuth: '',
      clineAuth: '',
      kiloAuth: 'AUTH_JSON',
      opencodeProviderID: 'kilo',
      opencodeModelID: 'kilo-auto/free',
      opencodeApiKey: '',
    });
  });
});

describe('selectReviewBackends pi engine routing', () => {
  const noCliKeys = {
    devinApiKey: '',
    commandCodeAccessKey: '',
    cursorApiKey: '',
    codexAuth: '',
    clineAuth: '',
    kiloAuth: '',
  };
  const google = {
    providerID: 'google',
    modelID: 'gemini-2.5-flash',
    apiKey: 'google-key',
    auxProviderID: 'google',
    auxModelID: 'gemini-2.5-flash',
    auxApiKey: '',
  };

  it('routes both SDK roles to pi for an allowlisted provider', () => {
    assert.deepEqual(selectReviewBackends({ ...google, piEnabled: true }), {
      mainSdkEngine: 'pi',
      auxSdkEngine: 'pi',
      needsOpencode: false,
      ...noCliKeys,
      opencodeProviderID: 'google',
      opencodeModelID: 'gemini-2.5-flash',
      opencodeApiKey: '',
      pi: { providerID: 'google', modelID: 'gemini-2.5-flash', apiKey: 'google-key' },
    });
  });

  it('leaves the selection byte-identical to today when piEnabled is omitted', () => {
    assert.deepEqual(selectReviewBackends(google), {
      needsOpencode: true,
      ...noCliKeys,
      opencodeProviderID: 'google',
      opencodeModelID: 'gemini-2.5-flash',
      opencodeApiKey: 'google-key',
    });
  });

  it('splits engines: pi main with an aux pi cannot serve on opencode', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...google,
        auxProviderID: 'some-unsupported-provider',
        auxModelID: 'm',
        auxApiKey: 'aux-key',
        piEnabled: true,
      }),
      {
        mainSdkEngine: 'pi',
        needsOpencode: true,
        ...noCliKeys,
        opencodeProviderID: 'some-unsupported-provider',
        opencodeModelID: 'm',
        opencodeApiKey: 'aux-key',
        pi: { providerID: 'google', modelID: 'gemini-2.5-flash', apiKey: 'google-key' },
      },
    );
  });

  it('routes a pi-capable aux behind a CLI main and skips opencode entirely', () => {
    assert.deepEqual(
      selectReviewBackends({
        providerID: 'kilo',
        modelID: 'kilo-auto/free',
        apiKey: 'kilo-auth',
        auxProviderID: 'google',
        auxModelID: 'gemini-2.5-flash',
        auxApiKey: 'google-key',
        piEnabled: true,
      }),
      {
        mainCliBackend: 'kilo',
        auxSdkEngine: 'pi',
        needsOpencode: false,
        ...noCliKeys,
        kiloAuth: 'kilo-auth',
        opencodeProviderID: 'google',
        opencodeModelID: 'gemini-2.5-flash',
        opencodeApiKey: 'google-key',
        pi: { providerID: 'google', modelID: 'gemini-2.5-flash', apiKey: 'google-key' },
      },
    );
  });

  it('routes nvidia to pi (supported by both → pi first)', () => {
    assert.deepEqual(
      selectReviewBackends({
        providerID: 'nvidia',
        modelID: 'nemotron-3-ultra-550b-a55b',
        apiKey: 'nvidia-key',
        auxProviderID: 'nvidia',
        auxModelID: 'nemotron-3-ultra-550b-a55b',
        auxApiKey: '',
        piEnabled: true,
      }),
      {
        mainSdkEngine: 'pi',
        auxSdkEngine: 'pi',
        needsOpencode: false,
        ...noCliKeys,
        opencodeProviderID: 'nvidia',
        opencodeModelID: 'nemotron-3-ultra-550b-a55b',
        opencodeApiKey: '',
        pi: { providerID: 'nvidia', modelID: 'nemotron-3-ultra-550b-a55b', apiKey: 'nvidia-key' },
      },
    );
  });

  it('routes the opencode Zen gateway to pi when enabled', () => {
    const sel = selectReviewBackends({
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
      apiKey: 'zen-key',
      auxProviderID: 'opencode',
      auxModelID: 'deepseek-v4-flash-free',
      auxApiKey: '',
      piEnabled: true,
    });
    assert.equal(sel.mainSdkEngine, 'pi');
    assert.equal(sel.needsOpencode, false);
    assert.deepEqual(sel.pi, {
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
      apiKey: 'zen-key',
    });
  });

  it('keeps a provider pi cannot serve on opencode even with piEnabled', () => {
    assert.deepEqual(
      selectReviewBackends({
        providerID: 'some-unsupported-provider',
        modelID: 'm',
        apiKey: 'k',
        auxProviderID: 'some-unsupported-provider',
        auxModelID: 'm',
        auxApiKey: '',
        piEnabled: true,
      }),
      {
        needsOpencode: true,
        ...noCliKeys,
        opencodeProviderID: 'some-unsupported-provider',
        opencodeModelID: 'm',
        opencodeApiKey: 'k',
      },
    );
  });
});
