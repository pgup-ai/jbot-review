import type { JudgeComment } from './benchmark-judge.ts';
import { benchmarkRandom } from './benchmark-score.ts';
import { isWithheldFinding } from './filter.ts';
import type { Finding } from './types.ts';

export interface AacrInstance {
  instanceId: string;
  repo: string;
  prNumber: number;
  language: string;
  base: string;
  head: string;
  changeLines: number;
  references: JudgeComment[];
}

const SHA = /^[0-9a-f]{40}$/;
const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;
const byId = (a: AacrInstance, b: AacrInstance) => (a.instanceId < b.instanceId ? -1 : 1);
const lineOf = (value: unknown) => (Number.isInteger(value) ? (value as number) : null);

/**
 * Official converter mapping: source commit = base, target commit = head (not the reverse).
 * Only label-1 rows are ground truth; PRs without one are dropped.
 */
export function parseAacrDataset(rows: unknown): AacrInstance[] {
  if (!Array.isArray(rows)) throw new Error('AACR dataset must be a JSON array of comment rows.');
  const instances = new Map<string, AacrInstance>();
  rows.forEach((value: Record<string, unknown>, index) => {
    const invalid = (key: string) => new Error(`AACR row ${index}: invalid ${key}.`);
    const url = typeof value.pr_url === 'string' ? PR_URL.exec(value.pr_url) : null;
    const { pr_source_commit: base, pr_target_commit: head, path, note, side } = value;
    if (!url) throw invalid('pr_url');
    if (typeof base !== 'string' || !SHA.test(base)) throw invalid('pr_source_commit');
    if (typeof head !== 'string' || !SHA.test(head)) throw invalid('pr_target_commit');
    if (typeof path !== 'string' || typeof note !== 'string') throw invalid('path or note');
    if (side !== 'left' && side !== 'right') throw invalid('side');
    const [, owner, name, number] = url;
    const instanceId = `${owner}__${name}@${head.slice(0, 7)}`;
    let instance = instances.get(instanceId);
    if (!instance) {
      instance = {
        instanceId,
        repo: `${owner}/${name}`,
        prNumber: Number(number),
        language: String(value.project_main_language),
        base,
        head,
        changeLines: Number(value.pr_change_line_count),
        references: [],
      };
      instances.set(instanceId, instance);
    }
    if (value.label === 1)
      instance.references.push({
        path,
        side,
        fromLine: lineOf(value.from_line),
        toLine: lineOf(value.to_line),
        note,
      });
  });
  return [...instances.values()].filter((instance) => instance.references.length).sort(byId);
}

export function sampleAacrInstances(
  instances: AacrInstance[],
  options: { perLanguage: number; seed: number },
): AacrInstance[] {
  const random = benchmarkRandom(options.seed);
  const byLanguage = new Map<string, AacrInstance[]>();
  for (const instance of [...instances].sort(byId)) {
    const pool = byLanguage.get(instance.language) ?? [];
    pool.push(instance);
    byLanguage.set(instance.language, pool);
  }
  return [...byLanguage.keys()].sort().flatMap((language) => {
    const pool = byLanguage.get(language)!;
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, options.perLanguage);
  });
}

/** Only what jbot would post: withheld candidates never reach the PR. */
export function toJudgeComments(findings: Finding[]): JudgeComment[] {
  return findings
    .filter((finding) => !isWithheldFinding(finding))
    .map(({ path, line, title, body }) => ({
      path,
      side: 'right' as const,
      fromLine: line > 0 ? line : null,
      toLine: line > 0 ? line : null,
      note: `${title}\n\n${body}`,
    }));
}

/** The OCR-shaped result file the official `evaluate.py` parses for any unlisted reviewer. */
export function toOfficialResult(params: {
  instance: AacrInstance;
  comments: JudgeComment[];
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
}) {
  const { instance } = params;
  return {
    instance_id: instance.instanceId,
    repo: instance.repo,
    base_commit: instance.base,
    head_commit: instance.head,
    reviewer: 'jbot',
    duration_seconds: Math.round(params.durationSeconds * 100) / 100,
    review: {
      comments: params.comments.map((comment) => ({
        path: comment.path,
        start_line: comment.fromLine ?? null,
        end_line: comment.toLine ?? null,
        content: comment.note,
      })),
      summary: { input_tokens: params.inputTokens, output_tokens: params.outputTokens },
    },
  };
}
