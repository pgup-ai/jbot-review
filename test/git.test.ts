import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureGitSafeDirectory, type GitConfigCommand } from '../src/shared/git.ts';

describe('ensureGitSafeDirectory', () => {
  it('marks the exact workspace path safe', async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const runGitConfig: GitConfigCommand = async (args) => {
      calls.push(args);
    };

    await ensureGitSafeDirectory('/github/workspace', (msg) => logs.push(msg), runGitConfig);

    assert.deepEqual(calls, [
      ['config', '--global', '--add', 'safe.directory', '/github/workspace'],
    ]);
    assert.match(logs.join('\n'), /Configured git safe\.directory for \/github\/workspace/);
  });

  it('logs and continues when git config is unavailable', async () => {
    const logs: string[] = [];
    const runGitConfig: GitConfigCommand = async () => {
      throw new Error('git unavailable');
    };

    await ensureGitSafeDirectory('/repo', (msg) => logs.push(msg), runGitConfig);

    assert.match(logs.join('\n'), /Could not configure git safe\.directory for \/repo/);
    assert.match(logs.join('\n'), /git unavailable/);
  });
});
