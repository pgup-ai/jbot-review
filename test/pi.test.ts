import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PI_MIN_NODE_VERSION,
  PI_SESSION_TOOLS,
  extractPiFinalText,
  mapPiUsage,
  piProviderIDFor,
  piRuntimeSupported,
  piSupportsProvider,
  piThinkingLevel,
  resolvePiEngine,
} from '../src/shared/pi.ts';

describe('piSupportsProvider', () => {
  it('accepts every provider in the verified allowlist', () => {
    for (const providerID of [
      'anthropic',
      'openai',
      'google',
      'deepseek',
      'xai',
      'openrouter',
      'fireworks-ai',
      'zai-coding-plan',
      'xiaomi-token-plan-sgp',
    ]) {
      assert.equal(piSupportsProvider(providerID), true, providerID);
    }
  });

  it('rejects providers pi cannot serve', () => {
    // nvidia: our default model is absent from pi's catalog; opencode/opencode-go
    // are opencode's own gateways; CLI backends never route through SDK engines.
    for (const providerID of [
      'nvidia',
      'opencode',
      'opencode-go',
      'kilo',
      'cline',
      'cline-pass',
      'codex',
      'cursor',
      'devin',
      'commandcode',
      'unknown',
      '',
    ]) {
      assert.equal(piSupportsProvider(providerID), false, providerID);
    }
  });
});

describe('piProviderIDFor', () => {
  it('maps renamed providers and passes the rest through', () => {
    assert.equal(piProviderIDFor('fireworks-ai'), 'fireworks');
    assert.equal(piProviderIDFor('zai-coding-plan'), 'zai');
    assert.equal(piProviderIDFor('google'), 'google');
    assert.equal(piProviderIDFor('xiaomi-token-plan-sgp'), 'xiaomi-token-plan-sgp');
  });

  it('returns undefined for unsupported providers', () => {
    assert.equal(piProviderIDFor('nvidia'), undefined);
    assert.equal(piProviderIDFor('opencode'), undefined);
  });
});

describe('piRuntimeSupported', () => {
  it('accepts Node at or above the pi engines floor', () => {
    assert.equal(PI_MIN_NODE_VERSION, '22.19.0');
    assert.equal(piRuntimeSupported('v22.19.0'), true);
    assert.equal(piRuntimeSupported('v24.18.0'), true);
    assert.equal(piRuntimeSupported('22.19.0'), true);
  });

  it('rejects Node below the floor and unparseable versions', () => {
    assert.equal(piRuntimeSupported('v22.18.9'), false);
    assert.equal(piRuntimeSupported('v20.19.6'), false);
    assert.equal(piRuntimeSupported('nonsense'), false);
    assert.equal(piRuntimeSupported(''), false);
  });
});

describe('resolvePiEngine', () => {
  it('enables pi by default on a supported runtime', () => {
    assert.deepEqual(resolvePiEngine({}, 'v24.18.0'), { enabled: true, reason: '' });
    assert.equal(resolvePiEngine({ JBOT_SDK_ENGINE: 'auto' }, 'v24.18.0').enabled, true);
  });

  it('disables pi when the kill switch forces opencode', () => {
    const resolved = resolvePiEngine({ JBOT_SDK_ENGINE: 'opencode' }, 'v24.18.0');
    assert.equal(resolved.enabled, false);
    assert.match(resolved.reason, /JBOT_SDK_ENGINE/);
  });

  it('fails safe to opencode on an unknown kill-switch value', () => {
    const resolved = resolvePiEngine({ JBOT_SDK_ENGINE: 'pi-please' }, 'v24.18.0');
    assert.equal(resolved.enabled, false);
    assert.match(resolved.reason, /JBOT_SDK_ENGINE/);
    assert.match(resolved.reason, /pi-please/);
  });

  it('disables pi on a Node runtime below the engines floor', () => {
    const resolved = resolvePiEngine({}, 'v20.19.6');
    assert.equal(resolved.enabled, false);
    assert.match(resolved.reason, /22\.19/);
  });
});

describe('piThinkingLevel', () => {
  it('maps reasoningEffort onto pi thinking levels', () => {
    assert.equal(piThinkingLevel({ reasoningEffort: 'medium' }), 'medium');
    assert.equal(piThinkingLevel({ reasoningEffort: 'xhigh' }), 'xhigh');
  });

  it('ignores absent or non-pi values', () => {
    assert.equal(piThinkingLevel(undefined), undefined);
    assert.equal(piThinkingLevel({}), undefined);
    assert.equal(piThinkingLevel({ reasoningEffort: 'turbo' }), undefined);
    assert.equal(piThinkingLevel({ reasoningEffort: 3 }), undefined);
  });
});

describe('PI_SESSION_TOOLS', () => {
  // pi has no sandbox or permission layer, so a shell is an unenforceable
  // boundary: the toolset itself is the enforcement.
  it('grants read-only inspection tools only — no shell, no mutation', () => {
    assert.deepEqual([...PI_SESSION_TOOLS], ['read', 'grep', 'find', 'ls']);
    for (const forbidden of ['bash', 'write', 'edit', 'patch', 'webfetch']) {
      assert.ok(!PI_SESSION_TOOLS.includes(forbidden), `must not grant ${forbidden}`);
    }
  });
});

describe('mapPiUsage', () => {
  it('maps pi usage fields onto PromptTokenUsage', () => {
    assert.deepEqual(
      mapPiUsage({ input: 10, output: 4, cacheRead: 7, cacheWrite: 2, cost: { total: 0.25 } }),
      { input: 10, output: 4, reasoning: 0, cacheRead: 7, cacheWrite: 2, costUsd: 0.25 },
    );
  });

  it('accepts the *Tokens field spellings', () => {
    assert.deepEqual(mapPiUsage({ inputTokens: 3, outputTokens: 1 }), {
      input: 3,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('defaults missing counters to zero and drops non-finite cost', () => {
    assert.deepEqual(mapPiUsage({ cost: { total: Number.NaN } }), {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('returns undefined when there is no usage object', () => {
    assert.equal(mapPiUsage(undefined), undefined);
    assert.equal(mapPiUsage('nope'), undefined);
  });
});

describe('extractPiFinalText', () => {
  it('joins the text blocks of the last assistant message', () => {
    const messages = [
      { role: 'user', content: 'prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first' },
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'second' },
        ],
      },
    ];
    assert.equal(extractPiFinalText(messages), 'first\n\nsecond');
  });

  it('accepts plain-string assistant content and picks the latest assistant', () => {
    const messages = [
      { role: 'assistant', content: 'stale' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: ' final ' },
    ];
    assert.equal(extractPiFinalText(messages), 'final');
  });

  it('returns empty for missing or text-free assistant output', () => {
    assert.equal(extractPiFinalText([]), '');
    assert.equal(extractPiFinalText(undefined), '');
    assert.equal(
      extractPiFinalText([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }]),
      '',
    );
  });
});
