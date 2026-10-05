import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

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

it('cancels only the closed PR group and keeps reviews cancellable across entry points', () => {
  assert.match(workflow, /types: \[[^\]\n]*\bclosed\b[^\]\n]*\]/);
  const closeJob = workflow.split('\n  cancel-closed:\n')[1]?.split('\n  command:\n')[0];
  const reviewJob = workflow.split('\n  review:\n')[1];
  assert.ok(closeJob && reviewJob);
  assert.match(closeJob, /permissions: \{\}/);
  assert.doesNotMatch(closeJob, /uses:|secrets\./);
  const closeIf = closeJob.match(/^    if: (.+)/m)![1];
  const reviewIf = reviewJob.match(/\n    if: >-\n([\s\S]*?)\n    # One review/)![1];
  const closeGroup = closeJob.match(/group: (.+)/)![1];
  const reviewGroup = reviewJob.match(/group: (.+)/)![1];
  for (const job of [closeJob, reviewJob]) assert.match(job, /cancel-in-progress: true/);

  for (const number of [12, 34]) {
    for (const eventName of ['pull_request', 'issue_comment', 'workflow_dispatch']) {
      for (const closed of [false, true]) {
        const context = {
          github: {
            event_name: eventName,
            event: {
              action: closed ? 'closed' : 'synchronize',
              pull_request:
                eventName === 'pull_request'
                  ? { number, draft: false, user: { login: 'author' } }
                  : {},
              issue: eventName === 'issue_comment' ? { number } : {},
            },
          },
          inputs: eventName === 'workflow_dispatch' ? { 'pr-number': String(number) } : {},
          needs: { command: { outputs: { proceed: 'true' } } },
          cancelled: () => false,
        };
        const isClose = eventName === 'pull_request' && closed;
        assert.equal(runInNewContext(closeIf, context), isClose);
        assert.equal(runInNewContext(reviewIf, context), !isClose);
        const group = (source: string) =>
          source.replace(/\$\{\{(.+?)\}\}/g, (_, expression: string) =>
            String(runInNewContext(expression, context)),
          );
        assert.equal(group(reviewGroup), `jbot-review-${number}`);
        if (isClose) assert.equal(group(closeGroup), group(reviewGroup));
        assert.equal(runInNewContext(reviewIf, { ...context, cancelled: () => true }), false);
        if (eventName === 'issue_comment') {
          context.needs.command.outputs.proceed = '';
          assert.equal(runInNewContext(reviewIf, context), false);
        }
      }
    }
  }
});
