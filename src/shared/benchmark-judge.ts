import { buildSemanticJudgePrompt, parseJudgeVerdict } from './prompt.ts';

// Port of aacr-bench evaluation/judge.py + evaluate.py (HEAD 2026-09-27); keep identical for comparable scores.

/** Null line bounds make a comment file-level: it skips the line stage. */
export interface JudgeComment {
  path: string;
  side?: 'left' | 'right';
  fromLine?: number | null;
  toLine?: number | null;
  note: string;
}

type SameConcern = (reference: string, generated: string) => Promise<boolean>;

export interface JudgeCounts {
  expected: number;
  generated: number;
  lineMatched: number;
  semanticMatched: number;
}

interface JudgeCase {
  caseId: string;
  references: JudgeComment[];
  generated: JudgeComment[];
}

const normalizePath = (path: string) => path.replaceAll('\\/', '/').replaceAll('\\', '/');

const stripThinkingTags = (note: string) =>
  note
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function lineRange(comment: JudgeComment): [number, number] | undefined {
  const from = comment.fromLine ?? comment.toLine;
  const to = comment.toLine ?? comment.fromLine;
  if (from == null || to == null) return undefined;
  return from <= to ? [from, to] : [to, from];
}

const near = ([aFrom, aTo]: [number, number], [bFrom, bTo]: [number, number], window: number) =>
  (aFrom <= bTo && aTo >= bFrom) ||
  Math.min(Math.abs(aFrom - bTo), Math.abs(aTo - bFrom)) <= window;

/** References in order; each generated comment earns at most one line and one semantic match. */
export async function matchComments(
  references: JudgeComment[],
  generated: JudgeComment[],
  sameConcern: SameConcern,
  lineWindow = 1,
): Promise<{ lineMatched: boolean[]; matchedGenerated: (number | null)[] }> {
  const lineUsed = new Set<number>();
  const semanticUsed = new Set<number>();
  const lineMatched: boolean[] = [];
  const matchedGenerated: (number | null)[] = [];
  for (const reference of references) {
    const referenceNote = stripThinkingTags(reference.note);
    const referenceRange = lineRange(reference);
    let line = false;
    let matched: number | null = null;
    for (const [index, candidate] of referenceNote ? generated.entries() : []) {
      const candidateNote = stripThinkingTags(candidate.note);
      const referencePath = normalizePath(reference.path);
      const candidatePath = normalizePath(candidate.path);
      const candidateRange = lineRange(candidate);
      if (!candidateNote) continue;
      if (referencePath && candidatePath && referencePath !== candidatePath) continue;
      if (reference.side && candidate.side && reference.side !== candidate.side) continue;
      if (referenceRange && candidateRange && !near(referenceRange, candidateRange, lineWindow))
        continue;
      if (!line && !lineUsed.has(index)) {
        line = true;
        lineUsed.add(index);
      }
      if (semanticUsed.has(index)) continue;
      // Sequential by design: which candidate a reference claims depends on earlier verdicts.
      if (await sameConcern(referenceNote, candidateNote)) {
        matched = index;
        semanticUsed.add(index);
        break;
      }
    }
    lineMatched.push(line);
    matchedGenerated.push(matched);
  }
  return { lineMatched, matchedGenerated };
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const rate = (part: number, whole: number) => (whole ? round3(part / whole) : 0);
// The official F1 is taken from the already-rounded rates.
const f1 = (precision: number, recall: number) =>
  precision + recall > 0 ? round3((2 * precision * recall) / (precision + recall)) : 0;

export function judgeMetrics(counts: JudgeCounts) {
  const semanticPrecision = rate(counts.semanticMatched, counts.generated);
  const semanticRecall = rate(counts.semanticMatched, counts.expected);
  const linePrecision = rate(counts.lineMatched, counts.generated);
  const lineRecall = rate(counts.lineMatched, counts.expected);
  return {
    semanticPrecision,
    semanticRecall,
    semanticF1: f1(semanticPrecision, semanticRecall),
    linePrecision,
    lineRecall,
    lineF1: f1(linePrecision, lineRecall),
  };
}

export async function scoreCases(cases: JudgeCase[], sameConcern: SameConcern, lineWindow = 1) {
  const scored = await Promise.all(
    cases.map(async ({ caseId, references, generated }) => {
      const result = await matchComments(references, generated, sameConcern, lineWindow);
      const counts: JudgeCounts = {
        expected: references.filter((reference) => reference.note).length,
        generated: generated.length,
        lineMatched: result.lineMatched.filter(Boolean).length,
        semanticMatched: result.matchedGenerated.filter((index) => index !== null).length,
      };
      const matches = result.matchedGenerated.flatMap((index, reference) =>
        index === null ? [] : [{ reference, generated: index }],
      );
      return { caseId, counts, matches };
    }),
  );
  const counts = scored.reduce<JudgeCounts>(
    (sum, item) => ({
      expected: sum.expected + item.counts.expected,
      generated: sum.generated + item.counts.generated,
      lineMatched: sum.lineMatched + item.counts.lineMatched,
      semanticMatched: sum.semanticMatched + item.counts.semanticMatched,
    }),
    { expected: 0, generated: 0, lineMatched: 0, semanticMatched: 0 },
  );
  return { cases: scored, counts, metrics: judgeMetrics(counts) };
}

interface JudgeStats {
  calls: number;
  errors: number;
  ms: number;
}

/** A failed judge call counts as "no" (the official rule) and is tallied. */
export function createJudge(complete: (prompt: string) => Promise<string>) {
  const stats: JudgeStats = { calls: 0, errors: 0, ms: 0 };
  const sameConcern: SameConcern = async (reference, generated) => {
    const started = Date.now();
    stats.calls += 1;
    try {
      return parseJudgeVerdict(await complete(buildSemanticJudgePrompt(reference, generated)));
    } catch {
      stats.errors += 1;
      return false;
    } finally {
      stats.ms += Date.now() - started;
    }
  };
  return { sameConcern, stats };
}
