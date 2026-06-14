import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ensureGitSafeDirectory, type GitConfigCommand } from '../src/shared/git.ts';

describe('ensureGitSafeDirectory', () => {
  it('marks the exact workspace path safe when it is not yet configured', async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const runGitConfig: GitConfigCommand = async (args) => {
      calls.push(args);
      return args.includes('--get-all') ? '/some/other/path\n' : '';
    };

    await ensureGitSafeDirectory('/github/workspace', (msg) => logs.push(msg), runGitConfig);

    assert.deepEqual(calls, [
      ['config', '--global', '--get-all', 'safe.directory'],
      ['config', '--global', '--add', 'safe.directory', '/github/workspace'],
    ]);
    assert.match(logs.join('\n'), /Configured git safe\.directory for \/github\/workspace/);
  });

  it('does not re-add a path that is already marked safe', async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const runGitConfig: GitConfigCommand = async (args) => {
      calls.push(args);
      return args.includes('--get-all') ? '/other\n/github/workspace\n' : '';
    };

    await ensureGitSafeDirectory('/github/workspace', (msg) => logs.push(msg), runGitConfig);

    assert.deepEqual(calls, [['config', '--global', '--get-all', 'safe.directory']]);
    assert.equal(logs.length, 0);
  });

  it('does nothing for an empty workspace path', async () => {
    const calls: string[][] = [];
    const logs: string[] = [];
    const runGitConfig: GitConfigCommand = async (args) => {
      calls.push(args);
      return '';
    };

    await ensureGitSafeDirectory('   ', (msg) => logs.push(msg), runGitConfig);

    assert.equal(calls.length, 0);
    assert.equal(logs.length, 0);
  });

  it('logs and continues when the add fails', async () => {
    const logs: string[] = [];
    const runGitConfig: GitConfigCommand = async (args) => {
      if (args.includes('--get-all')) return '';
      throw new Error('git unavailable');
    };

    await ensureGitSafeDirectory('/repo', (msg) => logs.push(msg), runGitConfig);

    assert.match(logs.join('\n'), /Could not configure git safe\.directory for \/repo/);
    assert.match(logs.join('\n'), /git unavailable/);
  });
});
