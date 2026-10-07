import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

// Repo-controlled regexes run on PR-controlled lines: bound both.
const MAX_CHECKS = 200;
const MAX_PATTERN_LENGTH = 500;
const MAX_LINE_LENGTH = 1000;
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
  for (const [index, row] of rows.slice(0, MAX_CHECKS).entries()) {
    const check = parseCheck(row);
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

export function runRuleChecks(checks: RuleCheck[], files: PrFile[]): RuleCheckHit[] {
  const hits: RuleCheckHit[] = [];
  for (const file of files) {
    const applicable = checks.filter((check) =>
      check.files.some((glob) => globMatches(glob, file.filename)),
    );
    if (!applicable.length || !file.patch) continue;
    for (const { added, line, content } of newSideLines(file.patch)) {
      if (!added) continue;
      const text = content.slice(0, MAX_LINE_LENGTH);
      for (const check of applicable)
        if (check.pattern.test(text) && !check.unless?.test(text))
          hits.push({ check, path: file.filename, line });
    }
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
 * Shadow evidence for promoting a check: how many of its hits the guideline pass also
 * reported, and how many guideline findings in the check's files no check hit explains.
 */
export function ruleCheckAgreement(hits: RuleCheckHit[], compliance: Finding[]) {
  const near = (a: { path: string; line: number }, b: { path: string; line: number }) =>
    a.path === b.path && Math.abs(a.line - b.line) <= AGREEMENT_LINES;
  const byCheck = new Map<string, { hits: number; agreed: number }>();
  for (const hit of hits) {
    const row = byCheck.get(hit.check.id) ?? { hits: 0, agreed: 0 };
    row.hits++;
    if (compliance.some((finding) => near(finding, hit))) row.agreed++;
    byCheck.set(hit.check.id, row);
  }
  const unexplained = compliance.filter(
    (finding) =>
      hits.some((hit) => hit.path === finding.path) && !hits.some((hit) => near(finding, hit)),
  ).length;
  return { checks: Object.fromEntries(byCheck), unexplained };
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
    const row: CompiledCheckReport = {
      id: check.id,
      kept: false,
      existingHits: runRuleChecks([check], repo).length,
    };
    const quote = /"([^"]{12,})"/.exec(check.rule)?.[1];
    const examples = input.examples.filter((example) => example.check === check.id);
    if (examples.length) {
      const hit = (example: RuleCheckExample) =>
        runRuleChecks([check], [allAdded(example.path, example.text)]).length > 0;
      row.examples = {
        caught: examples.filter((example) => example.violation && hit(example)).length,
        missed: examples.filter((example) => example.violation && !hit(example)).length,
        falseHits: examples.filter((example) => !example.violation && hit(example)).length,
      };
    }
    if (!quote || !docs.some((doc) => doc.includes(squash(quote))))
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
