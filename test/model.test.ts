import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDERS } from '../src/shared/config.ts';
import { formatModelName, parseModelName, resolveModelName } from '../src/shared/model.ts';

describe('parseModelName', () => {
  it('keeps the first segment as provider and the remaining path as model id', () => {
    assert.deepEqual(parseModelName('openrouter/google/gemini-2.5-flash'), {
      providerID: 'openrouter',
      modelID: 'google/gemini-2.5-flash',
    });
  });
});

describe('resolveModelName', () => {
  it('treats an unprefixed model as belonging to the selected provider', () => {
    assert.deepEqual(resolveModelName('opencode', 'deepseek-v4-flash-free'), {
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
    });
  });

  it('treats an already selected-provider-prefixed model the same way', () => {
    assert.deepEqual(resolveModelName('opencode', 'opencode/deepseek-v4-flash-free'), {
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
    });
  });

  it('allows provider catalog model ids with slash-containing publisher prefixes', () => {
    assert.deepEqual(resolveModelName('nvidia', 'moonshotai/kimi-k2.6'), {
      providerID: 'nvidia',
      modelID: 'moonshotai/kimi-k2.6',
    });
  });

  it('formats resolved models into the canonical provider/model id string', () => {
    assert.equal(
      formatModelName(resolveModelName('nvidia', 'moonshotai/kimi-k2.6')),
      'nvidia/moonshotai/kimi-k2.6',
    );
  });

  it('normalizes every configured provider default without changing provider selection', () => {
    for (const [providerID, cfg] of Object.entries(PROVIDERS)) {
      const resolved = resolveModelName(providerID, cfg.defaultModel);

      assert.equal(resolved.providerID, providerID);
      assert.notEqual(resolved.modelID, '');
      assert.equal(formatModelName(resolved), cfg.defaultModel);
    }
  });

  it('rejects an empty selected-provider-prefixed model id', () => {
    assert.throws(() => resolveModelName('opencode', 'opencode/'), /expected a non-empty model id/);
  });
});
