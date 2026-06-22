import type { Finding } from './types.ts';
import { formatFindingLocation, formatFindingMetadata } from './github.ts';

/**
 * Pure review-body layout helpers. `runner.ts` wires these into the posted
 * review body; kept here so the layout rules are unit-testable in isolation.
 * Grouping the findings by category is left to the model (in its summary),
 * not enforced in code.
 */

/** One-line entry: severity, kind/confidence, title, clickable location. */
function findingLine(finding: Finding): string {
  return `- **${finding.severity}${formatFindingMetadata(finding)}** ${finding.title} — \`${formatFindingLocation(finding)}\``;
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

/** Normalize a summary line for duplicate detection: drop marker, case, and spacing. */
function summaryLineKey(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** A line that is only a bold category header, e.g. `**Bugs**` or `**Bugs**:`. */
function isCategoryHeader(line: string): boolean {
  return /^\s*\*\*[^*]+\*\*:?\s*$/.test(line);
}

function splitCategoryLeadIn(line: string): { header: string; rest: string } | undefined {
  const match = line.match(/^\s*(\*\*[^*]+\*\*)\s*(?:—|-|:)\s*(.+)$/);
  if (!match) return undefined;
  return { header: match[1], rest: match[2].trim() };
}

function categoryKey(line: string): string {
  return line
    .trim()
    .replace(/^\*\*/, '')
    .replace(/\*\*:?\s*$/, '')
    .replace(/:$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function formatSummaryLine(line: string): string {
  if (!line.trim() || isCategoryHeader(line)) return line;

  return line
    .split(/(`[^`]*`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g)
    .map((segment) => {
      if (
        !segment ||
        segment.startsWith('`') ||
        segment.startsWith('[') ||
        /^https?:\/\//.test(segment)
      ) {
        return segment;
      }
      return formatPlainSummarySegment(segment);
    })
    .join('');
}

function formatPlainSummarySegment(segment: string): string {
  let out = segment;
  out = formatOutsideCodeSpans(out, (part) =>
    part.replace(/(^|[^\w`])(\{\s*[A-Za-z_$][^{}\n]{0,80}\})(?=$|[^\w`])/g, '$1`$2`'),
  );
  out = formatOutsideCodeSpans(out, (part) =>
    part.replace(
      /(^|[^\w`])((?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|sql|css|scss|html|go|py|rb|java|kt|rs|tf|toml))(?=$|[\s),.;:])/g,
      '$1`$2`',
    ),
  );
  out = formatOutsideCodeSpans(out, (part) =>
    part.replace(
      /(^|[^\w`])([A-Za-z_$][\w$]*(?:(?:[A-Z][a-z0-9]+)|(?:[a-z0-9][A-Z]))[\w$]*(?:\.[A-Za-z_$][\w$]*)+)(?=$|[^\w`])/g,
      '$1`$2`',
    ),
  );
  out = formatOutsideCodeSpans(out, (part) =>
    part.replace(
      /(^|[^\w`])([a-z_$][\w$]*(?:(?:[A-Z][a-z0-9]+)|(?:[a-z0-9][A-Z]))[\w$]*(?:\(\))?)(?=$|[^\w`])/g,
      '$1`$2`',
    ),
  );
  out = formatOutsideCodeSpans(out, (part) =>
    part.replace(/(^|[^\w`])([A-Z][A-Z0-9_]{2,})(?=$|[^\w`])/g, (match, prefix, token) =>
      COMMON_UPPERCASE_WORDS.has(token) ? match : `${prefix}\`${token}\``,
    ),
  );
  return out;
}

function formatOutsideCodeSpans(text: string, format: (segment: string) => string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map((segment) => (segment.startsWith('`') ? segment : format(segment)))
    .join('');
}

const COMMON_UPPERCASE_WORDS = new Set([
  'API',
  'CD',
  'CI',
  'CLI',
  'CSS',
  'CSV',
  'DB',
  'DOM',
  'HTTP',
  'HTML',
  'ID',
  'JSON',
  'JWT',
  'LLM',
  'MCP',
  'PR',
  'REST',
  'SDK',
  'SQL',
  'UI',
  'URI',
  'URL',
  'XML',
  'YAML',
]);

/**
 * Merge per-shard summaries into one public block. Lines under matching bold
 * category headers are grouped together, duplicate content is removed, and
 * code-like tokens get conservative markdown formatting for readability.
 */
export function condenseSummary(parts: string[]): string {
  const seen = new Set<string>();
  const topLevel: string[] = [];
  const sections = new Map<string, { header: string; lines: string[] }>();

  for (const part of parts) {
    let currentKey = '';
    for (const raw of part.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;

      if (isCategoryHeader(line)) {
        currentKey = categoryKey(line);
        if (!sections.has(currentKey)) sections.set(currentKey, { header: line.trim(), lines: [] });
        continue;
      }

      const leadIn = splitCategoryLeadIn(line);
      if (leadIn) {
        currentKey = categoryKey(leadIn.header);
        if (!sections.has(currentKey)) {
          sections.set(currentKey, { header: leadIn.header, lines: [] });
        }
        const key = `${currentKey}:${summaryLineKey(leadIn.rest)}`;
        if (!seen.has(key)) {
          seen.add(key);
          sections.get(currentKey)!.lines.push(formatSummaryLine(leadIn.rest));
        }
        continue;
      }

      const key = `${currentKey || 'top'}:${summaryLineKey(line)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (currentKey) {
        sections.get(currentKey)!.lines.push(formatSummaryLine(line));
      } else {
        topLevel.push(formatSummaryLine(line));
      }
    }
  }

  const out: string[] = [];
  if (topLevel.length > 0) out.push(...topLevel);

  for (const section of sections.values()) {
    if (section.lines.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(section.header, ...section.lines);
  }

  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== '') break;
    out.pop();
  }
  return out.join('\n');
}

export function formatSummaryMarkdown(summary: string): string {
  const out: string[] = [];
  for (const raw of summary.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(formatSummaryLine(line));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
