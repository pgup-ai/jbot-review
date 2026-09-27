import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { PrFile } from './github.ts';

const execFileAsync = promisify(execFile);
const MARKER = /<!-- jbot-review:auxiliary:(\[[^\n]*\]) -->/;

export interface AuxiliaryBaseline {
  session: string;
  head: string;
  base: string;
  policy: string;
}

export function auxiliaryPolicy(value: unknown): string {
  // Bump when scheduling semantics change without changing the assembled prompts.
  return createHash('sha256')
    .update(JSON.stringify([1, value]))
    .digest('hex');
}

export function auxiliaryBaselines(body: string): AuxiliaryBaseline[] {
  // Only the driver's footer is authoritative; model-written summaries precede it.
  const footer = body.lastIndexOf('</sup>');
  if (footer < 0) return [];
  const match = body.slice(footer + 6).match(MARKER);
  if (!match) return [];
  try {
    const rows: unknown = JSON.parse(match[1]);
    if (!Array.isArray(rows) || rows.length > 10) return [];
    return rows.filter(
      (row): row is AuxiliaryBaseline =>
        row &&
        typeof row.session === 'string' &&
        /^(review-[a-z]+|guideline-compliance)$/.test(row.session) &&
        typeof row.head === 'string' &&
        /^[a-f0-9]{40}$/.test(row.head) &&
        typeof row.base === 'string' &&
        /^[a-f0-9]{40}$/.test(row.base) &&
        typeof row.policy === 'string' &&
        /^[a-f0-9]{64}$/.test(row.policy),
    );
  } catch {
    return [];
  }
}

export function withAuxiliaryBaselines(body: string, rows: AuxiliaryBaseline[]): string {
  return rows.length ? `${body}\n<!-- jbot-review:auxiliary:${JSON.stringify(rows)} -->` : body;
}

/** `files` undefined means check every file; empty means none changed. */
export async function planComplianceRecheck(input: {
  priorBody: string;
  policy: string;
  head: string;
  files: PrFile[];
  /** The base...head patches a completed pass audited. */
  audited: (base: string, head: string) => Promise<PrFile[]>;
}): Promise<{ reason: string; baseline?: AuxiliaryBaseline; files?: string[] }> {
  const baseline = auxiliaryBaselines(input.priorBody).find(
    (row) => row.session === 'guideline-compliance',
  );
  if (!baseline) return { reason: 'no-completed-baseline' };
  if (baseline.policy !== input.policy) return { reason: 'policy-changed', baseline };
  if (baseline.head === input.head) return { reason: 'same-head-rerun', baseline };
  // The audited diff, not today's base: a retargeted PR must not carry over files it never had.
  const audited = await input.audited(baseline.base, baseline.head).catch(() => undefined);
  if (!audited) return { reason: 'history-unavailable', baseline };
  // Only +/- lines count: merging the base branch shifts hunks and context, not the PR's edits.
  const edits = (patch?: string) =>
    patch
      ?.split('\n')
      .filter((line) => /^[+-]/.test(line))
      .join('\n');
  const prior = new Map(audited.map((file) => [file.filename, edits(file.patch)]));
  const files = input.files
    .filter((file) => !file.patch || prior.get(file.filename) !== edits(file.patch))
    .map((file) => file.filename);
  if (files.length === input.files.length) return { reason: 'every-file-changed', baseline };
  return {
    reason: files.length ? 'edits-since-review' : 'no-edits-since-review',
    baseline,
    files,
  };
}

export function isRoutineDocumentation(paths: string[]): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) =>
      /^(?:(?:.*\/)?(?:readme|changelog)\.(?:md|rst|adoc)|docs\/audits\/[^\n]+\.md)$/i.test(path),
    )
  );
}

export async function planAuxiliaryReuse(input: {
  workspace: string;
  base?: string;
  head?: string;
  reviewedHead?: string;
  policyFor: (session: string) => string;
  sessions: string[];
  priorBodies: string[];
  guidelineFollowup?: { baseline: string; coveredByMain: boolean };
}): Promise<Array<{ session: string; reason: string; baseline?: AuxiliaryBaseline }>> {
  const latest = input.priorBodies.at(-1) ?? '';
  const prior = auxiliaryBaselines(latest);
  const deltas = new Map<string, Promise<string>>();
  return Promise.all(
    input.sessions.map(async (session) => {
      const baseline = [...prior].reverse().find((row) => row.session === session);
      let reason: string;
      if (!baseline) reason = 'no-completed-baseline';
      else if (baseline.base !== input.base) reason = 'base-changed';
      else if (baseline.policy !== input.policyFor(session)) reason = 'policy-changed';
      else if (!input.head || baseline.head === input.head || input.reviewedHead === input.head)
        reason = 'explicit-rerun';
      else if (session === 'guideline-compliance' && input.guidelineFollowup) {
        reason =
          baseline.head !== input.guidelineFollowup.baseline
            ? 'guideline-baseline-mismatch'
            : input.guidelineFollowup.coveredByMain
              ? 'global-guidelines-in-main'
              : 'relevant-guidelines';
      } else {
        let delta = deltas.get(baseline.head);
        if (!delta) {
          const git = (...args: string[]) =>
            execFileAsync('git', args, {
              cwd: input.workspace,
              timeout: 1500,
              maxBuffer: 1024 * 1024,
            });
          delta = git('merge-base', '--is-ancestor', baseline.head, input.head)
            .then(() =>
              git(
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--name-only',
                '--no-renames',
                '-z',
                baseline.head,
                input.head!,
                '--',
              ),
            )
            .then(({ stdout }) =>
              isRoutineDocumentation(stdout.split('\0').filter(Boolean))
                ? 'documentation-only'
                : 'relevant-changes',
            )
            .catch(() => 'history-unavailable');
          deltas.set(baseline.head, delta);
        }
        reason = await delta;
      }
      return {
        session,
        reason,
        ...(['documentation-only', 'global-guidelines-in-main'].includes(reason)
          ? { baseline }
          : {}),
      };
    }),
  );
}
