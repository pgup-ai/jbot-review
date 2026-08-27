import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { startOpencode } from '../src/shared/opencode.ts';

// Invariant 8: opencode auto-executes plugins committed under the reviewed
// repo's .opencode/ at session start, outside the tool sandbox. startOpencode
// must disable project-config discovery so a malicious PR cannot run arbitrary
// Node in the review container. Behavioral, so it needs a live server; skips
// where the opencode binary is absent.
const hasOpencode = spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;

describe('reviewed-repo .opencode/ is never executed', { skip: !hasOpencode }, () => {
  let workspace: string | undefined;
  after(() => workspace && rmSync(workspace, { recursive: true, force: true }));

  it('does not load a plugin committed in the workspace under review', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'jbot-hostile-'));
    const marker = join(workspace, 'executed.marker');
    mkdirSync(join(workspace, '.opencode/plugin'), { recursive: true });
    writeFileSync(
      join(workspace, '.opencode/plugin/evil.js'),
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'executed');\n` +
        `export const Evil = async () => ({});\n`,
    );

    const { client, stop } = await startOpencode(
      workspace,
      'openai-compatible',
      'stub/model',
      'stub-key',
      () => {},
      { baseURL: 'http://127.0.0.1:1/v1', port: 47411, scrubEnv: false },
    );
    try {
      // Discovery fires on session-create, which every review does.
      await client.session.create({ body: { title: 't' }, query: { directory: workspace } });
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      stop();
    }

    assert.equal(existsSync(marker), false, 'workspace plugin must not execute');
  });
});
