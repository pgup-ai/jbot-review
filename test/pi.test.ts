import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PI_MIN_NODE_VERSION,
  capPiDiffOutput,
  piGitDiffArgs,
  PI_SESSION_TOOLS,
  extractPiFinalText,
  mapPiUsage,
  piProviderIDFor,
  piRuntimeSupported,
  piSupportsProvider,
  piThinkingLevel,
  sumPiUsage,
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

describe('sumPiUsage', () => {
  it('sums usage across every assistant turn of a tool-using prompt', () => {
    const messages = [
      { role: 'user', content: 'go' },
      // Costs are exactly representable in binary, so the summed assertion
      // stays strict without pinning a floating-point artifact.
      { role: 'assistant', content: [], usage: { input: 10, output: 2, cost: { total: 0.25 } } },
      { role: 'tool', content: 'result' },
      {
        role: 'assistant',
        content: 'done',
        usage: { input: 5, cacheRead: 3, cost: { total: 0.5 } },
      },
    ];
    assert.deepEqual(sumPiUsage(messages), {
      input: 15,
      output: 2,
      reasoning: 0,
      cacheRead: 3,
      cacheWrite: 0,
      costUsd: 0.75,
    });
  });

  it('omits cost when no assistant turn reported one', () => {
    assert.deepEqual(sumPiUsage([{ role: 'assistant', content: '', usage: { input: 4 } }]), {
      input: 4,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('returns undefined when no assistant turn carries usage', () => {
    assert.equal(sumPiUsage([{ role: 'assistant', content: 'x' }]), undefined);
    assert.equal(sumPiUsage([{ role: 'user', content: 'x' }]), undefined);
    assert.equal(sumPiUsage([]), undefined);
    assert.equal(sumPiUsage(undefined), undefined);
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

describe('piGitDiffArgs', () => {
  it('uses the three-dot merge-base form on GitHub-backed reviews', () => {
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: false }), ['diff', 'abc123...HEAD']);
  });

  it('diffs merge-base to the working tree in local mode (invariant 7 exception)', () => {
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: true }), ['diff', 'abc123']);
  });

  it('scopes to a path behind -- so a flag-shaped path cannot become an option', () => {
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: false }, '--exec=x'), [
      'diff',
      'abc123...HEAD',
      '--',
      '--exec=x',
    ]);
  });

  it('ignores an empty path', () => {
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: true }, '  '), ['diff', 'abc123']);
  });
});

describe('capPiDiffOutput', () => {
  it('passes short output through untouched', () => {
    assert.equal(capPiDiffOutput('diff --git a b', 100), 'diff --git a b');
  });

  it('truncates long output and tells the model to narrow by path', () => {
    const capped = capPiDiffOutput('x'.repeat(200), 100);
    assert.ok(capped.startsWith('x'.repeat(100)));
    assert.match(capped, /truncated/);
    assert.match(capped, /path/);
  });

  it('caps by bytes, not characters, for multi-byte content', () => {
    // 100 two-byte chars = 200 bytes; a 100-byte cap keeps exactly 50 chars.
    const capped = capPiDiffOutput('\u00e9'.repeat(100), 100);
    assert.ok(capped.startsWith('\u00e9'.repeat(50)));
    assert.ok(!capped.startsWith('\u00e9'.repeat(51)));
  });

  it('drops a multi-byte char split at the byte boundary instead of emitting garbage', () => {
    // 'a' + 49 x 2-byte chars = 99 bytes; byte 100 splits the 50th char.
    const capped = capPiDiffOutput('a' + '\u00e9'.repeat(100), 100);
    assert.ok(capped.startsWith('a' + '\u00e9'.repeat(49) + '\n'));
    assert.ok(!capped.includes('\uFFFD'));
  });
});
