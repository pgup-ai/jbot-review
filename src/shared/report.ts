import type { Finding, FindingKind } from './types.ts';
import { SEVERITY_RANK } from './filter.ts';
import { formatFindingMetadata } from './github.ts';

/**
 * Reviewer-facing finding grouping and shard-summary hygiene. Pure string
 * helpers only — `runner.ts` wires these into the posted review body. Kept
 * out of `runner.ts` so the layout rules are unit-testable in isolation.
 */

/** Coarse, reviewer-facing buckets derived from a finding's `kind`. */
export type FindingCategory = 'Correctness' | 'Design & architecture' | 'Tests' | 'Docs' | 'Other';

const KIND_TO_CATEGORY: Record<FindingKind, FindingCategory> = {
  bug: 'Correctness',
  security: 'Correctness',
  performance: 'Correctness',
  architecture: 'Design & architecture',
  maintainability: 'Design & architecture',
  test: 'Tests',
  docs: 'Docs',
  investigate: 'Other',
};

/** Render order for category groups; empty groups are omitted downstream. */
const CATEGORY_ORDER: FindingCategory[] = [
  'Correctness',
  'Design & architecture',
  'Tests',
  'Docs',
  'Other',
];

/** Below this many findings, a flat list reads fine and grouping is skipped. */
export const MIN_FINDINGS_TO_GROUP = 5;

export function categoryOf(finding: Pick<Finding, 'kind'>): FindingCategory {
  return finding.kind ? KIND_TO_CATEGORY[finding.kind] : 'Other';
}

export interface FindingGroup {
  category: FindingCategory;
  findings: Finding[];
}

/**
 * Bucket findings into ordered, reviewer-facing categories. Empty categories
 * are omitted; within a group, findings are sorted by severity (P0 first).
 */
export function groupFindingsByCategory(findings: Finding[]): FindingGroup[] {
  const byCategory = new Map<FindingCategory, Finding[]>();
  for (const finding of findings) {
    const category = categoryOf(finding);
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(finding);
    else byCategory.set(category, [finding]);
  }
  const groups: FindingGroup[] = [];
  for (const category of CATEGORY_ORDER) {
    const bucket = byCategory.get(category);
    if (!bucket) continue;
    groups.push({
      category,
      findings: [...bucket].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    });
  }
  return groups;
}

function findingLocation(finding: Pick<Finding, 'path' | 'line'>): string {
  return finding.line > 0 ? `${finding.path}:${finding.line}` : finding.path;
}

/** One-line index entry: severity, kind/confidence, title, clickable location. */
function indexLine(finding: Finding): string {
  return `- **${finding.severity}${formatFindingMetadata(finding)}** ${finding.title} — \`${findingLocation(finding)}\``;
}

/** Full entry with body, for findings that cannot be posted inline. */
function detailLines(finding: Finding): string[] {
  return [indexLine(finding), `  ${finding.body}`];
}

export interface GroupOptions {
  /** Minimum finding count before grouping kicks in (default 5). */
  minToGroup?: number;
}

/**
 * A category-grouped index for findings posted as comments, so a long review
 * can be scanned by theme. Returns [] (caller renders nothing extra) when the
 * set is short or collapses to a single category — in those cases the inline
 * comments and severity table already read fine.
 */
export function renderGroupedFindingIndex(
  findings: Finding[],
  options: GroupOptions = {},
): string[] {
  const minToGroup = options.minToGroup ?? MIN_FINDINGS_TO_GROUP;
  if (findings.length < minToGroup) return [];
  const groups = groupFindingsByCategory(findings);
  if (groups.length < 2) return [];
  const lines: string[] = ['### Findings by category', ''];
  for (const group of groups) {
    lines.push(`**${group.category}** (${group.findings.length})`, '');
    for (const finding of group.findings) lines.push(indexLine(finding));
    lines.push('');
  }
  lines.pop(); // drop trailing blank; caller controls spacing between sections
  return lines;
}

/**
 * The "outside the diff" section. Grouped under category subheaders once it
 * grows past the threshold and spans more than one category; otherwise a flat
 * list. Each entry keeps its full body since it is not posted inline anywhere.
 */
export function renderOrphanedSection(orphaned: Finding[], options: GroupOptions = {}): string[] {
  if (orphaned.length === 0) return [];
  const minToGroup = options.minToGroup ?? MIN_FINDINGS_TO_GROUP;
  const lines: string[] = ['### Findings (outside the diff)', ''];
  const groups = groupFindingsByCategory(orphaned);
  if (orphaned.length >= minToGroup && groups.length >= 2) {
    for (const group of groups) {
      lines.push(`**${group.category}** (${group.findings.length})`, '');
      for (const finding of group.findings) lines.push(...detailLines(finding));
      lines.push('');
    }
    lines.pop();
  } else {
    for (const finding of orphaned) lines.push(...detailLines(finding));
  }
  return lines;
}

/** Normalize a bullet for duplicate detection: drop marker, case, and spacing. */
function bulletKey(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Merge per-shard summaries into one block, dropping verbatim duplicate bullets
 * that sharded runs repeat (boilerplate like "no blocking issues found") and
 * collapsing blank-line runs. Conservative: only exact (case/spacing-normalized)
 * duplicate lines are removed, so distinct per-file observations are preserved.
 */
export function condenseSummary(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const raw of part.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) {
        if (out.length > 0 && out[out.length - 1] !== '') out.push('');
        continue;
      }
      const key = bulletKey(line);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
