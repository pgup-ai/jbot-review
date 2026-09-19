import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseModelName } from '@symma/protocol';
import { parseGitDiff } from '../src/shared/git.ts';
import { buildDiffHunksBlock } from '../src/shared/diff-context.ts';
import { EvidenceStore, evidenceMode } from '../src/shared/evidence.ts';
import { requestFindingVerdicts } from '../src/shared/runner.ts';
import { startOpencode } from '../src/shared/opencode-server.ts';
import { runFindingVerification } from '../src/shared/opencode.ts';
import { configureOpencodeTelemetry } from '../src/shared/opencode-session.ts';
import { createTelemetryRecorder } from '../src/shared/telemetry.ts';
import { createToolTelemetryAccumulator } from '../src/shared/tool-telemetry.ts';
import type { Finding } from '../src/shared/types.ts';

const [workspace, base, findingsPath] = process.argv.slice(2);
if (!workspace || !base || !findingsPath || !process.env.JBOT_BENCHMARK_OUTPUT)
  throw new Error('Expected workspace, base, findings JSON, and benchmark output');
const findings: Finding[] = JSON.parse(readFileSync(findingsPath, 'utf8'));
const files = parseGitDiff(
  execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', `${base}...HEAD`], {
    cwd: workspace,
    encoding: 'utf8',
  }),
);
const model = process.env.MODEL!;
const { providerID, modelID } = parseModelName(model);
const log = (message: string) => console.log(message);
const telemetry = createTelemetryRecorder(true);
const store = new EvidenceStore(workspace, files, process.env.JBOT_EVIDENCE_DOCS);
const mode = evidenceMode(process.env.JBOT_VERIFICATION_EVIDENCE);
const runtime = await startOpencode(
  workspace,
  providerID,
  modelID,
  process.env.OPENCODE_API_KEY!,
  log,
  {
    modelOptions: { reasoningEffort: 'medium' },
    verificationModelOptions: { reasoningEffort: 'low' },
  },
);
configureOpencodeTelemetry(runtime.client, createToolTelemetryAccumulator(telemetry, randomUUID()));
const started = Date.now();
try {
  const verdicts = await requestFindingVerdicts({
    workspace,
    model,
    targets: findings,
    timeoutMs: 180_000,
    prContext: buildDiffHunksBlock(files),
    modelOptions: { reasoningEffort: 'low' },
    log,
    backend: { runFindingVerification: (...args) => runFindingVerification(runtime, ...args) },
    prepareEvidence: (targets, timeoutMs) =>
      store.prepare('verification', targets, mode, {
        timeoutMs,
        apiKey: process.env.TYPESAFE_API_KEY,
        log,
        onStats: (row) => telemetry.recordJevPrefetch(row),
      }),
    onCoverage: (row) => telemetry.recordCoverage(row),
    onTokenUsage: (usage, model, session = 'finding-verification') =>
      telemetry.recordSession({
        session,
        model,
        promptBytes: usage.promptBytes,
        ...('input' in usage
          ? {
              inputTokens: usage.input,
              outputTokens: usage.output,
              reasoningTokens: usage.reasoning,
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheWrite,
              costUsd: usage.costUsd,
            }
          : {}),
      }),
  });
  writeFileSync(
    process.env.JBOT_BENCHMARK_OUTPUT,
    JSON.stringify(
      {
        findings,
        verdicts,
        elapsedMs: Date.now() - started,
        telemetry: telemetry.toJsonl(),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  runtime.stop();
}
