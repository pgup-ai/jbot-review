/**
 * Diff-scoped review routing. A repo can declare, per changed-path glob, which
 * governance docs and rule IDs apply (a `rules-for-diff.yaml`), and map rule-ID
 * prefixes to the doc that defines them (the "Rule IDs" section of a governance
 * README). jbot then loads the matched docs and the specific rule SECTIONS
 * ahead of generic guidance, so a large standards file contributes its relevant
 * sections instead of an arbitrary head-of-file truncation.
 *
 * Every parser is fail-safe: malformed or oversized input yields an empty
 * result, and the caller falls back to whole-file discovery. These are pure
 * (string in, value out); file IO and byte budgeting live in the caller.
 */

export interface DiffRoute {
  name: string;
  paths: string[];
  docs: string[];
  rules: string[];
}

const MAX_ROUTING_BYTES = 64 * 1024;
const MAX_ROUTES = 300;
const MAX_LIST_ITEMS = 400;

/**
 * Parse the bounded `entries:` list of a rules-for-diff.yaml. Only the shape
 * this schema uses is recognized — `name` scalars and `paths`/`docs`/`rules`
 * bracketed lists (inline or multi-line); anything else is ignored, not an
 * error. Not a general YAML parser.
 */
export function parseDiffRoutes(text: string): DiffRoute[] {
  if (text.length > MAX_ROUTING_BYTES) return [];
  const yamlText = text.replace(/\r\n/g, '\n');
  const region = yamlText.match(/^entries:[ \t]*$([\s\S]*)/m)?.[1];
  if (!region) return [];
  const blocks = region.split(/^[ \t]*-[ \t]+name:/m).slice(1);
  // Reject an over-count file rather than silently keeping a truncated subset:
  // a non-empty partial would suppress the caller's whole-file fallback, so a
  // path matching only a dropped route would get no guidance at all.
  if (blocks.length > MAX_ROUTES) return [];
  const routes: DiffRoute[] = [];
  for (const block of blocks) {
    const name = block.match(/^[ \t]*(.+)$/m)?.[1]?.trim();
    if (!name) continue;
    routes.push({
      name,
      paths: parseBracketList(block, 'paths'),
      docs: parseBracketList(block, 'docs'),
      rules: parseBracketList(block, 'rules'),
    });
  }
  return routes;
}

/** A line-anchored `key: [ ... ]` list; items are comma-separated, quotes optional. */
function parseBracketList(block: string, key: string): string[] {
  // `\s*` after the colon: the schema puts the `[` on the same line (inline)
  // or on the next (multi-line block).
  const inner = block.match(new RegExp(`(?:^|\\n)[ \\t]*${key}:\\s*\\[([\\s\\S]*?)\\]`))?.[1];
  if (inner === undefined) return [];
  return splitTopLevel(inner)
    .map((token) =>
      token
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .trim(),
    )
    .filter((token) => token.length > 0)
    .slice(0, MAX_LIST_ITEMS);
}

/**
 * Split on commas that are outside quotes and brace sets, so a brace-set glob
 * (`**​/*.{ts,tsx}`) the downstream matcher supports stays one item instead of
 * splitting into two broken paths.
 */
function splitTopLevel(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items;
}

/**
 * Parse a governance README's rule-ID declaration into `PREFIX → doc path`
 * (the path is relative to the README's directory). Matches a backticked
 * `` `PREFIX-<n>` `` followed on the same line by the first backticked `.md`
 * path — covering both phrasings in the wild (`— sections of`, `maps to`).
 */
export function parseRuleIdDocs(readmeText: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /`([A-Za-z][A-Za-z0-9]*)-<n>`[^`\n]*?`([^`\n]+\.md)`/gi;
  for (const match of readmeText.replace(/\r\n/g, '\n').matchAll(pattern))
    map.set(match[1].toUpperCase(), match[2].trim());
  return map;
}

// A real rule id is short (`TS-16.2`); reject absurdly long ones so a
// PR-controlled routing file can't inject a huge section number that later
// bloats a bundle label or omission note past budget.
const MAX_RULE_ID_LENGTH = 64;

/** Split `TS-16.2` into its prefix and section number; undefined if not an ID. */
export function splitRuleId(id: string): { prefix: string; section: string } | undefined {
  const trimmed = id.trim();
  if (trimmed.length > MAX_RULE_ID_LENGTH) return undefined;
  const match = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)-(\d+(?:\.\d+)*)$/);
  return match ? { prefix: match[1].toUpperCase(), section: match[2] } : undefined;
}

/** Docs + rule IDs of every route whose paths glob-match at least one changed file. */
export function selectDiffRoutes(
  routes: DiffRoute[],
  changedFiles: string[],
  matches: (glob: string, file: string) => boolean,
): { docs: string[]; ruleIds: string[] } {
  const docs = new Set<string>();
  const ruleIds = new Set<string>();
  for (const route of routes) {
    if (!route.paths.some((glob) => changedFiles.some((file) => matches(glob, file)))) continue;
    for (const doc of route.docs) docs.add(doc);
    for (const rule of route.rules) ruleIds.add(rule);
  }
  return { docs: [...docs], ruleIds: [...ruleIds] };
}

/**
 * Extract the section a numbered heading owns. Sections are numbered headings
 * (`## 6. Title`, `### 6.2 Title`); a rule's section number is the heading's
 * leading numeric token (a trailing dot on whole numbers is ignored). Bounded
 * by the `#` level, not the number: a `##` section runs to the next `##`/`#`,
 * so its deeper (`###`) subsections are included, while flat same-level
 * headings (`## 16` then `## 16.2`) stay separate — which is what a doc that
 * cites both `TS-16` and `TS-16.2` wants (no duplicated body).
 */
export function extractRuleSection(docText: string, section: string): string | undefined {
  const lines = docText.replace(/\r\n/g, '\n').split('\n');
  // Headings inside ``` / ~~~ fences are examples, not policy — skip them.
  const fenced: boolean[] = [];
  let inFence = false;
  for (const line of lines) {
    const marker = /^\s*(```|~~~)/.test(line);
    fenced.push(inFence || marker);
    if (marker) inFence = !inFence;
  }
  const heading = (i: number): { level: number; number?: string } | undefined => {
    const match = fenced[i] ? null : lines[i].match(/^(#+)[ \t]+(.*)$/);
    if (!match) return undefined;
    return {
      level: match[1].length,
      number: match[2].trim().match(/^(\d+(?:\.\d+)*)\.?(?=\s|$)/)?.[1],
    };
  };
  let start = -1;
  for (let i = 0; i < lines.length; i += 1)
    if (heading(i)?.number === section) {
      start = i;
      break;
    }
  if (start < 0) return undefined;
  const startLevel = heading(start)!.level;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const level = heading(i)?.level;
    if (level !== undefined && level <= startLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}
