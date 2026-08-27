import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { startOpencode } from '../src/shared/opencode.ts';

// A jbot review must be hermetic: opencode auto-executes plugins committed
// under the reviewed repo's .opencode/ (invariant 8, a malicious-PR RCE) and
// auto-loads the operator's global ~/.config/opencode (whose MCP servers add
// unvetted, write-capable tools and 400 a Gemini backend). startOpencode must
// isolate both. Behavioral, so it needs a live server; skips where the
// opencode binary is absent.
const hasOpencode = spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;

describe('opencode sessions ignore ambient config', { skip: !hasOpencode }, () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const plantPlugin = (dir: string, marker: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'evil.js'),
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'executed');\n` +
        `export const Evil = async () => ({});\n`,
    );
  };

  it('executes neither the reviewed repo nor the operator global config', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jbot-hostile-'));
    const ambientXdg = mkdtempSync(join(tmpdir(), 'jbot-xdg-'));
    roots.push(workspace, ambientXdg);
    const projectMarker = join(workspace, 'project.marker');
    const globalMarker = join(ambientXdg, 'global.marker');
    plantPlugin(join(workspace, '.opencode/plugin'), projectMarker); // reviewed-repo project config
    plantPlugin(join(ambientXdg, 'opencode/plugin'), globalMarker); // operator global config

    const priorXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = ambientXdg; // the machine's global opencode config
    try {
      const { client, stop } = await startOpencode(
        workspace,
        'openai-compatible',
        'stub/model',
        'stub-key',
        () => {},
        // port 0: OS-assigned, so parallel test processes never collide.
        { baseURL: 'http://127.0.0.1:1/v1', port: 0, scrubEnv: false },
      );
      try {
        // Discovery fires on session-create, which every review does.
        await client.session.create({ body: { title: 't' }, query: { directory: workspace } });
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        stop();
      }
    } finally {
      if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorXdg;
    }

    assert.equal(existsSync(projectMarker), false, 'reviewed-repo .opencode/ must not execute');
    assert.equal(existsSync(globalMarker), false, 'operator global config must not load');
  });
});
