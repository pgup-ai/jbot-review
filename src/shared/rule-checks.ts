import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import type { PrFile } from './github.ts';
import { newSideLines } from './patch.ts';
import { globMatches } from './review-context.ts';
import type { Finding } from './types.ts';

/** Committed by the reviewed repo; read from the merge-base so a PR cannot change the checks that judge it. */
export const RULE_CHECKS_PATH = '.github/jbot-review-checks.json';

/**
 * A written rule compiled into a line check. `shadow` checks only log how their hits
 * compare with the guideline pass; `enforce` checks post their hits as compliance findings
 * and the guideline pass is told to leave their rule alone.
 */
interface RuleCheck {
  id: string;
  /** The written rule, quoted with the doc it comes from. */
  rule: string;
  severity: 'P1' | 'P2' | 'P3';
  title: string;
  /** Globs (slash-less ones match the basename). */
  files: string[];
  /** Matched against each added line. */
  pattern: RegExp;
  /** An added line that also matches this is not a hit. */
  unless?: RegExp;
  mode: 'shadow' | 'enforce';
}

interface RuleCheckHit {
  check: RuleCheck;
  path: string;
  line: number;
}

// Repo-controlled regexes run on PR-controlled lines: bound the checks and the time spent matching.
const MAX_CHECKS = 200;
const MAX_PATTERN_LENGTH = 500;
// Rule and title reach prompts and posted findings.
const MAX_RULE_LENGTH = 1000;
const MAX_TITLE_LENGTH = 200;
const MATCH_TIMEOUT_MS = 2000;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEVERITIES = new Set(['P1', 'P2', 'P3']);

/** Parses the committed checks file; a malformed check is rejected by id (or index), never fatal. */
export function parseRuleChecks(json: string): { checks: RuleCheck[]; rejected: string[] } {
  const data: unknown = JSON.parse(json);
  const rows = (data as { checks?: unknown })?.checks;
  if (!Array.isArray(rows)) throw new Error(`${RULE_CHECKS_PATH} must hold a "checks" array`);
  const checks: RuleCheck[] = [];
  const rejected: string[] = [];
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const check = index < MAX_CHECKS ? parseCheck(row) : undefined;
    if (check && !ids.has(check.id)) {
      ids.add(check.id);
      checks.push(check);
    } else {
      const id = (row as { id?: unknown })?.id;
      rejected.push(typeof id === 'string' ? id : `#${index}`);
    }
  }
  return { checks, rejected };
}

function parseCheck(row: unknown): RuleCheck | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const { id, rule, severity, title, files, pattern, unless, mode } = row as Record<
    string,
    unknown
  >;
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  if (typeof id !== 'string' || !ID.test(id) || !text(rule) || !text(title)) return undefined;
  if ((rule as string).length > MAX_RULE_LENGTH || (title as string).length > MAX_TITLE_LENGTH)
    return undefined;
  if (typeof severity !== 'string' || !SEVERITIES.has(severity)) return undefined;
  if (mode !== 'shadow' && mode !== 'enforce') return undefined;
  if (!Array.isArray(files) || !files.length || !files.every((glob) => text(glob)))
    return undefined;
  const regex = (source: unknown) => {
    if (typeof source !== 'string' || !source || source.length > MAX_PATTERN_LENGTH)
      return undefined;
    try {
      return new RegExp(source);
    } catch {
      return undefined;
    }
  };
  const compiled = regex(pattern);
  const exempt = unless === undefined ? undefined : regex(unless);
  if (!compiled || (unless !== undefined && !exempt)) return undefined;
  return {
    id,
    rule: rule as string,
    severity: severity as RuleCheck['severity'],
    title: title as string,
    files: files as string[],
    pattern: compiled,
    ...(exempt ? { unless: exempt } : {}),
    mode,
  };
}

const exec = promisify(execFile);

/** The checks committed at the PR's merge-base; undefined when the repo has none there. */
export async function loadRuleChecks(
  workspace: string,
  base: string,
  head: string,
): Promise<ReturnType<typeof parseRuleChecks> | undefined> {
  const git = async (...args: string[]) =>
    (await exec('git', args, { cwd: workspace, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
  const fork = (await git('merge-base', base, head)).trim();
  const listed = await git('ls-tree', '--name-only', fork, '--', RULE_CHECKS_PATH);
  if (!listed.trim()) return undefined;
  return parseRuleChecks(await git('show', `${fork}:${RULE_CHECKS_PATH}`));
}

// A context-local RegExp, so the vm timeout can interrupt catastrophic backtracking.
const MATCH = new Script(`
  const compiled = sources.map(([pattern, unless]) => [
    new RegExp(pattern),
    unless === undefined ? undefined : new RegExp(unless),
  ]);
  const pairs = [];
  lines.forEach(({ text, checks }, index) => {
    for (const id of checks) {
      const [pattern, unless] = compiled[id];
      if (pattern.test(text) && !unless?.test(text)) pairs.push(index, id);
    }
  });
  pairs;
`);

/** Undefined when matching outran its time budget, so a slow pattern cannot stall a review. */
export function runRuleChecks(
  checks: RuleCheck[],
  files: PrFile[],
  timeoutMs = MATCH_TIMEOUT_MS,
): RuleCheckHit[] | undefined {
  const lines: { path: string; line: number; text: string; checks: number[] }[] = [];
  for (const file of files) {
    const applicable = checks.flatMap((check, index) =>
      check.files.some((glob) => globMatches(glob, file.filename)) ? [index] : [],
    );
    if (!applicable.length || !file.patch) continue;
    for (const { added, line, content } of newSideLines(file.patch))
      if (added) lines.push({ path: file.filename, line, text: content, checks: applicable });
  }
  if (!lines.length) return [];
  const sources = checks.map((check) => [check.pattern.source, check.unless?.source]);
  let pairs: number[];
  try {
    pairs = MATCH.runInNewContext({ sources, lines }, { timeout: timeoutMs }) as number[];
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return undefined;
    throw error;
  }
  const hits: RuleCheckHit[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const { path, line } = lines[pairs[i]];
    hits.push({ check: checks[pairs[i + 1]], path, line });
  }
  return hits;
}

export function ruleCheckFinding({ check, path, line }: RuleCheckHit): Finding {
  return {
    path,
    line,
    severity: check.severity,
    kind: 'maintainability',
    confidence: 'high',
    title: check.title,
    body: `${check.rule}\n\nFound by the repository's deterministic check \`${check.id}\`.`,
  };
}

// The guideline pass anchors a violation near, not always on, the line a check hits.
const AGREEMENT_LINES = 3;

/**
 * Shadow evidence for promoting checks, matched by location only: per check, how many hits
 * have a guideline finding (for any rule) nearby, and how many guideline findings in audited
 * files a check covers no hit explains, so a check that misses every violation still shows.
 */
export function ruleCheckAgreement(
  checks: RuleCheck[],
  hits: RuleCheckHit[],
  compliance: Finding[],
  audited: Set<string>,
) {
  const near = (a: { path: string; line: number }, b: { path: string; line: number }) =>
    a.path === b.path && Math.abs(a.line - b.line) <= AGREEMENT_LINES;
  const byCheck = Object.fromEntries(checks.map((check) => [check.id, { hits: 0, agreed: 0 }]));
  hits = hits.filter((hit) => audited.has(hit.path));
  for (const hit of hits) {
    const row = byCheck[hit.check.id];
    row.hits++;
    if (compliance.some((finding) => near(finding, hit))) row.agreed++;
  }
  const covered = (path: string) =>
    audited.has(path) &&
    checks.some((check) => check.files.some((glob) => globMatches(glob, path)));
  const unexplained = compliance.filter(
    (finding) => covered(finding.path) && !hits.some((hit) => near(finding, hit)),
  ).length;
  return { checks: byCheck, unexplained };
}

/** A labelled line for `npm run rules:compile --examples`: the named check must hit it iff `violation`. */
export interface RuleCheckExample {
  check: string;
  path: string;
  text: string;
  violation: boolean;
}

interface CompiledCheckReport {
  id: string;
  kept: boolean;
  reason?: string;
  /** Hits on today's tracked files, as if every line were added: a broad pattern shows here. */
  existingHits: number;
  examples?: { caught: number; missed: number; falseHits: number };
}

const allAdded = (path: string, text: string): PrFile => {
  const lines = text.split('\n');
  return {
    filename: path,
    patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n'),
  };
};
const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
// The whole repository runs as added lines, so its budget is wider than a review's.
const COMPILE_TIMEOUT_MS = 30_000;

/**
 * Keeps a compiled check only when it parses, quotes a rule that a loaded doc states
 * verbatim, and agrees with every labelled example for it. Kept checks start in shadow.
 */
export function validateCompiledChecks(
  json: string,
  input: {
    docs: string[];
    repoFiles: { path: string; text: string }[];
    examples: RuleCheckExample[];
  },
): { checks: Record<string, unknown>[]; report: CompiledCheckReport[] } {
  const { checks, rejected } = parseRuleChecks(json);
  const docs = input.docs.map(squash);
  const repo = input.repoFiles.map(({ path, text }) => allAdded(path, text));
  const report: CompiledCheckReport[] = rejected.map((id) => ({
    id,
    kept: false,
    reason: 'malformed-or-duplicate',
    existingHits: 0,
  }));
  const kept: Record<string, unknown>[] = [];
  for (const check of checks) {
    const existing = runRuleChecks([check], repo, COMPILE_TIMEOUT_MS);
    const row: CompiledCheckReport = {
      id: check.id,
      kept: false,
      existingHits: existing?.length ?? 0,
    };
    const quote = /"([^"]{12,})"/.exec(check.rule)?.[1];
    const examples = input.examples.filter((example) => example.check === check.id);
    if (examples.length) {
      const hit = (example: RuleCheckExample) =>
        Boolean(runRuleChecks([check], [allAdded(example.path, example.text)])?.length);
      row.examples = {
        caught: examples.filter((example) => example.violation && hit(example)).length,
        missed: examples.filter((example) => example.violation && !hit(example)).length,
        falseHits: examples.filter((example) => !example.violation && hit(example)).length,
      };
    }
    if (!existing) row.reason = 'pattern-too-slow';
    else if (!quote || !docs.some((doc) => doc.includes(squash(quote))))
      row.reason = 'rule-not-quoted-verbatim';
    else if (row.examples && (row.examples.missed || row.examples.falseHits))
      row.reason = 'disagrees-with-examples';
    else {
      row.kept = true;
      kept.push({
        id: check.id,
        rule: check.rule,
        severity: check.severity,
        title: check.title,
        files: check.files,
        pattern: check.pattern.source,
        ...(check.unless ? { unless: check.unless.source } : {}),
        mode: 'shadow',
      });
    }
    report.push(row);
  }
  return { checks: kept, report };
}
