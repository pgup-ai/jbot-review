// Compiles a repository's written rules into candidate line checks for a maintainer to review and commit.
//   npm run rules:compile -- --workspace /path/to/repo [--out FILE] [--examples labelled.jsonl] [--model provider/model]
// labelled.jsonl: {"check": "no-focused-tests", "path": "a.spec.ts", "text": "it.only('x')", "violation": true}
// Every kept check starts in shadow mode; promote one to "enforce" only after its shadow runs agree.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseModelName } from '@symma/protocol';

import { PROVIDERS } from '../src/shared/config.ts';
import { CLOSED_BOOK_AGENT } from '../src/shared/opencode-config.ts';
import { startOpencode } from '../src/shared/opencode-server.ts';
import { createReviewSession, promptInSession } from '../src/shared/opencode-session.ts';
import { assembleRuleCheckCompilerPrompt } from '../src/shared/prompt.ts';
import { discoverGuidelineDocs, formatGuidelines } from '../src/shared/review-context.ts';
import {
  RULE_CHECKS_PATH,
  validateCompiledChecks,
  type RuleCheckExample,
} from '../src/shared/rule-checks.ts';
import { benchmarkArgument } from './benchmark-args.ts';

const MAX_REPO_FILE_BYTES = 512 * 1024;
const workspace = resolve(benchmarkArgument('workspace') ?? '.');
const out = resolve(benchmarkArgument('out') ?? join(workspace, RULE_CHECKS_PATH));
// A rerun would drop omitted checks and reset promoted ones to shadow.
if (existsSync(out)) throw new Error(`${out} exists; pass --out to draft beside it.`);
const model = benchmarkArgument('model') ?? process.env.MODEL ?? 'deepseek/deepseek-flash';
const examplesPath = benchmarkArgument('examples');
const examples: RuleCheckExample[] = examplesPath
  ? readFileSync(examplesPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RuleCheckExample)
  : [];

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: workspace, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const discovered = await discoverGuidelineDocs(workspace, tracked);
const repoFiles = tracked.flatMap((path) => {
  try {
    const file = join(workspace, path);
    // lstat: a tracked symlink to a device or FIFO would never reach EOF.
    const stat = lstatSync(file);
    return !stat.isFile() || stat.size > MAX_REPO_FILE_BYTES
      ? []
      : [{ path, text: readFileSync(file, 'utf8') }];
  } catch {
    return [];
  }
});

const { providerID, modelID } = parseModelName(model);
const provider = PROVIDERS[providerID];
const apiKey = (provider?.keyEnv && process.env[provider.keyEnv]) || '';
if (!apiKey) throw new Error(`Set ${provider?.keyEnv ?? 'the provider key'} for ${model}.`);
const runtime = await startOpencode(workspace, providerID, modelID, apiKey, console.error, {
  baseURL: provider?.custom && process.env[provider.custom.baseURL.env],
  promptCache: provider?.promptCache,
});
let raw: string;
try {
  const spec = { label: 'rule-check-compiler', model, log: console.error };
  const sessionID = await createReviewSession(runtime, { ...spec, agent: CLOSED_BOOK_AGENT });
  raw = await promptInSession(runtime, sessionID, {
    ...spec,
    text: assembleRuleCheckCompilerPrompt(formatGuidelines(discovered)),
    timeoutMs: 10 * 60_000,
  });
} finally {
  runtime.stop();
}

const start = raw.indexOf('{');
if (start < 0) throw new Error(`The model returned no JSON object:\n${raw.slice(0, 500)}`);
const json = raw.slice(start, raw.lastIndexOf('}') + 1);
const { checks, report } = validateCompiledChecks(json, {
  docs: discovered.docs.map((doc) => doc.text),
  repoFiles,
  examples,
});
// A mistyped label would otherwise leave its check unvalidated and kept.
const unmatched = [
  ...new Set(
    examples
      .map((example) => example.check)
      .filter((id) => !report.some((row) => row.id === id && row.examples)),
  ),
];
if (unmatched.length)
  throw new Error(`--examples name no compiled check: ${unmatched.join(', ')}. Nothing written.`);
for (const row of report)
  console.log(
    `${row.kept ? 'kept    ' : 'rejected'} ${row.id}  existing hits ${row.existingHits}${
      row.examples
        ? `  examples caught ${row.examples.caught} missed ${row.examples.missed} false ${row.examples.falseHits}`
        : ''
    }${row.reason ? `  (${row.reason})` : ''}`,
  );
if (checks.length) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ checks }, null, 2)}\n`);
  console.log(`Wrote ${checks.length} shadow check(s) to ${out}. Review them before committing.`);
} else console.log('No check was kept; nothing written.');
