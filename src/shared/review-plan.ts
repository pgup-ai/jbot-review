import { createHash } from 'node:crypto';
import type { PrFile } from './github.ts';
import type { EvidenceStore } from './evidence.ts';
import { findingSourceLocations } from './finding-context.ts';
import type { Finding } from './types.ts';
import { buildDiffHunksBlockWithMetadata, diffHunksCoverage } from './diff-context.ts';
import {
  buildDiffRecoveryBlock,
  buildReviewChangeMap,
  buildAdjacentDiffContext,
  buildTargetedDiffBlock,
  buildShardAssignmentBlock,
  UNTRUSTED_PR_CONTENT_NOTE,
  BOUNDARY_EVIDENCE_NOTE,
  BOUNDARY_EVIDENCE_UNAVAILABLE,
  boundedPromptContext,
  VERIFIER_TARGETED_DIFF_NOTE,
} from './prompt.ts';

export const REVIEW_EVIDENCE_BYTES = 8 * 1024;
export const COMPLETE_DIFF_OPTIONS = { totalBudgetBytes: Infinity, perFileBudgetBytes: Infinity };

export interface ReviewPromptBudget {
  contextTokens: number;
  outputTokens: number;
  harnessTokens: number;
  transportBytes: number;
  modelLimitKnown: boolean;
}

export function reviewPromptBudget(
  backend: string,
  limits?: { contextTokens: number; outputTokens?: number },
): ReviewPromptBudget {
  const contextTokens = limits?.contextTokens ?? 128_000;
  const harnessTokens = Math.min(8_192, Math.floor(contextTokens / 4));
  return {
    contextTokens,
    outputTokens: Math.min(
      limits?.outputTokens ?? 32_768,
      32_768,
      Math.floor((contextTokens - harnessTokens) / 2),
    ),
    harnessTokens,
    transportBytes: backend === 'cline' ? 120 * 1024 - 2048 : 256 * 1024,
    modelLimitKnown: limits !== undefined,
  };
}

export function measureReviewPrompt(prompt: string, budget: ReviewPromptBudget, reserve = 0) {
  const promptBytes = Buffer.byteLength(prompt);
  // One token per UTF-8 byte is a conservative text bound, not a chars/4 estimate.
  const inputTokenBound = promptBytes + reserve;
  return {
    promptBytes,
    inputTokenBound,
    fits: inputTokenBound <= inputCapacity(budget),
  };
}

function inputCapacity(budget: ReviewPromptBudget): number {
  return Math.min(
    96 * 1024,
    budget.transportBytes,
    budget.contextTokens - budget.outputTokens - budget.harnessTokens,
  );
}

export interface DiffUnit {
  id: string;
  hunk: string;
  file: PrFile;
  adjacent?: string[];
}

export interface ShardPlan {
  label: string;
  context: string;
  baseContext: string;
  assignedFiles: string[];
  diffCoverage: ReturnType<typeof diffHunksCoverage> & { pagedFiles?: number };
  units?: DiffUnit[];
  promptBytes?: number;
}

function diffUnits(file: PrFile): DiffUnit[] {
  const hunks = (file.patch ?? '').split(/\n(?=@@ -\d)/);
  return hunks.map((patch, index) => {
    const id = createHash('sha256').update(`${file.filename}\0${index}\0${patch}`).digest('hex');
    return { id, hunk: id, file: { ...file, patch } };
  });
}

function splitUnit(unit: DiffUnit): [DiffUnit, DiffUnit] {
  const lines = unit.file.patch!.split('\n');
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[0]);
  if (!header || lines.length < 3)
    throw new Error(
      `Incomplete diff delivery: one diff line in ${unit.file.filename} exceeds the assembled prompt budget.`,
    );
  const body = lines.slice(1);
  let mid = Math.ceil(body.length / 2);
  if (body[mid]?.startsWith('\\')) mid += mid + 1 < body.length ? 1 : -1;
  if (mid <= 0 || mid >= body.length)
    throw new Error(`Incomplete diff delivery: unsplittable hunk in ${unit.file.filename}.`);
  let oldLine = Number(header[1]) + (header[2] === '0' ? 1 : 0);
  let newLine = Number(header[3]) + (header[4] === '0' ? 1 : 0);
  return [body.slice(0, mid), body.slice(mid)].map((part, index) => {
    const oldCount = part.filter((line) => line.startsWith('-') || line.startsWith(' ')).length;
    const newCount = part.filter((line) => line.startsWith('+') || line.startsWith(' ')).length;
    const patch = `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@${header[5]}\n${part.join('\n')}`;
    oldLine += oldCount;
    newLine += newCount;
    const neighbor = index === 0 ? body.slice(mid, mid + 6) : body.slice(Math.max(0, mid - 6), mid);
    return {
      ...unit,
      id: `${unit.id}.${index}`,
      file: { ...unit.file, patch },
      adjacent: [
        ...(unit.adjacent ?? []),
        `${unit.file.filename}\n${lines[0]}\n${neighbor.join('\n')}`,
      ],
    };
  }) as [DiffUnit, DiffUnit];
}

export function buildShardPlans(params: {
  coreContext: string;
  context7Block: string;
  shards: PrFile[][];
  renderPrompt: (context: string) => string;
  budget: ReviewPromptBudget;
  evidenceReserveBytes?: number;
  embeddedFirstPrompt?: boolean;
  diffFirst?: boolean;
  batchDiffScope?: Parameters<typeof buildDiffRecoveryBlock>[2];
}): ShardPlan[] {
  const files = params.shards.flat();
  const originals = params.shards.map((shard) => shard.flatMap(diffUnits));
  const map = buildReviewChangeMap(files);
  const reserve = params.evidenceReserveBytes ?? 0;
  let core = params.coreContext.startsWith(UNTRUSTED_PR_CONTENT_NOTE)
    ? params.coreContext.slice(UNTRUSTED_PR_CONTENT_NOTE.length).trimStart()
    : params.coreContext;
  const render = (units: DiffUnit[], index: number, count: number): ShardPlan => {
    const assignedFiles = [...new Set(units.map((u) => u.file.filename))];
    const pageFiles = assignedFiles.map((filename) => ({
      ...units.find((u) => u.file.filename === filename)!.file,
      patch: units
        .filter((u) => u.file.filename === filename)
        .map((u) => u.file.patch)
        .join('\n'),
    }));
    const diff = buildDiffHunksBlockWithMetadata(pageFiles, COMPLETE_DIFF_OPTIONS);
    const assignment = buildShardAssignmentBlock(
      assignedFiles,
      index,
      count,
      params.embeddedFirstPrompt,
    );
    const recovery = params.batchDiffScope
      ? buildDiffRecoveryBlock(
          files,
          files.filter((f) => !assignedFiles.includes(f.filename)).map((f) => f.filename),
          params.batchDiffScope,
        )
      : '';
    const parts =
      params.diffFirst && count === 1
        ? [UNTRUSTED_PR_CONTENT_NOTE, diff.text, core, map, assignment, recovery]
        : [UNTRUSTED_PR_CONTENT_NOTE, core, map, assignment, diff.text, recovery];
    parts.push(buildAdjacentDiffContext(units.flatMap((unit) => unit.adjacent ?? [])));
    const baseContext = parts.filter(Boolean).join('\n\n');
    const contextParts = [...parts];
    contextParts.splice(contextParts.indexOf(assignment), 0, params.context7Block);
    const context = contextParts.filter(Boolean).join('\n\n');
    return {
      label: count === 1 ? 'review' : `review-shard-${index + 1}`,
      context,
      baseContext,
      assignedFiles,
      diffCoverage: {
        ...diffHunksCoverage(pageFiles, diff),
        completeFiles: assignedFiles.filter((path) =>
          originals
            .flat()
            .filter((u) => u.file.filename === path)
            .every((u) => units.some((part) => part.id === u.id)),
        ).length,
        pagedFiles: assignedFiles.filter((path) =>
          originals
            .flat()
            .filter((u) => u.file.filename === path)
            .some((u) => !units.some((part) => part.id === u.id)),
        ).length,
      },
      units,
      promptBytes: Buffer.byteLength(params.renderPrompt(context)),
    };
  };
  const fits = (units: DiffUnit[]) =>
    measureReviewPrompt(
      params.renderPrompt(render(units, 999999, 1000000).context),
      params.budget,
      reserve,
    ).fits;
  const fixedBytes =
    Buffer.byteLength(params.renderPrompt(render([], 999999, 1000000).context)) -
    Buffer.byteLength(core);
  core = boundedPromptContext(
    core,
    Math.max(256, inputCapacity(params.budget) - reserve - fixedBytes - 24 * 1024),
    'PR metadata and prior-review context',
  );
  if (!fits([]))
    throw new Error(
      'Incomplete diff delivery: instructions, guidelines and shared context exhaust the assembled prompt budget before any diff can be delivered.',
    );
  const pages: DiffUnit[][] = [];
  for (const shard of originals) {
    let page: DiffUnit[] = [];
    const pending = [...shard];
    while (pending.length) {
      const unit = pending.shift()!;
      if (fits([...page, unit])) {
        page.push(unit);
        continue;
      }
      if (page.length) {
        pages.push(page);
        page = [];
        pending.unshift(unit);
        continue;
      }
      pending.unshift(...splitUnit(unit));
    }
    if (page.length) pages.push(page);
  }
  for (const original of originals.flat()) {
    const parts = pages.flat().filter((part) => part.hunk === original.id);
    const body = (patch: string) => patch.split('\n').slice(1).join('\n');
    if (
      !parts.length ||
      parts.map((part) => body(part.file.patch!)).join('\n') !== body(original.file.patch!)
    )
      throw new Error(
        `Incomplete diff delivery: hunk conservation failed for ${original.file.filename}.`,
      );
  }
  return pages.map((units, index) => {
    const plan = render(units, index, pages.length);
    if (!measureReviewPrompt(params.renderPrompt(plan.context), params.budget, reserve).fits)
      throw new Error(
        'Incomplete diff delivery: final assembled review prompt exceeds its budget.',
      );
    return plan;
  });
}

export function reviewDelivery(plans: ShardPlan[], completed: Set<string>) {
  const expected = new Map<string, Set<string>>();
  const delivered = new Set<string>();
  for (const plan of plans)
    for (const unit of plan.units ?? []) {
      if (!expected.has(unit.hunk)) expected.set(unit.hunk, new Set());
      expected.get(unit.hunk)!.add(unit.id);
      if (completed.has(plan.label)) delivered.add(unit.id);
    }
  return {
    expectedHunks: expected.size,
    deliveredHunks: [...expected.values()].filter((parts) =>
      [...parts].every((id) => delivered.has(id)),
    ).length,
    expectedTasks: plans.length,
    completedTasks: completed.size,
    incompleteTasks: plans.length - completed.size,
  };
}

export function targetedDiff(
  plans: ShardPlan[],
  findings: Pick<Finding, 'path' | 'line' | 'body'>[],
): string {
  const refs = findingSourceLocations(findings);
  const locations = [...refs.locations, ...findings.filter((f) => f.line === 0)];
  const units = plans
    .flatMap((p) => p.units ?? [])
    .filter(({ file }) =>
      locations.some((ref) => {
        if (ref.path !== file.filename) return false;
        const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(file.patch ?? '');
        if (!header || ref.line === 0) return true;
        return (
          ref.line >= Number(header[1]) &&
          ref.line < Number(header[1]) + Math.max(1, Number(header[2] ?? 1))
        );
      }),
    );
  const files = [...new Set(units.map((u) => u.file.filename))].map((filename) => ({
    filename,
    patch: units
      .filter((u) => u.file.filename === filename)
      .map((u) => u.file.patch)
      .join('\n'),
  }));
  return buildTargetedDiffBlock(
    files,
    units.flatMap((unit) => unit.adjacent ?? []),
  );
}

export function targetedVerifierContext(
  plans: ShardPlan[],
  findings: Finding[],
  core: string,
): string {
  return [core, VERIFIER_TARGETED_DIFF_NOTE, targetedDiff(plans, findings)]
    .filter(Boolean)
    .join('\n\n');
}

export async function addReviewEvidence(
  plans: ShardPlan[],
  evidence: EvidenceStore,
  renderPrompt: (context: string) => string,
  budget: ReviewPromptBudget,
  log: (message: string) => void,
): Promise<void> {
  let next = 0;
  const deadline = Date.now() + 5000;
  await Promise.all(
    Array.from({ length: Math.min(4, plans.length) }, async () => {
      while (next < plans.length) {
        const plan = plans[next++];
        const locations = (plan.units ?? []).flatMap(({ file }) => {
          const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(file.patch ?? '');
          return hunk
            ? [
                {
                  path: file.filename,
                  line: Math.max(1, Number(hunk[1])),
                  endLine: Number(hunk[1]) + Math.max(1, Number(hunk[2] ?? 1)) - 1,
                },
              ]
            : [];
        });
        const packet =
          Date.now() < deadline
            ? await evidence
                .prepare('exploration', [], 'deterministic', {
                  locations,
                  timeoutMs: deadline - Date.now(),
                  log: () => {},
                  onStats: () => {},
                })
                .catch(() => '')
            : '';
        const block = boundedPromptContext(
          `${BOUNDARY_EVIDENCE_NOTE}\n${packet || BOUNDARY_EVIDENCE_UNAVAILABLE}`,
          REVIEW_EVIDENCE_BYTES - 2,
          'Caller evidence',
        );
        plan.context += `\n\n${block}`;
        plan.baseContext += `\n\n${block}`;
        const measured = measureReviewPrompt(renderPrompt(plan.context), budget);
        if (!measured.fits)
          throw new Error(
            'Incomplete diff delivery: caller evidence exceeded its reserved prompt budget.',
          );
        plan.promptBytes = measured.promptBytes;
        log(
          `Prompt delivery (${plan.label}): ${JSON.stringify({ ...measured, callerEvidenceBytes: Buffer.byteLength(block), callerEvidenceAvailable: !!packet, assignedHunks: new Set(plan.units?.map((u) => u.hunk)).size })}.`,
        );
      }
    }),
  );
}
