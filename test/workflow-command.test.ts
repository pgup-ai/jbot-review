import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/jbot-review.yml', import.meta.url),
  'utf8',
);
const commandStep = workflow
  .split('\n      - name: Parse /jbot command\n')[1]
  ?.split('\n      - name: Require same-repo PR head\n')[0];
const commandScript = commandStep
  ?.split('\n        run: |\n')[1]
  ?.split('\n')
  .map((line) => line.replace(/^ {10}/, ''))
  .join('\n');

assert.ok(commandScript);

function parseCommand(comment: string): {
  status: number | null;
  output: Record<string, string>;
  log: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'jbot-command-'));
  const outputPath = join(dir, 'output');
  writeFileSync(outputPath, '');
  try {
    const result = spawnSync('/bin/bash', ['-c', commandScript], {
      encoding: 'utf8',
      env: {
        COMMENT_BODY: comment,
        GITHUB_OUTPUT: outputPath,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      },
    });
    const output = Object.fromEntries(
      readFileSync(outputPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    return {
      status: result.status,
      output,
      log: `${result.stdout}${result.stderr}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('/jbot command', () => {
  it('accepts explicit auto approval with provider and model overrides', () => {
    const result = parseCommand('/jbot --provider=devin --model=devin/glm-5.2 --auto-approve=true');

    assert.equal(result.status, 0);
    assert.deepEqual(result.output, {
      provider: 'devin',
      model: 'devin/glm-5.2',
      auto_approve: 'true',
    });
  });

  it('treats the bare flag as true and supports an explicit false override', () => {
    assert.equal(parseCommand('/jbot --auto-approve').output.auto_approve, 'true');
    assert.equal(parseCommand('/jbot --auto-approve=false').output.auto_approve, 'false');
    assert.equal(parseCommand('/jbot').output.auto_approve, '');
  });

  it('rejects non-boolean auto-approve values', () => {
    const result = parseCommand('/jbot --auto-approve=1');

    assert.notEqual(result.status, 0);
    assert.match(result.log, /--auto-approve expects true or false/);
  });
});
