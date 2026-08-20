import { createHash } from 'node:crypto';

import { VALID_SEVERITIES, type Severity } from './types.ts';

const POSITIVE_REACTIONS = new Set(['+1', 'heart', 'hooray', 'rocket']);
const NEGATIVE_REACTIONS = new Set(['-1', 'confused']);
const OUTCOME_CANDIDATES = new Set([
  'positive-candidate',
  'negative-candidate',
  'adjudication-required',
  'conflicting-signals',
]);

export type HistoricalOutcomeCandidate =
  'positive-candidate' | 'negative-candidate' | 'adjudication-required' | 'conflicting-signals';

export interface HistoricalFindingSignal {
  findingId: string;
  sourceHash: string;
  caseId: string;
  severity: Severity;
  pathHash: string;
  line: number;
  findingText: string;
  evidenceText: string;
  addressed?: boolean;
  resolved?: boolean;
  reactions?: string[];
  humanReplyCount?: number;
}

export interface HistoricalFindingCandidate {
  candidateId: string;
  sourceHash: string;
  caseId: string;
  severity: Severity;
  pathHash: string;
  line: number;
  findingText: string;
  evidenceText: string;
  outcomeCandidate: HistoricalOutcomeCandidate;
}

interface BlindAdjudicationCase {
  candidateId: string;
  severity: Severity;
  pathHash: string;
  line: number;
  findingText: string;
  evidenceText: string;
}

export interface AdjudicationLabel {
  candidateId: string;
  adjudicatorId: string;
  decision: 'accepted' | 'rejected' | 'uncertain';
  expectedFindingId?: string;
}

interface AdjudicationResult {
  candidateId: string;
  status: 'adjudicated' | 'pending' | 'disagreement';
  decision?: 'accepted' | 'rejected';
  expectedFindingId?: string;
  labelCount: number;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

export function classifyHistoricalOutcome(
  signal: Pick<HistoricalFindingSignal, 'addressed' | 'resolved' | 'reactions' | 'humanReplyCount'>,
): HistoricalOutcomeCandidate {
  const reactions = signal.reactions ?? [];
  const positive =
    Boolean(signal.addressed) ||
    Boolean(signal.resolved) ||
    reactions.some((reaction) => POSITIVE_REACTIONS.has(reaction));
  const negative = reactions.some((reaction) => NEGATIVE_REACTIONS.has(reaction));
  if (positive && negative) return 'conflicting-signals';
  if (positive) return 'positive-candidate';
  if (negative) return 'negative-candidate';
  return 'adjudication-required';
}

export function importHistoricalFinding(
  signal: HistoricalFindingSignal,
): HistoricalFindingCandidate {
  if (
    !isNonEmptyString(signal.findingId) ||
    !isNonEmptyString(signal.caseId) ||
    !isSha256(signal.sourceHash) ||
    !isSha256(signal.pathHash) ||
    !VALID_SEVERITIES.has(signal.severity) ||
    !Number.isInteger(signal.line) ||
    signal.line < 0 ||
    typeof signal.findingText !== 'string' ||
    !signal.findingText.trim() ||
    Buffer.byteLength(signal.findingText) > 8_192 ||
    typeof signal.evidenceText !== 'string' ||
    !signal.evidenceText.trim() ||
    Buffer.byteLength(signal.evidenceText) > 16_384 ||
    (signal.addressed !== undefined && typeof signal.addressed !== 'boolean') ||
    (signal.resolved !== undefined && typeof signal.resolved !== 'boolean') ||
    (signal.reactions !== undefined &&
      (!Array.isArray(signal.reactions) ||
        signal.reactions.some((reaction) => typeof reaction !== 'string'))) ||
    (signal.humanReplyCount !== undefined &&
      (!Number.isInteger(signal.humanReplyCount) || signal.humanReplyCount < 0))
  ) {
    throw new Error('Historical finding signal is invalid.');
  }
  return {
    candidateId: createHash('sha256')
      .update(`${signal.sourceHash}:${signal.findingId}`)
      .digest('hex'),
    sourceHash: signal.sourceHash,
    caseId: signal.caseId,
    severity: signal.severity,
    pathHash: signal.pathHash,
    line: signal.line,
    findingText: signal.findingText,
    evidenceText: signal.evidenceText,
    outcomeCandidate: classifyHistoricalOutcome(signal),
  };
}

export function blindAdjudicationCase(
  candidate: HistoricalFindingCandidate,
): BlindAdjudicationCase {
  return {
    candidateId: candidate.candidateId,
    severity: candidate.severity,
    pathHash: candidate.pathHash,
    line: candidate.line,
    findingText: candidate.findingText,
    evidenceText: candidate.evidenceText,
  };
}

export function adjudicateHistoricalCandidates(
  candidates: HistoricalFindingCandidate[],
  labels: AdjudicationLabel[],
): AdjudicationResult[] {
  for (const candidate of candidates) {
    if (
      typeof candidate.candidateId !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(candidate.candidateId) ||
      !isNonEmptyString(candidate.caseId) ||
      !isSha256(candidate.sourceHash) ||
      !isSha256(candidate.pathHash) ||
      !VALID_SEVERITIES.has(candidate.severity) ||
      !Number.isInteger(candidate.line) ||
      candidate.line < 0 ||
      typeof candidate.findingText !== 'string' ||
      !candidate.findingText.trim() ||
      Buffer.byteLength(candidate.findingText) > 8_192 ||
      typeof candidate.evidenceText !== 'string' ||
      !candidate.evidenceText.trim() ||
      Buffer.byteLength(candidate.evidenceText) > 16_384 ||
      !OUTCOME_CANDIDATES.has(candidate.outcomeCandidate)
    ) {
      throw new Error('Historical finding candidate is invalid.');
    }
  }
  const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  if (candidateIds.size !== candidates.length) throw new Error('Candidate ids must be unique.');
  const labelGroups = new Map<string, AdjudicationLabel[]>();
  const labelKeys = new Set<string>();
  for (const label of labels) {
    const key = `${label.candidateId}\0${label.adjudicatorId}`;
    if (
      !candidateIds.has(label.candidateId) ||
      !isNonEmptyString(label.adjudicatorId) ||
      !['accepted', 'rejected', 'uncertain'].includes(label.decision) ||
      (label.expectedFindingId !== undefined && !isNonEmptyString(label.expectedFindingId)) ||
      labelKeys.has(key)
    ) {
      throw new Error('Adjudication label is invalid or duplicated.');
    }
    labelKeys.add(key);
    const group = labelGroups.get(label.candidateId);
    if (group) group.push(label);
    else labelGroups.set(label.candidateId, [label]);
  }
  return candidates.map((candidate) => {
    const group = labelGroups.get(candidate.candidateId) ?? [];
    const required =
      candidate.outcomeCandidate === 'adjudication-required' ||
      candidate.outcomeCandidate === 'conflicting-signals'
        ? 2
        : 1;
    if (group.length < required) {
      return { candidateId: candidate.candidateId, status: 'pending', labelCount: group.length };
    }
    const decisions = new Set(group.map((label) => label.decision));
    const expectedIds = new Set(group.map((label) => label.expectedFindingId ?? ''));
    if (decisions.size !== 1 || decisions.has('uncertain') || expectedIds.size > 1) {
      return {
        candidateId: candidate.candidateId,
        status: 'disagreement',
        labelCount: group.length,
      };
    }
    const first = group[0];
    return {
      candidateId: candidate.candidateId,
      status: 'adjudicated',
      decision: first.decision as 'accepted' | 'rejected',
      ...(first.expectedFindingId ? { expectedFindingId: first.expectedFindingId } : {}),
      labelCount: group.length,
    };
  });
}
