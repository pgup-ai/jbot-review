import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { isNoiseFile } from './filter.ts';
import { parseAddedLines } from './patch.ts';
import { startOpencode, runReview } from './opencode.ts';
import { buildReviewContext, discoverGuidelines } from './review-context.ts';
import {
  listPrFiles,
  listPrComments,
  listPrCommits,
  getCheckStatusSummary,
  postReview,
  decideVerdict,
} from './github.ts';
import type { Octokit } from './github.ts';
import type { Finding, Severity } from './types.ts';

const execAsync = promisify(exec);

const SEVERITY_RANK: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
  nit: 4,
};

export interface ReviewRunOptions {
  enhancedContext?: boolean;
  dryRun?: boolean;
  maxFindings?: number;
  minSeverity?: Severity;
  includePriorComments?: boolean;
}

export async function runPrReview(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  pullTitle: string;
  pullBody: string;
  workspace: string;
  model: string;
  apiKey: string;
  headSha?: string;
  options?: ReviewRunOptions;
  log: (msg: string) => void;
}): Promise<void> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    pullTitle,
    pullBody,
    workspace,
    model,
    apiKey,
    headSha,
    log,
  } = params;
  const options = normalizeOptions(params.options);

  const [providerID, ...rest] = model.split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) {
    throw new Error(`Invalid model "${model}"; expected "provider/model".`);
  }

  log(`Listing PR files for ${owner}/${repo}#${pullNumber}`);
  const rawFiles = await listPrFiles(octokit, owner, repo, pullNumber);
  log(`Files in PR: ${rawFiles.length} total`);
  const files = rawFiles.filter((f) => f.patch && !isNoiseFile(f.filename));
  if (files.length === 0) {
    log('No reviewable files after filtering.');
    return;
  }
  log(`Reviewable files: ${files.length} (noise filtered: ${rawFiles.length - files.length})`);

  const addable = new Map<string, Set<number>>();
  const changedFiles: string[] = [];
  for (const f of files) {
    addable.set(f.filename, parseAddedLines(f.patch));
    changedFiles.push(f.filename);
  }

  const guidelines = await discoverGuidelines(workspace);
  if (guidelines) log(`Guidelines loaded (${guidelines.length} bytes).`);

  const priorComments = options.includePriorComments
    ? await listPrComments(octokit, owner, repo, pullNumber)
    : [];
  if (!options.includePriorComments) log('Prior review comments excluded by configuration.');

  let prContext: string;
  let guidelinesForPrompt = guidelines;
  if (options.enhancedContext) {
    const commits = await listPrCommits(octokit, owner, repo, pullNumber);
    const checkSummary = headSha
      ? await getCheckStatusSummary(octokit, owner, repo, headSha)
      : 'Check status unavailable: PR head SHA was not provided.';
    prContext = buildReviewContext({
      pullTitle,
      pullBody,
      changedFiles,
      priorComments,
      commits,
      checkSummary,
      guidelines,
    });
    guidelinesForPrompt = '';
  } else {
    const commentsBlock =
      priorComments.length > 0
        ? '## Prior review comments\n' + priorComments.map((c) => `- ${c}`).join('\n')
        : '';
    prContext = [
      pullTitle && `Title: ${pullTitle}`,
      pullBody && `Description: ${pullBody}`,
      `Changed files: ${changedFiles.join(', ')}`,
      commentsBlock,
    ]
      .filter(Boolean)
      .join('\n');
  }

  log('Starting opencode server');
  const { client, stop } = await startOpencode(workspace, providerID, modelID, apiKey, log);
  try {
    try {
      const { stdout } = await execAsync('opencode models', { timeout: 5000 });
      log(`Available models:\n${stdout.trim()}`);
    } catch (e) {
      log(`(skipped opencode models: ${(e as Error).message})`);
    }

    log('Running review');
    const { summary, findings } = await runReview(
      client,
      model,
      prContext,
      guidelinesForPrompt,
      log,
    );
    const filteredFindings = filterFindings(findings, options);
    log(`Review complete: ${findings.length} finding(s), ${filteredFindings.length} after filters`);

    const inline: Finding[] = [];
    const orphaned: Finding[] = [];
    for (const f of filteredFindings) {
      if (addable.get(f.path)?.has(f.line)) inline.push(f);
      else orphaned.push(f);
    }
    const verdict = decideVerdict(filteredFindings);
    const body = buildBody(summary, filteredFindings, orphaned);

    if (options.dryRun) {
      log(
        `Dry run enabled; would post verdict=${verdict} inline=${inline.length} orphaned=${orphaned.length}`,
      );
      log(`Dry run review body:\n${body}`);
      if (inline.length > 0) {
        log(`Dry run inline comments:\n${inline.map(formatInlineFinding).join('\n\n')}`);
      }
      return;
    }

    log(`Posting review: verdict=${verdict} inline=${inline.length} orphaned=${orphaned.length}`);
    await postReview(octokit, owner, repo, pullNumber, verdict, body, inline);
    log('Review posted.');
  } finally {
    stop();
  }
}

function normalizeOptions(options: ReviewRunOptions | undefined): Required<ReviewRunOptions> {
  return {
    enhancedContext: options?.enhancedContext ?? false,
    dryRun: options?.dryRun ?? false,
    maxFindings: options?.maxFindings ?? 0,
    minSeverity: options?.minSeverity ?? 'nit',
    includePriorComments: options?.includePriorComments ?? true,
  };
}

function filterFindings(findings: Finding[], options: Required<ReviewRunOptions>): Finding[] {
  const maxRank = SEVERITY_RANK[options.minSeverity];
  const filtered = findings.filter((finding) => SEVERITY_RANK[finding.severity] <= maxRank);
  return options.maxFindings > 0 ? filtered.slice(0, options.maxFindings) : filtered;
}

function formatInlineFinding(finding: Finding): string {
  return `- ${finding.path}:${finding.line} ${finding.severity} ${finding.title}\n  ${finding.body}`;
}

function buildBody(summary: string, all: Finding[], orphaned: Finding[]): string {
  const total = all.length;
  const lines = ['## jbot code review', '', summary || 'No summary provided.', ''];
  if (total === 0) {
    lines.push('_No issues found._');
  } else {
    const counts = countBySeverity(all);
    lines.push(`**${total} finding(s)** | ${counts}`, '');
  }
  if (orphaned.length > 0) {
    lines.push('### Findings (outside the diff)');
    for (const f of orphaned) {
      lines.push(`- **${f.severity}** ${f.title} — \`${f.path}:${f.line}\``);
      lines.push(`  ${f.body}`);
    }
  }
  return lines.join('\n');
}

function countBySeverity(findings: Pick<Finding, 'severity'>[]): string {
  const tags = ['P0', 'P1', 'P2', 'P3', 'nit'] as const;
  return tags
    .map((t) => {
      const n = findings.filter((f) => f.severity === t).length;
      return n > 0 ? `${n}× ${t}` : null;
    })
    .filter(Boolean)
    .join(' · ');
}
