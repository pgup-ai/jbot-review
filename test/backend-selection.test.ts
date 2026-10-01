import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertImageSupportsModels,
  backendCanReadWorkspace,
  backendRequiresCompleteEmbeddedDiff,
  selectReviewBackends,
  swallowedProviderWarnings,
} from '../src/shared/backend-selection.ts';

describe('backendCanReadWorkspace', () => {
  it('requires complete diffs for every checkout-blind route', () => {
    assert.equal(backendCanReadWorkspace('opencode', undefined), true);
    assert.equal(backendCanReadWorkspace('devin', 'devin'), true);
    assert.equal(backendCanReadWorkspace('cline', 'cline'), false);
    assert.equal(backendCanReadWorkspace('commandcode', 'commandcode'), false);
    assert.equal(backendCanReadWorkspace('poolside', undefined), false);
    for (const backend of ['cline', 'commandcode', 'grok', 'qoder'] as const) {
      assert.equal(backendRequiresCompleteEmbeddedDiff(backend, backend), true);
    }
    assert.equal(backendRequiresCompleteEmbeddedDiff('cline-pass', 'cline'), true);
    for (const model of ['gpt-5', 'gemini-3.1-pro-preview']) {
      assert.equal(backendRequiresCompleteEmbeddedDiff('gmi', undefined, model), true);
    }
    assert.equal(backendRequiresCompleteEmbeddedDiff('openai', undefined, 'gpt-5'), false);
    assert.equal(backendRequiresCompleteEmbeddedDiff('google', undefined, 'gemini-3.1-pro'), false);
    assert.equal(backendRequiresCompleteEmbeddedDiff('gmi', undefined), false);
  });
});

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
      grokAuth: '',
      kiloAuth: '',
      dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
        opencodeProviderID: 'codex',
        opencodeModelID: 'gpt-5.1-codex',
        opencodeApiKey: '',
      },
    );
  });

  it('routes dim through its own CLI backend for either role', () => {
    const mainDim = selectReviewBackends({
      ...base,
      providerID: 'dim',
      modelID: 'dimcode-api-oauth/deepseek-v4-flash',
      apiKey: 'dim-bundle',
      auxApiKey: 'opencode-key',
    });
    assert.equal(mainDim.mainCliBackend, 'dim');
    assert.equal(mainDim.needsOpencode, true);
    assert.equal(mainDim.dimAuth, 'dim-bundle');

    const auxDim = selectReviewBackends({
      ...base,
      auxProviderID: 'dim',
      auxModelID: 'dimcode-api-oauth/deepseek-v4-flash',
      auxApiKey: 'dim-bundle',
    });
    assert.equal(auxDim.auxCliBackend, 'dim');
    assert.equal(auxDim.dimAuth, 'dim-bundle');
    assert.equal(auxDim.opencodeApiKey, 'main-key');
  });

  it('routes Grok Build independently from the xAI API provider', () => {
    const mainGrok = selectReviewBackends({
      ...base,
      providerID: 'grok',
      modelID: 'default',
      apiKey: 'grok-auth',
      auxApiKey: 'opencode-key',
    });
    assert.equal(mainGrok.mainCliBackend, 'grok');
    assert.equal(mainGrok.needsOpencode, true);
    assert.equal(mainGrok.grokAuth, 'grok-auth');
    assert.equal(mainGrok.opencodeApiKey, 'opencode-key');

    const auxGrok = selectReviewBackends({
      ...base,
      auxProviderID: 'grok',
      auxModelID: 'default',
      auxApiKey: 'grok-auth',
    });
    assert.equal(auxGrok.auxCliBackend, 'grok');
    assert.equal(auxGrok.needsOpencode, true);
    assert.equal(auxGrok.grokAuth, 'grok-auth');
    assert.equal(auxGrok.opencodeApiKey, 'main-key');

    assert.deepEqual(
      selectReviewBackends({
        ...base,
        providerID: 'grok',
        modelID: 'default',
        apiKey: 'grok-auth',
        auxProviderID: 'grok',
        auxModelID: 'default',
      }),
      {
        mainCliBackend: 'grok',
        auxCliBackend: 'grok',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        grokAuth: 'grok-auth',
        kiloAuth: '',
        dimAuth: '',
        opencodeProviderID: 'grok',
        opencodeModelID: 'default',
        opencodeApiKey: '',
      },
    );

    assert.equal(selectReviewBackends({ ...base, providerID: 'xai' }).mainCliBackend, undefined);
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: 'kilo-auth',
        dimAuth: '',
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
        grokAuth: '',
        kiloAuth: 'kilo-auth',
        dimAuth: '',
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
      grokAuth: '',
      kiloAuth: 'AUTH_JSON',
      dimAuth: '',
      opencodeProviderID: 'kilo',
      opencodeModelID: 'kilo-auto/free',
      opencodeApiKey: '',
    });
  });

  it('routes Poolside directly without starting OpenCode', () => {
    assert.deepEqual(
      selectReviewBackends({
        providerID: 'poolside',
        modelID: 'laguna-s-2.1',
        apiKey: 'poolside-key',
        auxProviderID: 'poolside',
        auxModelID: 'laguna-xs-2.1',
        auxApiKey: '',
      }),
      {
        mainSdkEngine: 'poolside',
        auxSdkEngine: 'poolside',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
        opencodeProviderID: 'poolside',
        opencodeModelID: 'laguna-xs-2.1',
        opencodeApiKey: '',
      },
    );
  });

  it('requires complete embedded diffs for Poolside and shell-free CLI backends', () => {
    assert.equal(backendRequiresCompleteEmbeddedDiff('poolside', undefined), true);
    for (const backend of ['commandcode', 'grok', 'qoder'] as const) {
      assert.equal(backendRequiresCompleteEmbeddedDiff('other', backend), true);
    }
    assert.equal(backendRequiresCompleteEmbeddedDiff('other', 'cursor'), false);
  });

  it('routes Qoder main and aux sessions through one PAT-backed CLI backend', () => {
    assert.deepEqual(
      selectReviewBackends({
        providerID: 'qoder',
        modelID: 'auto',
        apiKey: 'qoder-token',
        auxProviderID: 'qoder',
        auxModelID: 'efficient',
        auxApiKey: '',
      }),
      {
        mainCliBackend: 'qoder',
        auxCliBackend: 'qoder',
        needsOpencode: false,
        devinApiKey: '',
        commandCodeAccessKey: '',
        cursorApiKey: '',
        codexAuth: '',
        clineAuth: '',
        grokAuth: '',
        kiloAuth: '',
        dimAuth: '',
        qoderToken: 'qoder-token',
        opencodeProviderID: 'qoder',
        opencodeModelID: 'efficient',
        opencodeApiKey: '',
      },
    );
  });

  it('uses the auxiliary PAT when only aux sessions run on Qoder', () => {
    const selection = selectReviewBackends({
      ...base,
      auxProviderID: 'qoder',
      auxModelID: 'efficient',
      auxApiKey: 'aux-qoder-token',
    });
    assert.equal(selection.auxCliBackend, 'qoder');
    assert.equal(selection.qoderToken, 'aux-qoder-token');
    assert.equal(selection.needsOpencode, true);
  });
});

describe('selectReviewBackends dsh engine routing', () => {
  const noCliKeys = {
    devinApiKey: '',
    commandCodeAccessKey: '',
    cursorApiKey: '',
    codexAuth: '',
    clineAuth: '',
    grokAuth: '',
    kiloAuth: '',
    dimAuth: '',
  };
  const go = {
    providerID: 'opencode-go',
    modelID: 'deepseek-v4.1-flash',
    apiKey: 'go-key',
    auxProviderID: 'opencode-go',
    auxModelID: 'deepseek-v4.1-flash',
    auxApiKey: '',
  };
  const dsh = { providerID: 'opencode-go', modelID: 'deepseek-v4.1-flash', apiKey: 'go-key' };

  it('routes both SDK roles to dsh for an opencode gateway', () => {
    assert.deepEqual(selectReviewBackends({ ...go, dshEnabled: true }), {
      mainSdkEngine: 'dsh',
      auxSdkEngine: 'dsh',
      needsOpencode: false,
      ...noCliKeys,
      opencodeProviderID: 'opencode-go',
      opencodeModelID: 'deepseek-v4.1-flash',
      opencodeApiKey: '',
      dsh,
    });
  });

  it('leaves the selection on opencode when dshEnabled is omitted', () => {
    assert.deepEqual(selectReviewBackends(go), {
      needsOpencode: true,
      ...noCliKeys,
      opencodeProviderID: 'opencode-go',
      opencodeModelID: 'deepseek-v4.1-flash',
      opencodeApiKey: 'go-key',
    });
  });

  it('splits engines: dsh main with an aux dsh cannot serve on opencode', () => {
    assert.deepEqual(
      selectReviewBackends({
        ...go,
        auxProviderID: 'google',
        auxModelID: 'gemini-2.5-flash',
        auxApiKey: 'aux-key',
        dshEnabled: true,
      }),
      {
        mainSdkEngine: 'dsh',
        needsOpencode: true,
        ...noCliKeys,
        opencodeProviderID: 'google',
        opencodeModelID: 'gemini-2.5-flash',
        opencodeApiKey: 'aux-key',
        dsh,
      },
    );
  });

  it('routes a dsh aux behind a CLI main and skips opencode entirely', () => {
    assert.deepEqual(
      selectReviewBackends({
        providerID: 'kilo',
        modelID: 'kilo-auto/free',
        apiKey: 'kilo-auth',
        auxProviderID: 'opencode-go',
        auxModelID: 'deepseek-v4.1-flash',
        auxApiKey: 'go-key',
        dshEnabled: true,
      }),
      {
        mainCliBackend: 'kilo',
        auxSdkEngine: 'dsh',
        needsOpencode: false,
        ...noCliKeys,
        kiloAuth: 'kilo-auth',
        opencodeProviderID: 'opencode-go',
        opencodeModelID: 'deepseek-v4.1-flash',
        opencodeApiKey: 'go-key',
        dsh,
      },
    );
  });

  it('keeps providers dsh does not serve on opencode even when enabled', () => {
    for (const providerID of ['google', 'deepseek', 'kimi-code-plan-global', 'openai-compatible']) {
      const selection = selectReviewBackends({
        providerID,
        modelID: 'model',
        apiKey: 'main-key',
        auxProviderID: providerID,
        auxModelID: 'model',
        auxApiKey: '',
        dshEnabled: true,
      });
      assert.equal(selection.mainSdkEngine, undefined);
      assert.equal(selection.needsOpencode, true);
      assert.equal(selection.opencodeApiKey, 'main-key');
    }
  });
});

describe('swallowedProviderWarnings', () => {
  it('flags a CLI-backend id that a pinned provider turned into a model id', () => {
    // `provider: opencode` + `model: devin/glm-5.2` resolves here, then fails at
    // opencode's endpoint with "Model devin/glm-5.2 is not supported".
    const [warning, ...rest] = swallowedProviderWarnings([
      'opencode/deepseek-v4-flash-free',
      'opencode/devin/glm-5.2',
    ]);

    assert.equal(rest.length, 0);
    assert.match(warning, /"opencode\/devin\/glm-5\.2" sends model id "devin\/glm-5\.2"/);
    // No pin is needed to reach this, so the remedy must not assume one.
    assert.match(warning, /To review on "devin", name the model under it instead/);
  });

  it('flags a slashless CLI-backend id too', () => {
    // `provider: opencode` + `model: devin` resolves to `opencode/devin`, which
    // fails the same way as the nested form.
    const [warning] = swallowedProviderWarnings(['opencode/devin']);
    assert.match(warning, /"opencode\/devin" sends model id "devin" to provider "opencode"/);
  });

  it('stays quiet when the provider is itself a CLI backend', () => {
    // devin/codex is a real model, and kilo routes zai/… on purpose — the tool
    // named in the id is where the run is already going, so nothing was swallowed.
    assert.deepEqual(swallowedProviderWarnings(['devin/codex', 'kilo/zai/glm-5.2']), []);
  });

  it('stays quiet for vendor prefixes, which are legitimate catalog ids', () => {
    // Only CLI-backend ids name a tool rather than a vendor. OpenRouter's own
    // default is openrouter/openai/gpt-4o-mini, and nvidia publishes under a
    // vendor prefix — flagging either would be noise on a correct config.
    assert.deepEqual(
      swallowedProviderWarnings([
        'openrouter/openai/gpt-4o-mini',
        'nvidia/moonshotai/kimi-k2.6',
        'kilo/zai/glm-5.2',
        'devin/glm-5.2',
        'opencode/deepseek-v4-flash-free',
      ]),
      [],
    );
  });
});

describe('assertImageSupportsModels', () => {
  it('rejects every omitted local runtime in a mixed slim pool before selection', () => {
    const supported = ['opencode/muse', 'opencode-go/muse', 'anthropic/claude', 'poolside/model'];
    assert.doesNotThrow(() => assertImageSupportsModels(supported, { JBOT_IMAGE_VARIANT: 'slim' }));
    for (const provider of [
      'commandcode',
      'devin',
      'cline',
      'cline-pass',
      'codex',
      'cursor',
      'grok',
      'kilo',
      'qoder',
      'dim',
    ]) {
      const pool = [...supported, `${provider}/model`];
      assert.throws(
        () => assertImageSupportsModels(pool, { JBOT_IMAGE_VARIANT: 'slim' }),
        /slim image does not include.*Use .*:latest \(full\)/,
      );
      assert.doesNotThrow(() => assertImageSupportsModels(pool, {}));
      assert.doesNotThrow(() => assertImageSupportsModels(pool, { JBOT_IMAGE_VARIANT: 'full' }));
      assert.deepEqual(pool, [...supported, `${provider}/model`]);
    }
  });

  it('allows omitted ACP runtimes only when they route to the gateway', () => {
    const env = { JBOT_IMAGE_VARIANT: 'slim', JBOT_ACP_GATEWAY_URL: 'https://gateway.example' };
    assert.doesNotThrow(() =>
      assertImageSupportsModels(['cursor/model', 'codex/model', 'kilo/model'], env),
    );
    assert.throws(() => assertImageSupportsModels(['cline/model'], env), /local runtimes: cline/);
    assert.throws(
      () => assertImageSupportsModels(['cursor/model'], { ...env, JBOT_ACP_GATEWAY_URL: ' ' }),
      /local runtimes: cursor/,
    );
  });
});
