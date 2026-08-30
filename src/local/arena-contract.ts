import { createHash, randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

import { isNonArrayRecord as isRecord } from '../shared/text.ts';
import {
  VALID_CONFIDENCES,
  VALID_FINDING_KINDS,
  VALID_SEVERITIES,
  type FindingConfidence,
  type FindingKind,
  type Severity,
} from '../shared/types.ts';

export const ARENA_SCHEMA_VERSION = 1;
export const ARENA_MANIFEST_MAX_BYTES = 256 * 1024;

export type ArenaResultStatus = 'completed' | 'skipped' | 'failed';
export type JbotArenaFailureClass = 'timeout' | 'provider' | 'parse' | 'unknown';

export interface ComparisonRepositoryRefV1 {
  repository: string;
  cloneUrl: string;
  ref: string;
  sha: string;
}

export interface ComparisonReviewConfigV1 {
  enhancedContext: true;
  dryRun: true;
  autoApprove: false;
  maxFindings: 0;
  minSeverity: 'nit';
  includePriorComments: false;
  context7Mode: 'auto' | 'always' | 'off';
  guidelinePass: boolean;
  shardCache: false;
  scrubSessionEnv: true;
  auxModelMode: 'same-as-main';
  sdkEngine: 'auto' | 'opencode';
  reviewPasses: number;
  verifyFindings: boolean;
  timeBudgetMinutes: number;
  reviewShards: number;
  dynamicFanout: boolean;
  modelOptions: Record<string, unknown> | null;
  promptCache: boolean;
  skipDocOnly: boolean;
  maxConcurrentSessions: number;
  reviewTelemetry: true;
  evidenceQuotes: boolean;
  contextTrim: boolean;
  embeddedFirstPrompt: boolean;
  guidelineWiden: 'auto' | 'full';
  verifierSlimContext: boolean;
  verifyOverlapGrace: boolean;
}

export interface ComparisonModelV1 {
  index: number;
  model: string;
  provider: string;
  artifactName: string;
}

export interface ComparisonManifestV1 {
  schemaVersion: 1;
  comparisonId: string;
  arena: {
    repository: string;
    prNumber: number;
    commandCommentId: number;
    workflowRunId: number;
    runAttempt: number;
  };
  target: {
    url: string;
    owner: string;
    repository: string;
    prNumber: number;
    title: string;
    body: string;
    base: ComparisonRepositoryRefV1;
    head: ComparisonRepositoryRefV1;
  };
  jbot: {
    commitSha: string;
    imageRef: string;
    imageDigest: string;
  };
  reviewConfig: ComparisonReviewConfigV1;
  models: ComparisonModelV1[];
}

export interface ArenaUsageMetricV1 {
  value: number | null;
  reportingSessions: number;
}

export interface ArenaUsageV1 {
  sessions: number;
  inputTokens: ArenaUsageMetricV1;
  outputTokens: ArenaUsageMetricV1;
  reasoningTokens: ArenaUsageMetricV1;
  cacheReadTokens: ArenaUsageMetricV1;
  cost: {
    usd: number | null;
    source: 'provider' | 'configured-estimate' | 'mixed' | 'unavailable';
    reportingSessions: number;
  };
}

export interface ArenaFindingV1 {
  path: string;
  line: number;
  severity: Severity;
  kind?: FindingKind;
  confidence?: FindingConfidence;
  title: string;
  body: string;
  evidence?: string;
}

export interface JbotArenaOutputV1 {
  schemaVersion: 1;
  status: ArenaResultStatus;
  backend: string | null;
  sdkEngine: string | null;
  resolvedModelOptions: Record<string, unknown> | null;
  reviewMs: number | null;
  usage: ArenaUsageV1;
  review: { summary: string; findings: ArenaFindingV1[] } | null;
  failure: { class: JbotArenaFailureClass; message: string } | null;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\/[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const string = requireString(value, label);
  if (!string.trim()) throw new Error(`${label} must not be empty.`);
  return string;
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  const string = requireString(value, label);
  if (Buffer.byteLength(string, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes.`);
  }
  return string;
}

function requireInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}.`);
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  label: string,
): T {
  if (value !== expected) throw new Error(`${label} must be ${JSON.stringify(expected)}.`);
  return expected;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}.`);
  }
  return value as T;
}

function requireSha(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!SHA_PATTERN.test(sha)) throw new Error(`${label} must be a lowercase 40-character SHA.`);
  return sha;
}

function validateRepositoryRef(value: unknown, label: string): ComparisonRepositoryRefV1 {
  const ref = requireRecord(value, label);
  const repository = requireString(ref.repository, `${label}.repository`);
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error(`${label}.repository must be owner/repo.`);
  }
  const cloneUrl = requireString(ref.cloneUrl, `${label}.cloneUrl`);
  if (cloneUrl !== `https://github.com/${repository}.git`) {
    throw new Error(`${label}.cloneUrl must be the canonical public GitHub clone URL.`);
  }
  return {
    repository,
    cloneUrl,
    ref: requireNonEmptyString(ref.ref, `${label}.ref`),
    sha: requireSha(ref.sha, `${label}.sha`),
  };
}

function validateReviewConfig(value: unknown): ComparisonReviewConfigV1 {
  const config = requireRecord(value, 'comparison.reviewConfig');
  const modelOptions = config.modelOptions;
  if (modelOptions !== null && !isRecord(modelOptions)) {
    throw new Error('comparison.reviewConfig.modelOptions must be an object or null.');
  }
  return {
    enhancedContext: requireLiteral(config.enhancedContext, true, 'reviewConfig.enhancedContext'),
    dryRun: requireLiteral(config.dryRun, true, 'reviewConfig.dryRun'),
    autoApprove: requireLiteral(config.autoApprove, false, 'reviewConfig.autoApprove'),
    maxFindings: requireLiteral(config.maxFindings, 0, 'reviewConfig.maxFindings'),
    minSeverity: requireLiteral(config.minSeverity, 'nit', 'reviewConfig.minSeverity'),
    includePriorComments: requireLiteral(
      config.includePriorComments,
      false,
      'reviewConfig.includePriorComments',
    ),
    context7Mode: requireEnum(
      config.context7Mode,
      ['auto', 'always', 'off'],
      'reviewConfig.context7Mode',
    ),
    guidelinePass: requireBoolean(config.guidelinePass, 'reviewConfig.guidelinePass'),
    shardCache: requireLiteral(config.shardCache, false, 'reviewConfig.shardCache'),
    scrubSessionEnv: requireLiteral(config.scrubSessionEnv, true, 'reviewConfig.scrubSessionEnv'),
    auxModelMode: requireLiteral(config.auxModelMode, 'same-as-main', 'reviewConfig.auxModelMode'),
    sdkEngine: requireEnum(config.sdkEngine, ['auto', 'opencode'], 'reviewConfig.sdkEngine'),
    reviewPasses: requireInteger(config.reviewPasses, 'reviewConfig.reviewPasses', 1),
    verifyFindings: requireBoolean(config.verifyFindings, 'reviewConfig.verifyFindings'),
    timeBudgetMinutes: requireInteger(config.timeBudgetMinutes, 'reviewConfig.timeBudgetMinutes'),
    reviewShards: requireInteger(config.reviewShards, 'reviewConfig.reviewShards'),
    dynamicFanout: requireBoolean(config.dynamicFanout, 'reviewConfig.dynamicFanout'),
    modelOptions: modelOptions as Record<string, unknown> | null,
    promptCache: requireBoolean(config.promptCache, 'reviewConfig.promptCache'),
    skipDocOnly: requireBoolean(config.skipDocOnly, 'reviewConfig.skipDocOnly'),
    maxConcurrentSessions: requireInteger(
      config.maxConcurrentSessions,
      'reviewConfig.maxConcurrentSessions',
    ),
    reviewTelemetry: requireLiteral(config.reviewTelemetry, true, 'reviewConfig.reviewTelemetry'),
    evidenceQuotes: requireBoolean(config.evidenceQuotes, 'reviewConfig.evidenceQuotes'),
    contextTrim: requireBoolean(config.contextTrim, 'reviewConfig.contextTrim'),
    embeddedFirstPrompt: requireBoolean(
      config.embeddedFirstPrompt,
      'reviewConfig.embeddedFirstPrompt',
    ),
    guidelineWiden: requireEnum(
      config.guidelineWiden,
      ['auto', 'full'],
      'reviewConfig.guidelineWiden',
    ),
    verifierSlimContext: requireBoolean(
      config.verifierSlimContext,
      'reviewConfig.verifierSlimContext',
    ),
    verifyOverlapGrace: requireBoolean(
      config.verifyOverlapGrace,
      'reviewConfig.verifyOverlapGrace',
    ),
  };
}

export function arenaArtifactName(index: number, model: string): string {
  return `model-${index}-${createHash('sha256').update(model).digest('hex')}`;
}

export function validateComparisonManifest(value: unknown): ComparisonManifestV1 {
  const manifest = requireRecord(value, 'comparison');
  requireLiteral(manifest.schemaVersion, ARENA_SCHEMA_VERSION, 'comparison.schemaVersion');
  const arena = requireRecord(manifest.arena, 'comparison.arena');
  const arenaRepository = requireString(arena.repository, 'comparison.arena.repository');
  if (!REPOSITORY_PATTERN.test(arenaRepository)) {
    throw new Error('comparison.arena.repository must be owner/repo.');
  }
  const arenaPrNumber = requireInteger(arena.prNumber, 'comparison.arena.prNumber', 1);
  const commandCommentId = requireInteger(
    arena.commandCommentId,
    'comparison.arena.commandCommentId',
    1,
  );
  const comparisonId = requireString(manifest.comparisonId, 'comparison.comparisonId');
  const expectedComparisonId = `${arenaRepository}:pr-${arenaPrNumber}:comment-${commandCommentId}`;
  if (comparisonId !== expectedComparisonId) {
    throw new Error(`comparison.comparisonId must equal ${expectedComparisonId}.`);
  }

  const target = requireRecord(manifest.target, 'comparison.target');
  const owner = requireNonEmptyString(target.owner, 'comparison.target.owner');
  const repository = requireNonEmptyString(target.repository, 'comparison.target.repository');
  const targetRepository = `${owner}/${repository}`;
  if (!REPOSITORY_PATTERN.test(targetRepository)) {
    throw new Error('comparison target owner/repository is invalid.');
  }
  const targetPrNumber = requireInteger(target.prNumber, 'comparison.target.prNumber', 1);
  const targetUrl = requireString(target.url, 'comparison.target.url');
  if (targetUrl !== `https://github.com/${targetRepository}/pull/${targetPrNumber}`) {
    throw new Error('comparison.target.url must be the canonical public GitHub PR URL.');
  }
  const base = validateRepositoryRef(target.base, 'comparison.target.base');
  const head = validateRepositoryRef(target.head, 'comparison.target.head');
  if (base.repository !== targetRepository) {
    throw new Error('comparison.target.base.repository must match the target repository.');
  }

  const jbot = requireRecord(manifest.jbot, 'comparison.jbot');
  const commitSha = requireSha(jbot.commitSha, 'comparison.jbot.commitSha');
  const imageRef = requireNonEmptyString(jbot.imageRef, 'comparison.jbot.imageRef');
  if (!/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+:[a-f0-9]{40}$/.test(imageRef)) {
    throw new Error('comparison.jbot.imageRef must be a registry image tagged by full commit SHA.');
  }
  if (!imageRef.endsWith(`:${commitSha}`)) {
    throw new Error('comparison.jbot.imageRef tag must equal comparison.jbot.commitSha.');
  }
  const imageDigest = requireString(jbot.imageDigest, 'comparison.jbot.imageDigest');
  if (!DIGEST_PATTERN.test(imageDigest)) {
    throw new Error('comparison.jbot.imageDigest must be a lowercase sha256 digest.');
  }

  if (!Array.isArray(manifest.models) || manifest.models.length < 1 || manifest.models.length > 8) {
    throw new Error('comparison.models must contain 1-8 entries.');
  }
  const models = manifest.models.map((candidate, index): ComparisonModelV1 => {
    const model = requireRecord(candidate, `comparison.models[${index}]`);
    requireLiteral(model.index, index, `comparison.models[${index}].index`);
    const modelName = requireString(model.model, `comparison.models[${index}].model`);
    if (modelName.length < 3 || modelName.length > 512 || !MODEL_PATTERN.test(modelName)) {
      throw new Error(`comparison.models[${index}].model has invalid syntax.`);
    }
    const provider = requireString(model.provider, `comparison.models[${index}].provider`);
    if (provider !== modelName.slice(0, modelName.indexOf('/'))) {
      throw new Error(`comparison.models[${index}].provider must match the model prefix.`);
    }
    const artifactName = requireString(
      model.artifactName,
      `comparison.models[${index}].artifactName`,
    );
    if (artifactName !== arenaArtifactName(index, modelName)) {
      throw new Error(`comparison.models[${index}].artifactName is inconsistent.`);
    }
    return { index, model: modelName, provider, artifactName };
  });
  if (new Set(models.map(({ model }) => model)).size !== models.length) {
    throw new Error('comparison.models must be unique.');
  }

  return {
    schemaVersion: ARENA_SCHEMA_VERSION,
    comparisonId,
    arena: {
      repository: arenaRepository,
      prNumber: arenaPrNumber,
      commandCommentId,
      workflowRunId: requireInteger(arena.workflowRunId, 'comparison.arena.workflowRunId', 1),
      runAttempt: requireInteger(arena.runAttempt, 'comparison.arena.runAttempt', 1),
    },
    target: {
      url: targetUrl,
      owner,
      repository,
      prNumber: targetPrNumber,
      title: requireBoundedString(target.title, 'comparison.target.title', 1024),
      body: requireBoundedString(target.body, 'comparison.target.body', 64 * 1024),
      base,
      head,
    },
    jbot: {
      commitSha,
      imageRef,
      imageDigest,
    },
    reviewConfig: validateReviewConfig(manifest.reviewConfig),
    models,
  };
}

export function parseComparisonManifestJson(raw: string): ComparisonManifestV1 {
  if (Buffer.byteLength(raw, 'utf8') > ARENA_MANIFEST_MAX_BYTES) {
    throw new Error(`Arena PR context exceeds ${ARENA_MANIFEST_MAX_BYTES} UTF-8 bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse arena PR context: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateComparisonManifest(parsed);
}

export function selectArenaModel(
  manifest: ComparisonManifestV1,
  selectedModels: string[],
): ComparisonModelV1 {
  if (selectedModels.length !== 1) {
    throw new Error('Arena review requires exactly one selected model.');
  }
  const selected = manifest.models.find(({ model }) => model === selectedModels[0]);
  if (!selected) {
    throw new Error(`Selected model "${selectedModels[0]}" is not present in comparison.models.`);
  }
  return selected;
}

export function emptyArenaUsage(): ArenaUsageV1 {
  const metric = (): ArenaUsageMetricV1 => ({ value: null, reportingSessions: 0 });
  return {
    sessions: 0,
    inputTokens: metric(),
    outputTokens: metric(),
    reasoningTokens: metric(),
    cacheReadTokens: metric(),
    cost: { usd: null, source: 'unavailable', reportingSessions: 0 },
  };
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function aggregateArenaUsage(telemetry: string | undefined): ArenaUsageV1 {
  const usage = emptyArenaUsage();
  if (!telemetry) return usage;
  const sums = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
  };
  let cost = 0;
  let providerCosts = 0;
  let estimatedCosts = 0;
  let executionSessions = 0;
  let usageSessions = 0;
  for (const line of telemetry.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (
      parsed.kind === 'phase' &&
      parsed.scope === 'session' &&
      (parsed.phase === 'main-execution' || parsed.phase === 'auxiliary-execution')
    ) {
      executionSessions += 1;
      continue;
    }
    if (parsed.kind !== 'session') continue;
    usageSessions += 1;
    for (const key of Object.keys(sums) as Array<keyof typeof sums>) {
      const value = nonNegativeNumber(parsed[key]);
      if (value === undefined) continue;
      sums[key] += value;
      usage[key].reportingSessions += 1;
    }
    const provider = nonNegativeNumber(parsed.costUsd);
    const estimated = nonNegativeNumber(parsed.estimatedCostUsd);
    if (provider !== undefined) {
      cost += provider;
      providerCosts += 1;
    } else if (estimated !== undefined) {
      cost += estimated;
      estimatedCosts += 1;
    }
  }
  usage.sessions = Math.max(executionSessions, usageSessions);
  for (const key of Object.keys(sums) as Array<keyof typeof sums>) {
    if (usage[key].reportingSessions > 0) usage[key].value = sums[key];
  }
  const reportingSessions = providerCosts + estimatedCosts;
  usage.cost = {
    usd: reportingSessions > 0 ? cost : null,
    source:
      providerCosts > 0 && estimatedCosts > 0
        ? 'mixed'
        : providerCosts > 0
          ? 'provider'
          : estimatedCosts > 0
            ? 'configured-estimate'
            : 'unavailable',
    reportingSessions,
  };
  return usage;
}

export function classifyJbotArenaFailure(error: unknown): JbotArenaFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out|timeout|deadline/i.test(message)) return 'timeout';
  if (/parse|json|schema|repair/i.test(message)) return 'parse';
  if (
    /\b[45]\d\d\b|http|rate limit|overloaded|econn|enotfound|fetch failed|socket|stream|upstream|network|api/i.test(
      message,
    )
  ) {
    return 'provider';
  }
  return 'unknown';
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  for (const character of value) {
    if (Buffer.byteLength(output + character, 'utf8') > maxBytes) break;
    output += character;
  }
  return output;
}

export function sanitizeArenaFailureMessage(error: unknown, secretValues: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secretValues.filter((value) => value.length >= 4)) {
    message = message.replaceAll(secret, '[REDACTED]');
  }
  message = message
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(
      /\b((?:api[_-]?key|token|secret|password|credential)"?\s*[:=]\s*"?)[^\s,;"}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateUtf8(message || 'Unknown J-Bot failure.', 512);
}

function validateMetric(metric: unknown, label: string, sessions: number): void {
  const value = requireRecord(metric, label);
  if (value.value !== null && nonNegativeNumber(value.value) === undefined) {
    throw new Error(`${label}.value must be a non-negative number or null.`);
  }
  const reporting = requireInteger(value.reportingSessions, `${label}.reportingSessions`);
  if (reporting > sessions || (reporting === 0) !== (value.value === null)) {
    throw new Error(`${label} has inconsistent reportingSessions/value.`);
  }
}

export function validateJbotArenaOutput(value: unknown): JbotArenaOutputV1 {
  const output = requireRecord(value, 'arena output');
  requireLiteral(output.schemaVersion, ARENA_SCHEMA_VERSION, 'arena output.schemaVersion');
  const status = requireEnum(
    output.status,
    ['completed', 'skipped', 'failed'],
    'arena output.status',
  );
  const usage = requireRecord(output.usage, 'arena output.usage');
  const sessions = requireInteger(usage.sessions, 'arena output.usage.sessions');
  for (const key of [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
  ] as const) {
    validateMetric(usage[key], `arena output.usage.${key}`, sessions);
  }
  const cost = requireRecord(usage.cost, 'arena output.usage.cost');
  const costReporting = requireInteger(
    cost.reportingSessions,
    'arena output.usage.cost.reportingSessions',
  );
  if (
    costReporting > sessions ||
    (costReporting === 0) !== (cost.usd === null) ||
    (cost.usd !== null && nonNegativeNumber(cost.usd) === undefined)
  ) {
    throw new Error('arena output.usage.cost has inconsistent values.');
  }
  const costSource = requireEnum(
    cost.source,
    ['provider', 'configured-estimate', 'mixed', 'unavailable'],
    'arena output.usage.cost.source',
  );
  if ((costReporting === 0) !== (costSource === 'unavailable')) {
    throw new Error('arena output.usage.cost source is inconsistent.');
  }
  const review = output.review;
  const failure = output.failure;
  if (status === 'completed' && (!isRecord(review) || failure !== null)) {
    throw new Error('Completed arena output requires review and failure:null.');
  }
  if (status === 'skipped' && (review !== null || failure !== null)) {
    throw new Error('Skipped arena output requires review:null and failure:null.');
  }
  if (status === 'failed' && (review !== null || !isRecord(failure))) {
    throw new Error('Failed arena output requires review:null and a failure.');
  }
  if (isRecord(review)) {
    requireString(review.summary, 'arena output.review.summary');
    if (!Array.isArray(review.findings))
      throw new Error('arena output.review.findings must be an array.');
    for (const [index, finding] of review.findings.entries()) {
      const item = requireRecord(finding, `arena output.review.findings[${index}]`);
      requireString(item.path, `arena output.review.findings[${index}].path`);
      requireInteger(item.line, `arena output.review.findings[${index}].line`);
      if (typeof item.severity !== 'string' || !VALID_SEVERITIES.has(item.severity as Severity)) {
        throw new Error(`arena output.review.findings[${index}].severity is invalid.`);
      }
      requireString(item.title, `arena output.review.findings[${index}].title`);
      requireString(item.body, `arena output.review.findings[${index}].body`);
      if (
        item.kind !== undefined &&
        (typeof item.kind !== 'string' || !VALID_FINDING_KINDS.has(item.kind as FindingKind))
      ) {
        throw new Error(`arena output.review.findings[${index}].kind is invalid.`);
      }
      if (
        item.confidence !== undefined &&
        (typeof item.confidence !== 'string' ||
          !VALID_CONFIDENCES.has(item.confidence as FindingConfidence))
      ) {
        throw new Error(`arena output.review.findings[${index}].confidence is invalid.`);
      }
      if (item.evidence !== undefined && typeof item.evidence !== 'string') {
        throw new Error(`arena output.review.findings[${index}].evidence must be a string.`);
      }
    }
  }
  if (isRecord(failure)) {
    requireEnum(
      failure.class,
      ['timeout', 'provider', 'parse', 'unknown'],
      'arena output.failure.class',
    );
    const message = requireString(failure.message, 'arena output.failure.message');
    if (Buffer.byteLength(message, 'utf8') > 512 || /[\r\n]/.test(message)) {
      throw new Error('arena output.failure.message must be one line of at most 512 UTF-8 bytes.');
    }
  }
  for (const key of ['backend', 'sdkEngine'] as const) {
    if (output[key] !== null && typeof output[key] !== 'string') {
      throw new Error(`arena output.${key} must be a string or null.`);
    }
  }
  if (output.resolvedModelOptions !== null && !isRecord(output.resolvedModelOptions)) {
    throw new Error('arena output.resolvedModelOptions must be an object or null.');
  }
  if (output.reviewMs !== null && nonNegativeNumber(output.reviewMs) === undefined) {
    throw new Error('arena output.reviewMs must be a non-negative number or null.');
  }
  return output as unknown as JbotArenaOutputV1;
}

export function writeJbotArenaOutput(path: string, output: JbotArenaOutputV1): void {
  validateJbotArenaOutput(output);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(output)}\n`, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
