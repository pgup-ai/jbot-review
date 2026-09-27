import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { startOpencodeJudge } from '../src/shared/semantic-judge.ts';

it('removes its workspace and rethrows when the judge server fails to boot', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'jbot-boot-'));
  const saved = { TMPDIR: process.env.TMPDIR, JBOT_OPENCODE_BIN: process.env.JBOT_OPENCODE_BIN };
  process.env.TMPDIR = tmp;
  process.env.JBOT_OPENCODE_BIN = join(tmp, 'missing-opencode');
  try {
    await assert.rejects(startOpencodeJudge('openai/gpt-5', 1), /missing-opencode/);
    assert.deepEqual(
      readdirSync(tmp).filter((name) => name.startsWith('jbot-judge-')),
      [],
    );
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});
