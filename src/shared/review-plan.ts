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
  diffLineCounts,
  diffRiskScore,
  numberNewSideLines,
  unboundedDiffBlockBytes,
  unboundedDiffSectionBytes,
  whitespaceOnlyLines,
  type DerivedDiffFile,
} from './diff-context.ts';
import {
  batchablePaths,
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
  const scores = new Map(
    plans.map((plan) => [
      plan,
      Math.max(0, ...(plan.units ?? []).map((unit) => diffRiskScore(unit.file))),
    ]),
  );
  return [...plans].sort((a, b) => scores.get(b)! - scores.get(a)!);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const same = groups.get(name);
    if (same) same.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

export function planPageFiles(units: DiffUnit[]): PrFile[] {
  return [...groupBy(units, (unit) => unit.file.filename).values()].map((same) => ({
    ...same[0].file,
    patch: same.map((unit) => unit.file.patch).join('\n'),
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

const HUNK_START = /^@@ -\d+(?:,\d+)? \+\d+/;
/** Stands in for the context; the NULs keep it from matching template text. */
const CONTEXT_PROBE = '\u0000jbot-context\u0000';

/** Bytes a render adds around the context, when it places the context verbatim once. */
function promptFrameBytes(renderPrompt: (context: string) => string): number | undefined {
  const probe = renderPrompt(CONTEXT_PROBE);
  const at = probe.indexOf(CONTEXT_PROBE);
  if (at < 0 || probe.includes(CONTEXT_PROBE, at + 1)) return undefined;
  const frame = probe.slice(0, at) + probe.slice(at + CONTEXT_PROBE.length);
  // A surrogate at the seam would pair with the context's edge and change the byte count.
  if (/[\uD800-\uDFFF]/.test(probe[at - 1] ?? '') || /[\uD800-\uDFFF]/.test(frame[at] ?? ''))
    return undefined;
  return renderPrompt('') === frame ? Buffer.byteLength(frame) : undefined;
}

/** The byte model does not apply or disagrees with a real render; plan with real renders. */
class ModelMismatch extends Error {}

interface Page {
  units: DiffUnit[];
  tryAdd(unit: DiffUnit): boolean;
  /** Modeled prompt bytes, checked against a real render of the finished page. */
  bytes?: number;
}

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
}): ShardPlan[] {
  const files = params.shards.flat();
  const originals = params.shards.map((shard) => shard.flatMap(diffUnits));
  const map = buildReviewChangeMap(files);
  const reserve = params.evidenceReserveBytes ?? 0;
  let core = params.coreContext.startsWith(UNTRUSTED_PR_CONTENT_NOTE)
    ? params.coreContext.slice(UNTRUSTED_PR_CONTENT_NOTE.length).trimStart()
    : params.coreContext;
  // Numbering and re-indent pairing restart at each hunk header, so when every unit opens
  // one, a page file's derivations are its units' own, joined in order.
  const wellFormed = originals.every((shard) =>
    shard.every((unit) => !unit.file.patch || HUNK_START.test(unit.file.patch)),
  );
  const derivations = new Map<
    DiffUnit,
    { text: string; textBytes: number; whitespaceOnly: number[]; addedLines: number }
  >();
  const derive = (unit: DiffUnit) => {
    let derived = derivations.get(unit);
    if (!derived) {
      const patch = unit.file.patch ?? '';
      const text = params.numberedDiff ? numberNewSideLines(patch) : patch;
      derived = {
        text,
        textBytes: Buffer.byteLength(text),
        whitespaceOnly: params.numberedDiff ? whitespaceOnlyLines(patch) : [],
        addedLines: diffLineCounts([unit.file]).added,
      };
      derivations.set(unit, derived);
    }
    return derived;
  };
  const pageFiles = (units: DiffUnit[]): DerivedDiffFile[] =>
    wellFormed
      ? [...groupBy(units, (unit) => unit.file.filename).values()].map((same) => ({
          ...same[0].file,
          patch: same.map((unit) => unit.file.patch).join('\n'),
          numberedPatch: same.map((unit) => derive(unit).text).join('\n'),
          whitespaceOnly: same.flatMap((unit) => derive(unit).whitespaceOnly),
          addedLines: same.reduce((sum, unit) => sum + derive(unit).addedLines, 0),
        }))
      : planPageFiles(units);
  const pathCount = new Set(files.map((file) => file.filename)).size;
  const batchable = params.batchDiffScope ? batchablePaths(files) : [];
  const recoveryBlock = (assigned: ReadonlySet<string>) =>
    params.batchDiffScope
      ? buildDiffRecoveryBlock(
          batchable.filter(({ path }) => !assigned.has(path)),
          pathCount - assigned.size,
          params.batchDiffScope,
        )
      : '';
  const assemble = (units: DiffUnit[], index: number, count: number) => {
    const assignedFiles = [...new Set(units.map((u) => u.file.filename))];
    const page = pageFiles(units);
    const diff = buildDiffHunksBlockWithMetadata(page, {
      ...COMPLETE_DIFF_OPTIONS,
      numbered: params.numberedDiff,
    });
    const assignment = buildShardAssignmentBlock(
      assignedFiles,
      index,
      count,
      params.embeddedFirstPrompt,
    );
    const recovery = recoveryBlock(new Set(assignedFiles));
    const parts =
      params.diffFirst && count === 1
        ? [UNTRUSTED_PR_CONTENT_NOTE, diff.text, core, map, assignment, recovery]
        : [UNTRUSTED_PR_CONTENT_NOTE, core, map, assignment, diff.text, recovery];
    parts.push(buildAdjacentDiffContext(units.flatMap((unit) => unit.adjacent ?? [])));
    const baseContext = parts.filter(Boolean).join('\n\n');
    const contextParts = [...parts];
    contextParts.splice(contextParts.indexOf(assignment), 0, params.context7Block);
    const context = contextParts.filter(Boolean).join('\n\n');
    return { assignedFiles, page, diff, baseContext, context };
  };
  const unitsByFile = groupBy(originals.flat(), (unit) => unit.file.filename);
  const render = (units: DiffUnit[], index: number, count: number): ShardPlan => {
    const { assignedFiles, page, diff, baseContext, context } = assemble(units, index, count);
    const ids = new Set(units.map((part) => part.id));
    const whole = (path: string) => unitsByFile.get(path)!.every((u) => ids.has(u.id));
    return {
      label: count === 1 ? 'review' : `review-shard-${index + 1}`,
      context,
      baseContext,
      assignedFiles,
      diffText: diff.text,
      diffCoverage: {
        ...diffHunksCoverage(page, diff),
        completeFiles: assignedFiles.filter(whole).length,
        pagedFiles: assignedFiles.filter((path) => !whole(path)).length,
      },
      units,
      promptBytes: Buffer.byteLength(params.renderPrompt(context)),
    };
  };
  // A fit check measures the page at placeholder task numbers, the widest it can render.
  const promptBytes = (units: DiffUnit[]) =>
    Buffer.byteLength(params.renderPrompt(assemble(units, 999999, 1000000).context));
  const fits = (units: DiffUnit[], extraReserve = 0) =>
    promptBytes(units) + reserve + extraReserve <= inputCapacity(params.budget);
  const fixedBytes = promptBytes([]) - Buffer.byteLength(core);
  core = boundedPromptContext(
    core,
    Math.max(256, inputCapacity(params.budget) - reserve - fixedBytes - 24 * 1024),
    'PR metadata and prior-review context',
  );
  if (!fits([], params.minimumDiffBytes))
    throw new PromptCapacityError(
      'Incomplete diff delivery: instructions, guidelines and shared context exhaust the assembled prompt budget before any diff can be delivered.',
    );

  const exactPage = (): Page => {
    const units: DiffUnit[] = [];
    return {
      units,
      tryAdd(unit) {
        if (!fits([...units, unit])) return false;
        units.push(unit);
        return true;
      },
    };
  };
  // Byte arithmetic instead of a render per candidate: the frame is fixed and a part is rebuilt
  // only when a unit changes it. Real renders confirm every rejection and finished page.
  const frame = promptFrameBytes(params.renderPrompt);
  // Joined parts cost their bytes plus a blank line each; the whole has one blank line fewer.
  const cost = (part: string) => (part ? Buffer.byteLength(part) + 2 : 0);
  const fixedCost =
    [UNTRUSTED_PR_CONTENT_NOTE, core, map, params.context7Block].reduce(
      (sum, part) => sum + cost(part),
      0,
    ) - 2;
  const assignmentBlock = (names: string[]) =>
    buildShardAssignmentBlock(names, 999999, 1000000, params.embeddedFirstPrompt);
  const emptyAssignmentCost = cost(assignmentBlock([]));
  const batchableAt = new Map(batchable.map(({ path }, i) => [path, i]));
  const modeledPage = (): Page => {
    const units: DiffUnit[] = [];
    const onPage = new Map<
      string,
      { textBytes: number; whitespaceOnly: number[]; sectionBytes: number }
    >();
    let sections = 0;
    let sectionBytes = 0;
    let assignmentCost = emptyAssignmentCost;
    // The first unit always brings a new file, which rebuilds the recovery block.
    let recoveryCost = 0;
    let excerpts: string[] = [];
    let adjacentCost = 0;
    // Union-find over batchable paths: one on the page points past itself.
    const skip = new Map<number, number>();
    const offPage = (i: number) => {
      let end = i;
      while (skip.has(end)) end = skip.get(end)!;
      for (let next; i !== end; i = next) {
        next = skip.get(i)!;
        skip.set(i, end);
      }
      return end;
    };
    function* missing(name: string) {
      for (let i = offPage(0); i < batchable.length; i = offPage(i + 1))
        if (batchable[i].path !== name) yield batchable[i];
    }
    const page: Page = {
      units,
      tryAdd(unit) {
        const name = unit.file.filename;
        const derived = derive(unit);
        const known = onPage.get(name);
        const textBytes = known ? known.textBytes + 1 + derived.textBytes : derived.textBytes;
        const whitespaceOnly =
          known && derived.whitespaceOnly.length
            ? [...known.whitespaceOnly, ...derived.whitespaceOnly]
            : (known?.whitespaceOnly ?? derived.whitespaceOnly);
        // A file without patch text is assigned but gets no diff section.
        const fileBytes = !textBytes
          ? 0
          : known?.textBytes && !derived.whitespaceOnly.length
            ? known.sectionBytes + derived.textBytes + 1
            : unboundedDiffSectionBytes(name, textBytes, whitespaceOnly);
        const nextSections = sections - (known?.textBytes ? 1 : 0) + (textBytes ? 1 : 0);
        const nextSectionBytes = sectionBytes - (known?.sectionBytes ?? 0) + fileBytes;
        // A file adds its own line to the assignment block.
        const nextAssignmentCost = known
          ? assignmentCost
          : assignmentCost + cost(assignmentBlock([name])) - emptyAssignmentCost;
        const nextRecoveryCost =
          known || !params.batchDiffScope
            ? recoveryCost
            : cost(
                buildDiffRecoveryBlock(
                  missing(name),
                  pathCount - onPage.size - 1,
                  params.batchDiffScope,
                ),
              );
        const nextExcerpts = unit.adjacent?.length ? [...excerpts, ...unit.adjacent] : excerpts;
        const nextAdjacentCost = unit.adjacent?.length
          ? cost(buildAdjacentDiffContext(nextExcerpts))
          : adjacentCost;
        const diffBytes = unboundedDiffBlockBytes(
          nextSectionBytes,
          nextSections,
          params.numberedDiff,
        );
        const bytes =
          frame! +
          fixedCost +
          nextAssignmentCost +
          nextRecoveryCost +
          nextAdjacentCost +
          (diffBytes && diffBytes + 2);
        if (bytes + reserve > inputCapacity(params.budget)) {
          if (fits([...units, unit])) throw new ModelMismatch();
          return false;
        }
        units.push(unit);
        onPage.set(name, { textBytes, whitespaceOnly, sectionBytes: fileBytes });
        const at = known ? undefined : batchableAt.get(name);
        if (at !== undefined) skip.set(at, at + 1);
        sections = nextSections;
        sectionBytes = nextSectionBytes;
        assignmentCost = nextAssignmentCost;
        recoveryCost = nextRecoveryCost;
        excerpts = nextExcerpts;
        adjacentCost = nextAdjacentCost;
        page.bytes = bytes;
        return true;
      },
    };
    return page;
  };
  const paginate = (newPage: () => Page): Page[] => {
    const pages: Page[] = [];
    for (const shard of originals) {
      let page = newPage();
      // Next unit last: a failed or split unit goes back on top.
      const pending = [...shard].reverse();
      while (pending.length) {
        const unit = pending.pop()!;
        if (page.tryAdd(unit)) continue;
        if (page.units.length) {
          pages.push(page);
          page = newPage();
          pending.push(unit);
          continue;
        }
        const [first, second] = splitUnit(unit);
        pending.push(second, first);
      }
      if (page.units.length) pages.push(page);
    }
    return pages;
  };
  let pages: DiffUnit[][];
  try {
    if (frame === undefined || !wellFormed) throw new ModelMismatch();
    const modeled = paginate(modeledPage);
    for (const page of modeled)
      if (promptBytes(page.units) !== page.bytes) throw new ModelMismatch();
    pages = modeled.map((page) => page.units);
  } catch (error) {
    if (!(error instanceof ModelMismatch)) throw error;
    pages = paginate(exactPage).map((page) => page.units);
  }
  const partsByHunk = groupBy(pages.flat(), (part) => part.hunk);
  for (const original of originals.flat()) {
    const parts = partsByHunk.get(original.id) ?? [];
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
    if (plan.promptBytes! + reserve > inputCapacity(params.budget))
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
  text?: string;
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
        // A directory map alone would cost the page its caller evidence for no code, and a
        // partial pack is missing a changed file's own code, so both keep today's evidence.
        let reason: ContextPackResult['row']['reason'] = !pack
          ? 'error'
          : pack.state === 'partial'
            ? 'partial'
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
        results[index] = { row, supplied: served?.supplied, text: served?.text };
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
