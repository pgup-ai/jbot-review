import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PI_MIN_NODE_VERSION,
  capPiDiffOutput,
  piGitDiffArgs,
  resolveWithinWorkspace,
  extractPiFinalText,
  mapPiUsage,
  piModelCandidates,
  piProviderIDFor,
  piRuntimeSupported,
  piSupportsProvider,
  piThinkingLevel,
  sumPiUsage,
  piTurnUsageSince,
  resolvePiEngine,
} from '../src/shared/pi.ts';
import { GIT_DIFF_ARGS } from '../src/shared/git.ts';

describe('piSupportsProvider', () => {
  it('accepts every non-CLI jbot provider pi can also serve', () => {
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
      'nvidia',
      'opencode',
      'opencode-go',
    ]) {
      assert.equal(piSupportsProvider(providerID), true, providerID);
    }
  });

  it('rejects CLI-backend and unknown providers', () => {
    // CLI backends never route through an SDK engine; unknowns fail closed.
    for (const providerID of [
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

  it('lists model candidates: bare id then provider-prefixed (NIM namespacing)', () => {
    // jbot config 'nvidia/nemotron-...' parses to the bare stem, but pi's NIM
    // catalog stores it namespaced as 'nvidia/nemotron-...'.
    assert.deepEqual(piModelCandidates('nvidia', 'nemotron-3-ultra-550b-a55b'), [
      'nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3-ultra-550b-a55b',
    ]);
    // Already-namespaced or same-named-catalog ids resolve directly (no prefix).
    assert.deepEqual(piModelCandidates('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b'), [
      'nvidia/nemotron-3-ultra-550b-a55b',
    ]);
    assert.deepEqual(piModelCandidates('fireworks-ai', 'accounts/fireworks/models/x'), [
      'accounts/fireworks/models/x',
    ]);
    // A bare id on any allowlisted provider gets the prefixed fallback too; it
    // simply won't match for providers whose catalog uses bare ids (opencode),
    // where the direct candidate resolves first — harmless, never tried.
    assert.deepEqual(piModelCandidates('opencode', 'deepseek-v4-flash-free'), [
      'deepseek-v4-flash-free',
      'opencode/deepseek-v4-flash-free',
    ]);
    // Off-allowlist: no pi id, so no prefixed candidate.
    assert.deepEqual(piModelCandidates('unknown', 'model'), ['model']);
  });
});

describe('piProviderIDFor', () => {
  it('maps jbot provider ids to pi (renames + gateways); undefined off-list', () => {
    assert.equal(piProviderIDFor('fireworks-ai'), 'fireworks'); // renamed
    assert.equal(piProviderIDFor('zai-coding-plan'), 'zai');
    assert.equal(piProviderIDFor('google'), 'google'); // identity
    assert.equal(piProviderIDFor('nvidia'), 'nvidia');
    assert.equal(piProviderIDFor('opencode'), 'opencode');
    assert.equal(piProviderIDFor('opencode-go'), 'opencode-go');
    assert.equal(piProviderIDFor('kilo'), undefined); // CLI backend
    assert.equal(piProviderIDFor('unknown'), undefined);
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

describe('resolveWithinWorkspace', () => {
  // Security boundary: pi's built-in read tools are unsandboxed, so file access
  // is confined to the repo here. Must follow symlinks (a link inside the
  // checkout can point out), so this is exercised against a real filesystem.
  it('confines to the real workspace and refuses symlink + lexical escapes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'out-')));
    writeFileSync(join(root, 'inside.txt'), 'x');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'evil')); // escapes the repo
    try {
      assert.equal(resolveWithinWorkspace(root, 'inside.txt'), join(root, 'inside.txt'));
      assert.equal(resolveWithinWorkspace(root, 'evil'), undefined); // P0: symlink escape
      assert.equal(resolveWithinWorkspace(root, '/etc/hosts'), undefined); // absolute
      assert.equal(resolveWithinWorkspace(root, '../../etc/hosts'), undefined); // ..
      assert.equal(resolveWithinWorkspace(root, 'missing.txt'), undefined); // non-existent
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('mapPiUsage', () => {
  it('maps usage fields (both spellings) onto PromptTokenUsage', () => {
    assert.deepEqual(
      mapPiUsage({ input: 10, output: 4, cacheRead: 7, cacheWrite: 2, cost: { total: 0.25 } }),
      { input: 10, output: 4, reasoning: 0, cacheRead: 7, cacheWrite: 2, costUsd: 0.25 },
    );
    assert.deepEqual(mapPiUsage({ inputTokens: 3, outputTokens: 1 }), {
      input: 3,
      output: 1,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('defaults missing counters to zero, drops non-finite cost, undefined for no usage', () => {
    assert.deepEqual(mapPiUsage({ cost: { total: Number.NaN } }), {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
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

describe('piTurnUsageSince', () => {
  // Only the slicing is distinct from sumPiUsage (covered above): a reused
  // session bills only the turns after the snapshot, so a JSON repair never
  // double-counts the original prompt's turn.
  it('bills only the turns appended after the snapshot (JSON-repair reuse)', () => {
    const messages = [
      { role: 'assistant', content: 'bad json', usage: { input: 100, output: 40 } },
      { role: 'user', content: 'repair' },
      { role: 'assistant', content: '{}', usage: { input: 10, output: 4, cost: { total: 0.2 } } },
    ];
    assert.deepEqual(piTurnUsageSince(messages, 1), {
      input: 10,
      output: 4,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0.2,
    });
    assert.equal(piTurnUsageSince(messages, 3), undefined); // nothing after the snapshot
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
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: false }), [
      ...GIT_DIFF_ARGS,
      'abc123...HEAD',
    ]);
  });

  it('diffs merge-base to the working tree in local mode (invariant 7 exception)', () => {
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: true }), [
      ...GIT_DIFF_ARGS,
      'abc123',
    ]);
  });

  it('scopes to a path behind -- so a flag-shaped path cannot become an option', () => {
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: false }, '--exec=x'), [
      ...GIT_DIFF_ARGS,
      'abc123...HEAD',
      '--',
      '--exec=x',
    ]);
  });

  it('ignores an empty path', () => {
    assert.deepEqual(piGitDiffArgs({ base: 'abc123', worktree: true }, '  '), [
      ...GIT_DIFF_ARGS,
      'abc123',
    ]);
  });

  it('carries the canonical pins so hunks match the embedded diff and no diff driver runs', () => {
    const args = piGitDiffArgs({ base: 'abc123', worktree: false });
    for (const flag of ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    // `-c` config pins must precede the `diff` subcommand.
    assert.ok(args.indexOf('-c') < args.indexOf('diff'));
  });
});

describe('capPiDiffOutput', () => {
  it('passes short output through untouched', () => {
    assert.equal(capPiDiffOutput('diff --git a b', 100), 'diff --git a b');
  });

  it('truncates long output with a size note', () => {
    const capped = capPiDiffOutput('x'.repeat(200), 100);
    assert.ok(capped.startsWith('x'.repeat(100)));
    assert.match(capped, /truncated/);
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
