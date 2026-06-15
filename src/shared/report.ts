import type { Finding, FindingKind } from './types.ts';
import { SEVERITY_RANK } from './filter.ts';
import { formatFindingLocation, formatFindingMetadata } from './github.ts';

/**
 * Reviewer-facing finding grouping and shard-summary hygiene. Pure string
 * helpers only; `runner.ts` wires these into the posted review body. Kept out
 * of `runner.ts` so the layout rules are unit-testable in isolation.
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

/** Render order for groups; empty categories are omitted. */
const CATEGORY_ORDER: FindingCategory[] = [
  'Correctness',
  'Design & architecture',
  'Tests',
  'Docs',
  'Other',
];

/** Below this many findings, a flat list reads fine and grouping is skipped. */
const MIN_FINDINGS_TO_GROUP = 5;

export function categoryOf(finding: Pick<Finding, 'kind'>): FindingCategory {
  return finding.kind ? KIND_TO_CATEGORY[finding.kind] : 'Other';
}

export interface FindingGroup {
  category: FindingCategory;
  findings: Finding[];
}

/**
 * Bucket findings into ordered categories. Empty categories are omitted;
 * within a group, findings are sorted by severity (P0 first).
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
    if (bucket) {
      groups.push({
        category,
        findings: [...bucket].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
      });
    }
  }
  return groups;
}

/** One-line entry: severity, kind/confidence, title, clickable location. */
function findingLine(finding: Finding): string {
  return `- **${finding.severity}${formatFindingMetadata(finding)}** ${finding.title} — \`${formatFindingLocation(finding)}\``;
}

/**
 * A category-grouped index of the findings posted as comments, so a long
 * review can be scanned by theme. Returns [] (the caller renders nothing
 * extra) when the set is short or collapses to a single category, where the
 * inline comments and severity table already read fine.
 */
export function renderGroupedFindingIndex(findings: Finding[]): string[] {
  if (findings.length < MIN_FINDINGS_TO_GROUP) return [];
  const groups = groupFindingsByCategory(findings);
  if (groups.length < 2) return [];
  const lines = ['### Findings by category', ''];
  for (const group of groups) {
    lines.push(`**${group.category}** (${group.findings.length})`, '');
    for (const finding of group.findings) lines.push(findingLine(finding));
    lines.push('');
  }
  lines.pop(); // drop trailing blank; the caller controls spacing between sections
  return lines;
}

/**
 * The "outside the diff" section: findings that could not be anchored inline,
 * listed flat with their full bodies (they are uncommon and self-contained).
 */
export function renderOrphanedSection(orphaned: Finding[]): string[] {
  if (orphaned.length === 0) return [];
  const lines = ['### Findings (outside the diff)', ''];
  for (const finding of orphaned) lines.push(findingLine(finding), `  ${finding.body}`);
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
 * Merge per-shard summaries into one block, dropping verbatim-duplicate bullets
 * that sharded runs repeat (boilerplate like "no blocking issues found") and
 * collapsing blank-line runs. Conservative: only case/spacing-identical lines
 * are removed, so distinct per-file observations survive.
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
