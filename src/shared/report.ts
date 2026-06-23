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

function isNoFindingVerdict(line: string): boolean {
  if (isCategoryHeader(line)) return isNoFindingKey(categoryKey(line));
  const key = summaryLineKey(
    line
      .trim()
      .replace(/^\*\*[^*]+\*\*\s*/, '')
      .replace(/^review\s+/, ''),
  );
  return isNoFindingKey(key);
}

function isNoFindingKey(key: string): boolean {
  if (/[;,]|\.\s+\S|\b(?:although|but|except|however|though|yet)\b/.test(key)) return false;
  return /^no (?:new |blocking )?(?:bugs?|findings?|issues?) (?:were )?found(?: (?:in|within) [a-z0-9_./ -]{1,80})?\.?$/.test(
    key,
  );
}

/** A line that is only a bold category header, e.g. `**Bugs**` or `**Bugs**:`. */
function isCategoryHeader(line: string): boolean {
  return /^\s*\*\*[^*]+\*\*:?\s*$/.test(line);
}

function splitCategoryLeadIn(line: string): { header: string; rest: string } | undefined {
  const match = line.match(/^\s*(\*\*[^*]+\*\*)\s*(?:—|–|-|:)\s*(.+)$/);
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
      (match, prefix, token) =>
        PROPER_NOUN_EXCEPTIONS.has(token) ? match : `${prefix}\`${token}\``,
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

const PROPER_NOUN_EXCEPTIONS = new Set(['eBay', 'iPad', 'iPhone', 'iOS', 'macOS']);

/**
 * Merge per-shard summaries into one public block. Lines under matching bold
 * category headers are grouped together and duplicate content is removed.
 * Markdown token formatting is applied later by `formatSummaryMarkdown`.
 */
export function condenseSummary(
  parts: string[],
  options: { suppressNoFindingVerdicts?: boolean } = {},
): string {
  const seen = new Set<string>();
  const sections = new Map<string, { header: string; lines: string[] }>();
  const blocks: Array<{ type: 'section'; key: string } | { type: 'top'; lines: string[] }> = [];

  for (const part of parts) {
    let currentKey = '';
    let suppressingNoFindingSection = false;
    for (const raw of part.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) continue;

      if (isCategoryHeader(line)) {
        if (options.suppressNoFindingVerdicts && isNoFindingVerdict(line)) {
          currentKey = '';
          suppressingNoFindingSection = true;
          continue;
        }
        suppressingNoFindingSection = false;
        currentKey = categoryKey(line);
        if (!sections.has(currentKey)) {
          sections.set(currentKey, { header: line.trim(), lines: [] });
          blocks.push({ type: 'section', key: currentKey });
        }
        continue;
      }

      const leadIn = splitCategoryLeadIn(line);
      if (leadIn) {
        suppressingNoFindingSection = false;
        if (
          options.suppressNoFindingVerdicts &&
          (isNoFindingVerdict(leadIn.header) || isNoFindingVerdict(leadIn.rest))
        ) {
          continue;
        }
        currentKey = categoryKey(leadIn.header);
        if (!sections.has(currentKey)) {
          sections.set(currentKey, { header: leadIn.header, lines: [] });
          blocks.push({ type: 'section', key: currentKey });
        }
        const key = `${currentKey}:${summaryLineKey(leadIn.rest)}`;
        if (!seen.has(key)) {
          seen.add(key);
          sections.get(currentKey)!.lines.push(leadIn.rest);
        }
        continue;
      }

      if (suppressingNoFindingSection) continue;
      if (options.suppressNoFindingVerdicts && isNoFindingVerdict(line)) continue;

      const key = `${currentKey || 'top'}:${summaryLineKey(line)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (currentKey) {
        sections.get(currentKey)!.lines.push(line);
      } else {
        let topBlock: string[];
        const previousBlock = blocks[blocks.length - 1];
        if (previousBlock?.type === 'top') {
          topBlock = previousBlock.lines;
        } else {
          topBlock = [];
          blocks.push({ type: 'top', lines: topBlock });
        }
        topBlock.push(line);
      }
    }
  }

  const out: string[] = [];
  for (const block of blocks) {
    const lines =
      block.type === 'top'
        ? block.lines
        : [sections.get(block.key)!.header, ...sections.get(block.key)!.lines];
    if (lines.length === 0 || (block.type === 'section' && lines.length === 1)) continue;
    if (out.length > 0) out.push('');
    out.push(...lines);
  }

  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] !== '') break;
    out.pop();
  }
  return out.join('\n');
}

export function formatSummaryMarkdown(
  summary: string,
  options: { suppressNoFindingVerdicts?: boolean } = {},
): string {
  const out: string[] = [];
  let suppressingNoFindingSection = false;
  let pendingHeader = '';

  const pushFormattedLine = (line: string): void => {
    if (pendingHeader) {
      out.push(formatSummaryLine(pendingHeader));
      pendingHeader = '';
    }
    out.push(formatSummaryLine(line));
  };

  for (const raw of summary.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      if (pendingHeader) continue;
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (isCategoryHeader(line)) {
      if (options.suppressNoFindingVerdicts && isNoFindingVerdict(line)) {
        pendingHeader = '';
        suppressingNoFindingSection = true;
        continue;
      }
      if (options.suppressNoFindingVerdicts) {
        pendingHeader = line;
        suppressingNoFindingSection = false;
        continue;
      }
      suppressingNoFindingSection = false;
    } else if (suppressingNoFindingSection) {
      continue;
    }
    if (options.suppressNoFindingVerdicts && isNoFindingVerdict(line)) {
      suppressingNoFindingSection = false;
      continue;
    }
    pushFormattedLine(line);
  }
  if (pendingHeader && !options.suppressNoFindingVerdicts)
    out.push(formatSummaryLine(pendingHeader));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
