import { createHash } from 'node:crypto';
import { CONTEXT_PACK_MAX_BYTES, type ContextPack } from './context-pack.ts';
import type { PrFile } from './github.ts';
import type { EvidenceStore } from './evidence.ts';
import type { SuppliedContext } from './review-read-locations.ts';
import type { ContextPackTelemetryRow } from './telemetry.ts';
import { findingSourceLocations } from './finding-context.ts';
import type { Finding } from './types.ts';
import {
  buildDiffHunksBlockWithMetadata,
  diffHunksCoverage,
  diffRiskScore,
} from './diff-context.ts';
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
  guidelines?: string;
  /** The page's embedded diff block; a context pack goes right before it. */
  diffText?: string;
  contextPack?: boolean;
}

export function prioritizeAuxiliaryPlans(plans: ShardPlan[]): ShardPlan[] {
  const score = (plan: ShardPlan) =>
    Math.max(0, ...(plan.units ?? []).map((unit) => diffRiskScore(unit.file)));
  return [...plans].sort((a, b) => score(b) - score(a));
}

export function planPageFiles(units: DiffUnit[]): PrFile[] {
  return [...new Set(units.map((unit) => unit.file.filename))].map((filename) => ({
    ...units.find((unit) => unit.file.filename === filename)!.file,
    patch: units
      .filter((unit) => unit.file.filename === filename)
      .map((unit) => unit.file.patch)
      .join('\n'),
  }));
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
  if (!header) throw new Error(`Incomplete diff delivery: invalid hunk in ${unit.file.filename}.`);
  if (lines.length < 3)
    throw new PromptCapacityError(
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

class PromptCapacityError extends Error {}

export function buildShardPlans(params: {
  coreContext: string;
  context7Block: string;
  shards: PrFile[][];
  renderPrompt: (context: string) => string;
  budget: ReviewPromptBudget;
  evidenceReserveBytes?: number;
  minimumDiffBytes?: number;
  embeddedFirstPrompt?: boolean;
  diffFirst?: boolean;
  numberedDiff?: boolean;
  batchDiffScope?: Parameters<typeof buildDiffRecoveryBlock>[2];
  onDemandRecovery?: boolean;
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
    const pageFiles = planPageFiles(units);
    const diff = buildDiffHunksBlockWithMetadata(pageFiles, {
      ...COMPLETE_DIFF_OPTIONS,
      numbered: params.numberedDiff,
    });
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
          params.onDemandRecovery,
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
      diffText: diff.text,
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
  const fits = (units: DiffUnit[], extraReserve = 0) =>
    measureReviewPrompt(
      params.renderPrompt(render(units, 999999, 1000000).context),
      params.budget,
      reserve + extraReserve,
    ).fits;
  const fixedBytes =
    Buffer.byteLength(params.renderPrompt(render([], 999999, 1000000).context)) -
    Buffer.byteLength(core);
  core = boundedPromptContext(
    core,
    Math.max(256, inputCapacity(params.budget) - reserve - fixedBytes - 24 * 1024),
    'PR metadata and prior-review context',
  );
  if (!fits([], params.minimumDiffBytes))
    throw new PromptCapacityError(
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

export function buildAuxiliaryPlans(
  params: Omit<Parameters<typeof buildShardPlans>[0], 'renderPrompt'> & {
    guidelines: string;
    guidelineLabels: string[];
    renderPrompt: (context: string, guidelines: string) => string;
  },
): ShardPlan[] {
  const labels = new Set(params.guidelineLabels);
  const plan = (guidelines: string): ShardPlan[] => {
    try {
      return buildShardPlans({
        ...params,
        minimumDiffBytes: 8 * 1024,
        renderPrompt: (context) => params.renderPrompt(context, guidelines),
      }).map((page) => ({ ...page, guidelines }));
    } catch (error) {
      if (!(error instanceof PromptCapacityError)) throw error;
      // Keep internal section headings attached to their labelled source fragment.
      const boundaries = [...guidelines.matchAll(/\n\n(?=### ([^\n]+)\n)/g)]
        .filter(
          (match) =>
            labels.has(match[1]) || labels.has(match[1].replace(/ \[part \d+\/\d+\]$/, '')),
        )
        .map((match) => match.index! + 2);
      if (!boundaries.length) throw error;
      const middle = boundaries.reduce((best, at) =>
        Math.abs(at - guidelines.length / 2) < Math.abs(best - guidelines.length / 2) ? at : best,
      );
      return [...plan(guidelines.slice(0, middle)), ...plan(guidelines.slice(middle))];
    }
  };
  return plan(params.guidelines).map((page, index) => ({
    ...page,
    label: `auxiliary-page-${index + 1}`,
  }));
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
  return buildTargetedDiffBlock(
    planPageFiles(units),
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
  renderPrompt: (context: string, guidelines?: string) => string,
  budget: ReviewPromptBudget,
  log: (message: string) => void,
  /** Appended after the caller evidence; planning reserved its room. */
  trailer = '',
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
        const addition = trailer ? `${block}\n\n${trailer}` : block;
        plan.context += `\n\n${addition}`;
        plan.baseContext += `\n\n${addition}`;
        const measured = measureReviewPrompt(renderPrompt(plan.context, plan.guidelines), budget);
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

interface ContextPackResult {
  row: Omit<ContextPackTelemetryRow, 'kind'>;
  supplied?: SuppliedContext;
}

/** Puts each page's context pack before its diff; pages it cannot serve are left unchanged. */
export async function addContextPack(params: {
  plans: ShardPlan[];
  build: (plan: ShardPlan, budgetBytes: number, signal: AbortSignal) => Promise<ContextPack>;
  /** The pack-aware page prompt; it sizes both the room and the final fit. */
  renderPrompt: (context: string, guidelines?: string) => string;
  budget: ReviewPromptBudget;
  log: (message: string) => void;
}): Promise<ContextPackResult[]> {
  const { plans, renderPrompt, budget } = params;
  const signal = AbortSignal.timeout(5000);
  const results: ContextPackResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, plans.length) }, async () => {
      while (next < plans.length) {
        const index = next++;
        const plan = plans[index];
        const started = Date.now();
        const roomBytes = Math.max(
          0,
          inputCapacity(budget) -
            Buffer.byteLength(renderPrompt(plan.context, plan.guidelines)) -
            1024,
        );
        const pack = await params
          .build(plan, Math.min(CONTEXT_PACK_MAX_BYTES, roomBytes), signal)
          .catch(() => undefined);
        // A directory map alone would cost the page its caller evidence for no code.
        let reason: ContextPackResult['row']['reason'] = !pack
          ? 'error'
          : pack.slices.surrounding || pack.slices.definitions || pack.slices.callers
            ? undefined
            : 'empty';
        if (pack && !reason) {
          const previous = { context: plan.context, baseContext: plan.baseContext };
          plan.context = withContextPack(plan.context, plan.diffText, pack.text);
          plan.baseContext = withContextPack(plan.baseContext, plan.diffText, pack.text);
          const measured = measureReviewPrompt(renderPrompt(plan.context, plan.guidelines), budget);
          if (measured.fits) {
            plan.promptBytes = measured.promptBytes;
            plan.contextPack = true;
          } else {
            Object.assign(plan, previous);
            reason = 'overflow';
          }
        }
        const served = reason ? undefined : pack;
        const row: ContextPackResult['row'] = {
          session: plan.label,
          state: served?.state ?? 'fallback',
          ...(reason ? { reason } : {}),
          buildMs: Date.now() - started,
          roomBytes,
          bytes: served ? Buffer.byteLength(served.text) : 0,
          omitted: served?.omitted ?? 0,
          // Also kept on fallback pages, so a deadline-starved empty page stays visible.
          uncollected: pack?.uncollected ?? 0,
          slices: served?.slices ?? {},
        };
        results[index] = { row, supplied: served?.supplied };
        const { session: _session, slices: _slices, ...logged } = row;
        params.log(`Context pack (${plan.label}): ${JSON.stringify(logged)}.`);
      }
    }),
  );
  return results;
}

function withContextPack(context: string, diffText: string | undefined, pack: string): string {
  const at = diffText ? context.lastIndexOf(diffText) : -1;
  return at < 0
    ? `${context}\n\n${pack}`
    : `${context.slice(0, at)}${pack}\n\n${context.slice(at)}`;
}
