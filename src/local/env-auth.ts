/**
 * Minifies JSON credential values in `.env` content to a single line,
 * repairing the multi-line paste of a pretty-printed auth blob
 * (CODEX_AUTH_JSON etc.) that a line-based `.env` parser would truncate at
 * the first newline.
 *
 * Only keys in `candidateKeys` whose value starts with `{`/`[` (optionally
 * inside one pair of quotes) are touched. A spilled value is re-joined line
 * by line until it parses as JSON; a value that never parses is left
 * byte-identical and reported as a warning. Output is written unquoted — the
 * in-repo loader takes the raw remainder of the line. Changes and warnings
 * carry key names only: values are secrets and must never be echoed.
 */
export interface MinifyEnvAuthResult {
  content: string;
  /** Keys rewritten to a single minified line. */
  changed: string[];
  /** Keys that looked like JSON but never parsed; left untouched. */
  warnings: string[];
}

const KEY_LINE = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function minifyEnvAuth(
  content: string,
  candidateKeys: ReadonlySet<string>,
): MinifyEnvAuthResult {
  const lines = content.split('\n');
  const out: string[] = [];
  const changed: string[] = [];
  const warnings: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(KEY_LINE);
    const key = match?.[2] ?? '';
    const firstChunk = match?.[3] ?? '';
    if (!match || !candidateKeys.has(key) || !looksLikeJsonStart(firstChunk)) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let chunk = firstChunk;
    let end = i;
    let parsed = tryParseJson(chunk);
    while (parsed === undefined && end + 1 < lines.length && canConsume(lines[end + 1])) {
      end += 1;
      chunk += `\n${lines[end]}`;
      parsed = tryParseJson(chunk);
    }
    if (parsed === undefined) {
      warnings.push(`${key}: value looks like JSON but does not parse; left untouched`);
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const line = `${match[1] ?? ''}${key}=${JSON.stringify(parsed)}`;
    if (end === i && line === lines[i]) {
      out.push(lines[i]); // already minified — keep byte-identical
    } else {
      out.push(line);
      changed.push(key);
    }
    i = end + 1;
  }
  return { content: out.join('\n'), changed, warnings };
}

function looksLikeJsonStart(raw: string): boolean {
  const value = raw.trim().replace(/^['"]/, '');
  return value.startsWith('{') || value.startsWith('[');
}

// Pretty-printed JSON contains no blank or comment lines, and its lines never
// look like a KEY= assignment — those boundaries end the spilled value.
function canConsume(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  return !KEY_LINE.test(line);
}

// `undefined` is a safe sentinel: it is not valid JSON, so JSON.parse can
// never legitimately produce it.
function tryParseJson(chunk: string): unknown {
  const raw = chunk.trim();
  for (const candidate of [raw, stripOuterQuotes(raw)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* keep accumulating */
    }
  }
  return undefined;
}

function stripOuterQuotes(raw: string): string {
  if (
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}
