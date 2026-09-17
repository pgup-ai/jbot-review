import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resolveOpencodeBin, startOpencode } from '../src/shared/opencode-server.ts';

const version = spawnSync(resolveOpencodeBin(), ['--version'], { encoding: 'utf8' }).stdout ?? '';
const hasV2 = /opencode v2\./.test(version);

describe('opencode V2 sessions are hermetic', { skip: !hasV2 }, () => {
  it('runs the jbot plugin, ignores the reviewed repo config and plugin, and rejects unauthenticated calls', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'jbot-hermetic-'));
    const projectMarker = join(workspace, 'project-plugin-ran.txt');
    mkdirSync(join(workspace, '.opencode', 'plugins'), { recursive: true });
    writeFileSync(
      join(workspace, '.opencode', 'opencode.json'),
      '{"permissions":[{"action":"edit","resource":"*","effect":"allow"}]}',
    );
    writeFileSync(
      join(workspace, '.opencode', 'plugins', 'probe.js'),
      `import { writeFileSync } from "node:fs";\nexport default { id: "probe", async setup() { writeFileSync(${JSON.stringify(projectMarker)}, "ran"); } };\n`,
    );
    spawnSync('git', ['init', '-q'], { cwd: workspace });
    const runtime = await startOpencode(
      workspace,
      'openai',
      'gpt-5',
      'sk-not-a-real-key',
      () => undefined,
      {
        port: 47_000 + Math.floor(Math.random() * 1000),
      },
    );
    try {
      const session = await runtime.client.session.create({
        location: { directory: workspace },
        agent: 'plan',
        title: 'hermetic',
      });
      assert.ok(session.id.startsWith('ses_'));
      // Plugins load on first use of the registry for a location.
      type Listed = { source?: { path?: string }; state?: { status?: string } };
      const jbotPlugin = (plugins: Listed[]) =>
        plugins.find((entry) =>
          String(entry.source?.path ?? '').endsWith('opencode/plugins/jbot-review.js'),
        );
      let plugins: Listed[] = [];
      for (let i = 0; i < 40 && jbotPlugin(plugins)?.state?.status !== 'active'; i++) {
        const listed = await runtime.client.plugin.list({ location: { directory: workspace } });
        plugins = (
          Array.isArray(listed) ? listed : ((listed as { data?: Listed[] }).data ?? [])
        ) as Listed[];
        if (jbotPlugin(plugins)?.state?.status !== 'active')
          await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(
        jbotPlugin(plugins)?.state?.status,
        'active',
        `jbot plugin must load from the hermetic config home: ${JSON.stringify(plugins)}`,
      );
      assert.equal(
        plugins.some((entry) => String(entry.source?.path ?? '').includes('/.opencode/')),
        false,
      );
      assert.equal(existsSync(projectMarker), false, 'project plugin must not execute');
      const documents = await runtime.client.config.get({ location: { directory: workspace } });
      assert.equal(
        documents.some((d: { path?: string }) =>
          String(d.path ?? '').includes('/.opencode/opencode.json'),
        ),
        false,
      );
      const status = await runtime.client.server.status();
      const anonymous = await fetch(`${status.urls[0]}/api/status`);
      assert.equal(anonymous.status, 401);
    } finally {
      runtime.stop();
    }
  });
});
