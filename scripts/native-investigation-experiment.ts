import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  COMMANDCODE_MODEL_LIMITS,
  runCommandCodeReview,
  writeCommandCodeAuth,
  writeCommandCodeReadOnlySettings,
} from '../src/shared/commandcode.ts';
import { GIT_DIFF_ARGS } from '../src/shared/git.ts';
import {
  assembleReviewPrompt,
  EXPLORATION_CHECKPOINT,
  withCommandCodeToolsDirective,
} from '../src/shared/prompt.ts';
import { measureReviewPrompt, reviewPromptBudget } from '../src/shared/review-plan.ts';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  workspace: string;
  base: string;
  head: string;
  model: string;
  effort: string;
  repetitions: number;
  timeoutMs?: number;
  output: string;
  arms: Array<'control' | 'reuse'>;
};
if (
  !Number.isInteger(plan.repetitions) ||
  plan.repetitions < 1 ||
  !plan.arms.length ||
  plan.arms.some((arm) => !['control', 'reuse'].includes(arm))
)
  throw new Error('Expected positive repetitions and control/reuse arms');
const workspace = resolve(plan.workspace);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trimEnd();
if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== git('rev-parse', plan.head))
  throw new Error('Experiment requires a clean checkout at the requested head');
const key = process.env.COMMANDCODE_ACCESS_KEY?.split(',')[0].trim();
if (!key) throw new Error('COMMANDCODE_ACCESS_KEY is required');
const context = execFileSync(
  'git',
  ['-C', workspace, ...GIT_DIFF_ARGS, `${plan.base}...${plan.head}`],
  { encoding: 'utf8' },
);
const modelID = plan.model.replace(/^commandcode\//, '');
const budget = reviewPromptBudget('commandcode', COMMANDCODE_MODEL_LIMITS[modelID.toLowerCase()]);
for (const arm of plan.arms) {
  if (
    !measureReviewPrompt(
      withCommandCodeToolsDirective(
        assembleReviewPrompt(
          context,
          '',
          arm === 'reuse' ? EXPLORATION_CHECKPOINT : '',
          false,
          true,
          { toolsAvailable: true },
        ),
        workspace,
      ),
      budget,
    ).fits
  )
    throw new Error('Fixture exceeds a complete single-page prompt budget');
}
const out = resolve(plan.output);
mkdirSync(out, { mode: 0o700 });
writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify(
    {
      ...plan,
      base: git('rev-parse', plan.base),
      head: git('rev-parse', plan.head),
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sourceDiffHash: createHash('sha256')
        .update(execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8' }))
        .digest('hex'),
      scriptHash: createHash('sha256')
        .update(readFileSync(new URL(import.meta.url)))
        .digest('hex'),
      diffHash: createHash('sha256').update(context).digest('hex'),
      cliVersion: execFileSync('command-code', ['--version'], { encoding: 'utf8' }).trim(),
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
const home = mkdtempSync(join(tmpdir(), 'jbot-investigation-'));
try {
  writeCommandCodeAuth(key, home);
  writeCommandCodeReadOnlySettings(home, workspace);
  for (let pair = 0; pair < plan.repetitions; pair++) {
    for (const arm of pair % 2 ? [...plan.arms].reverse() : plan.arms) {
      const logs: string[] = [];
      const started = Date.now();
      const usage: unknown[] = [];
      try {
        const result = await runCommandCodeReview(
          workspace,
          plan.model,
          context,
          '',
          (line) => {
            logs.push(line);
            if (line.startsWith('CommandCode progress '))
              console.log(JSON.stringify({ arm, pair, progress: line }));
          },
          {
            runtime: { home, tools: true },
            effort: plan.effort,
            embeddedFirstPrompt: true,
            lensAddendum: arm === 'reuse' ? EXPLORATION_CHECKPOINT : '',
            timeoutMs: plan.timeoutMs ?? 300_000,
            onTokenUsage: (value) => {
              usage.push(value);
            },
          },
        );
        if (git('status', '--porcelain')) throw new Error('The model modified the fixture');
        writeFileSync(
          join(out, `${pair}-${arm}.json`),
          JSON.stringify(
            { arm, pair, elapsedMs: Date.now() - started, result, usage, logs },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        console.log(
          JSON.stringify({
            arm,
            pair,
            elapsedMs: Date.now() - started,
            findings: result.findings.length,
          }),
        );
      } catch (error) {
        writeFileSync(
          join(out, `${pair}-${arm}-failed.json`),
          JSON.stringify(
            { arm, pair, elapsedMs: Date.now() - started, error: String(error), logs },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        throw error;
      }
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
