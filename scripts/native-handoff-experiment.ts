import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  COMMANDCODE_MODEL_LIMITS,
  runCommandCodeFindingVerification,
  runCommandCodeReview,
  writeCommandCodeAuth,
  writeCommandCodeReadOnlySettings,
} from '../src/shared/commandcode.ts';
import { buildFindingSourceContext, readTrackedSource } from '../src/shared/finding-context.ts';
import { GIT_DIFF_ARGS } from '../src/shared/git.ts';
import {
  assembleFindingVerificationPrompt,
  assembleReviewPrompt,
  withCommandCodeToolsDirective,
} from '../src/shared/prompt.ts';
import { measureReviewPrompt, reviewPromptBudget } from '../src/shared/review-plan.ts';
import type { Finding } from '../src/shared/types.ts';
import {
  investigationOverlap,
  nativeEvidenceHandoff,
  nativeInvestigationTrace,
} from './native-investigation-evidence.ts';

const plan = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  workspace: string;
  base: string;
  head: string;
  model: string;
  effort: string;
  repetitions: number;
  timeoutMs: number;
  output: string;
  additionalCandidates: Finding[];
};
if (
  !Number.isInteger(plan.repetitions) ||
  plan.repetitions < 1 ||
  !Array.isArray(plan.additionalCandidates)
)
  throw new Error('Expected positive repetitions and an additionalCandidates array');
const workspace = resolve(plan.workspace);
const git = (...args: string[]) =>
  execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trimEnd();
const head = git('rev-parse', plan.head);
const assertSnapshot = () => {
  if (git('rev-parse', 'HEAD') !== head || git('status', '--porcelain', '--untracked-files=all'))
    throw new Error('Experiment requires the unchanged, clean requested checkout');
};
assertSnapshot();
const key = process.env.COMMANDCODE_ACCESS_KEY?.split(',')[0].trim();
if (!key) throw new Error('COMMANDCODE_ACCESS_KEY is required');
const context = execFileSync('git', ['-C', workspace, ...GIT_DIFF_ARGS, `${plan.base}...${head}`], {
  encoding: 'utf8',
});
const budget = reviewPromptBudget(
  'commandcode',
  COMMANDCODE_MODEL_LIMITS[plan.model.replace(/^commandcode\//, '').toLowerCase()],
);
const checkBudget = (prompt: string) => {
  if (!measureReviewPrompt(withCommandCodeToolsDirective(prompt, workspace), budget).fits)
    throw new Error('Complete assembled fixture prompt exceeds the single-page budget');
};
checkBudget(assembleReviewPrompt(context, '', '', false, true, { toolsAvailable: true }));
const out = resolve(plan.output);
mkdirSync(out, { mode: 0o700 });
const save = (name: string, data: unknown) =>
  writeFileSync(join(out, `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
save('manifest', {
  ...plan,
  head,
  base: git('rev-parse', plan.base),
  diffHash: hash(context),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceDiffHash: hash(execFileSync('git', ['diff', 'HEAD'])),
  experimentHashes: Object.fromEntries(
    ['native-handoff-experiment.ts', 'native-investigation-evidence.ts'].map((name) => [
      name,
      hash(readFileSync(new URL(name, import.meta.url))),
    ]),
  ),
  cliVersion: execFileSync('command-code', ['--version'], { encoding: 'utf8' }).trim(),
});
const home = mkdtempSync(join(tmpdir(), 'jbot-handoff-'));
const sources = new Map<string, string>();
const tracked = new Set(git('ls-files', '-z').split('\0'));
const seenTranscripts = new Set<string>();
let logs: string[] = [];
let usage: unknown[] = [];
async function readTrace() {
  const root = join(home, '.commandcode', 'projects');
  let transcript = '';
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || seenTranscripts.has(path)) continue;
    seenTranscripts.add(path);
    if (statSync(path).size > 16 * 1024 * 1024)
      throw new Error('Transcript exceeds experiment limit');
    transcript += readFileSync(path, 'utf8') + '\n';
  }
  for (const line of transcript.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
    for (const block of entry.message.content ?? []) {
      if (block.type !== 'tool_use' || block.name !== 'read_file') continue;
      const raw = block.input?.file_path ?? block.input?.path;
      if (typeof raw !== 'string') continue;
      const path = relative(workspace, resolve(workspace, raw));
      if (!tracked.has(path) || sources.has(path)) continue;
      const source = await readTrackedSource(workspace, path, AbortSignal.timeout(4000), {
        tracked,
      });
      if (source && !source.truncated) sources.set(path, source.text);
    }
  }
  return nativeInvestigationTrace(transcript, workspace, sources);
}
try {
  writeCommandCodeAuth(key, home);
  writeCommandCodeReadOnlySettings(home, workspace);
  const log = (line: string) => {
    logs.push(line);
  };
  const onTokenUsage = (value: unknown) => {
    usage.push(value);
  };
  let started = Date.now();
  const review = await runCommandCodeReview(workspace, plan.model, context, '', log, {
    runtime: { home, tools: true },
    effort: plan.effort,
    embeddedFirstPrompt: true,
    timeoutMs: plan.timeoutMs,
    onTokenUsage,
  });
  assertSnapshot();
  const reviewElapsedMs = Date.now() - started;
  const reviewTrace = await readTrace();
  save('review', { result: review, elapsedMs: reviewElapsedMs, usage, logs, trace: reviewTrace });
  console.log(
    JSON.stringify({
      stage: 'review',
      elapsedMs: reviewElapsedMs,
      findings: review.findings.length,
      readCalls: reviewTrace.reads.length,
    }),
  );
  const findings = [...review.findings, ...plan.additionalCandidates];
  if (!findings.length) throw new Error('No candidates to verify');
  const preparedAt = Date.now();
  const verifierContext = context + '\n\n' + (await buildFindingSourceContext(workspace, findings));
  const handoff = nativeEvidenceHandoff(reviewTrace, findings, sources, head);
  if (!handoff.context) throw new Error('No supported relevant native reads to hand off');
  save('handoff', {
    ...handoff,
    findings,
    preparationMs: Date.now() - preparedAt,
    sourceContextBytes: Buffer.byteLength(verifierContext) - Buffer.byteLength(context),
  });
  for (let pair = 0; pair < plan.repetitions; pair++) {
    for (const arm of pair % 2 ? ['handoff', 'control'] : ['control', 'handoff']) {
      assertSnapshot();
      logs = [];
      usage = [];
      started = Date.now();
      const input =
        arm === 'handoff' ? verifierContext + '\n\n' + handoff.context : verifierContext;
      checkBudget(assembleFindingVerificationPrompt(input, findings));
      try {
        const verdicts = await runCommandCodeFindingVerification(
          workspace,
          plan.model,
          input,
          findings,
          log,
          plan.timeoutMs,
          onTokenUsage,
          { home, tools: true },
          plan.effort,
        );
        const elapsedMs = Date.now() - started;
        assertSnapshot();
        const trace = await readTrace();
        const overlap = investigationOverlap(reviewTrace, trace);
        save(`${pair}-${arm}`, {
          pair,
          arm,
          elapsedMs,
          verdicts,
          usage,
          logs,
          trace,
          overlap,
          handoffBytes: arm === 'handoff' ? Buffer.byteLength(handoff.context) : 0,
        });
        console.log(
          JSON.stringify({
            pair,
            arm,
            elapsedMs,
            verdicts: verdicts?.map((v) => v.verdict),
            overlap,
          }),
        );
        if (!verdicts || verdicts.length !== findings.length)
          throw new Error('Incomplete verification response');
      } catch (error) {
        save(`${pair}-${arm}-failed`, { pair, arm, error: String(error), logs, usage });
        throw error;
      }
    }
  }
} catch (error) {
  save('failure', { error: String(error), logs, usage });
  throw error;
} finally {
  rmSync(home, { recursive: true, force: true });
}
