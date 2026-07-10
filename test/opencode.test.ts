import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildConfig, parseChangesSinceLastReviewSummary } from '../src/shared/opencode.ts';

const noop = () => {};

describe('parseChangesSinceLastReviewSummary', () => {
  it('extracts the summary string from a valid object', () => {
    const out = parseChangesSinceLastReviewSummary(
      '{"summary":"- did a thing"}',
      'changes-since',
      noop,
    );
    assert.equal(out, '- did a thing');
  });

  it('returns empty string on unparseable output (fail open, omit the block)', () => {
    const out = parseChangesSinceLastReviewSummary('not json at all', 'changes-since', noop);
    assert.equal(out, '');
  });

  it('returns empty string when summary is missing or not a string', () => {
    assert.equal(parseChangesSinceLastReviewSummary('{"findings":[]}', 'changes-since', noop), '');
    assert.equal(parseChangesSinceLastReviewSummary('{"summary":42}', 'changes-since', noop), '');
  });
});

describe('buildConfig bash permissions', () => {
  // opencode's documented wildcard semantics: `*` matches zero+ chars, `?` exactly one.
  const matches = (pattern: string, command: string): boolean =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    ).test(command);

  const bashRules = (): Record<string, string> => {
    const permission = buildConfig('deepseek', 'deepseek-v4-flash', 'key')?.permission;
    const bash = permission?.bash;
    assert.ok(bash && typeof bash === 'object', 'bash permission must be a rule map');
    return bash as Record<string, string>;
  };

  it('never yields "ask" — an interactive prompt would hang a headless run', () => {
    const rules = bashRules();
    assert.equal(
      rules['*'],
      'allow',
      'a catch-all allow must exist: unmatched commands default to ask',
    );
    assert.ok(!Object.values(rules).includes('ask'));
  });

  it('denies the mutating commands an honest model might reach for', () => {
    const rules = bashRules();
    for (const command of [
      'git commit -m x',
      'git push origin main',
      'git checkout .',
      'git reset --hard HEAD',
      'git clean -fd',
      'git stash push',
      'git restore .',
      'rm -rf src',
    ]) {
      const denied = Object.entries(rules).some(([p, a]) => a === 'deny' && matches(p, command));
      assert.ok(denied, `expected deny for: ${command}`);
    }
  });

  it('leaves the review’s read-only git inspection untouched', () => {
    const rules = bashRules();
    for (const command of [
      'git diff --stat base...head',
      'git log --oneline -20',
      'git grep -n TODO',
      'git show HEAD:src/index.ts',
      'git status --short',
      'git rev-parse HEAD',
      'grep -rn foo src',
    ]) {
      const denied = Object.entries(rules).some(([p, a]) => a === 'deny' && matches(p, command));
      assert.ok(!denied, `must not deny: ${command}`);
    }
  });
});
