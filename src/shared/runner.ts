import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { isNoiseFile } from './filter.ts';
import { parseModelName } from './model.ts';
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
  listPriorJbotThreads,
  formatPriorJbotThreadsForPrompt,
  postAddressedThreadReply,
  resolveReviewThread,
} from './github.ts';
import type { Octokit, PriorJbotThread } from './github.ts';
import type { AddressedPriorComment, Finding, Severity } from './types.ts';

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

  const { providerID, modelID } = parseModelName(model);

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
  const priorJbotThreads = options.includePriorComments
    ? await safeListPriorJbotThreads(octokit, owner, repo, pullNumber, log)
    : [];
  if (priorJbotThreads.length > 0) {
    log(`Prior jbot-review threads available for addressed checks: ${priorJbotThreads.length}`);
  }
  const priorJbotThreadBlock = formatPriorJbotThreadsForPrompt(priorJbotThreads);

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
    if (priorJbotThreadBlock) prContext = `${prContext}\n\n${priorJbotThreadBlock}`;
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
      priorJbotThreadBlock,
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
    const { summary, findings, addressedPriorComments } = await runReview(
      client,
      model,
      prContext,
      guidelinesForPrompt,
      log,
    );
    const filteredFindings = filterFindings(findings, options);
    log(
      `Review complete: ${findings.length} finding(s), ${filteredFindings.length} after filters, ${addressedPriorComments.length} addressed prior comment(s)`,
    );

    const inline: Finding[] = [];
    const orphaned: Finding[] = [];
    for (const f of filteredFindings) {
      if (addable.get(f.path)?.has(f.line)) inline.push(f);
      else orphaned.push(f);
    }
    const verdict = decideVerdict(filteredFindings);
    const body = buildBody(summary, filteredFindings, orphaned, model, headSha);

    if (options.dryRun) {
      log(
        `Dry run enabled; would post verdict=${verdict} inline=${inline.length} orphaned=${orphaned.length}`,
      );
      log(`Dry run review body:\n${body}`);
      if (inline.length > 0) {
        log(`Dry run inline comments:\n${inline.map(formatInlineFinding).join('\n\n')}`);
      }
      if (addressedPriorComments.length > 0) {
        log(
          `Dry run addressed prior comments:\n${addressedPriorComments
            .map(formatAddressedPriorComment)
            .join('\n')}`,
        );
      }
      return;
    }

    log(`Posting review: verdict=${verdict} inline=${inline.length} orphaned=${orphaned.length}`);
    await postReview(octokit, owner, repo, pullNumber, verdict, body, inline);
    log('Review posted.');
    await acknowledgeAddressedPriorComments({
      octokit,
      owner,
      repo,
      pullNumber,
      headSha,
      priorJbotThreads,
      addressedPriorComments,
      log,
    });
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
  if (options.maxFindings <= 0) return filtered;
  return [...filtered]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, options.maxFindings);
}

function formatInlineFinding(finding: Finding): string {
  const indentedBody = finding.body.replace(/\n/g, '\n  ');
  return `- ${finding.path}:${finding.line} ${finding.severity} ${finding.title}\n  ${indentedBody}`;
}

function formatAddressedPriorComment(comment: AddressedPriorComment): string {
  const commit = comment.addressedByCommit ? ` (${comment.addressedByCommit})` : '';
  const note = comment.note ? `: ${comment.note}` : '';
  return `- ${comment.id}${commit}${note}`;
}

async function safeListPriorJbotThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  log: (msg: string) => void,
): Promise<PriorJbotThread[]> {
  try {
    return await listPriorJbotThreads(octokit, owner, repo, pullNumber);
  } catch (error) {
    log(
      `Prior jbot-review thread lookup skipped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

async function acknowledgeAddressedPriorComments(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha?: string;
  priorJbotThreads: PriorJbotThread[];
  addressedPriorComments: AddressedPriorComment[];
  log: (msg: string) => void;
}): Promise<void> {
  if (params.addressedPriorComments.length === 0 || params.priorJbotThreads.length === 0) return;

  const threadsById = new Map(params.priorJbotThreads.map((thread) => [thread.id, thread]));
  const seen = new Set<string>();
  for (const addressed of params.addressedPriorComments) {
    if (seen.has(addressed.id)) continue;
    seen.add(addressed.id);

    const thread = threadsById.get(addressed.id);
    if (!thread) {
      params.log(`Skipping addressed prior comment with unknown thread id: ${addressed.id}`);
      continue;
    }

    const addressedByCommit = addressed.addressedByCommit || params.headSha || 'the latest commit';
    try {
      await postAddressedThreadReply({
        octokit: params.octokit,
        owner: params.owner,
        repo: params.repo,
        pullNumber: params.pullNumber,
        thread,
        addressedByCommit,
        note: addressed.note,
      });
      params.log(`Posted addressed reply for prior thread ${thread.id}`);
    } catch (error) {
      params.log(
        `Failed to reply to addressed prior thread ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    if (thread.isResolved) continue;
    try {
      await resolveReviewThread(params.octokit, thread.id);
      params.log(`Resolved prior jbot-review thread ${thread.id}`);
    } catch (error) {
      params.log(
        `Failed to resolve prior jbot-review thread ${thread.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function buildBody(
  summary: string,
  all: Finding[],
  orphaned: Finding[],
  model: string,
  headSha?: string,
): string {
  const total = all.length;
  const lines = ['## jbot code review', '', summary || 'No summary provided.', ''];
  const guidance = getMergeGuidance(all);
  lines.push(`**Review state:** ${guidance.state}`);
  lines.push(`**Merge guidance:** ${guidance.mergeGuidance}`);
  if (headSha) lines.push(`**Reviewed head:** \`${headSha.slice(0, 12)}\``);
  lines.push('');
  if (total === 0) {
    lines.push('_No new findings._');
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
  lines.push('', `<sup>Reviewed with \`${model}\`.</sup>`);
  return lines.join('\n');
}

function getMergeGuidance(findings: Pick<Finding, 'severity'>[]): {
  state: string;
  mergeGuidance: string;
} {
  if (findings.length === 0) {
    return {
      state: 'Good to go from jbot-review',
      mergeGuidance: 'No new findings were found in this review run.',
    };
  }

  const hasBlockingFinding = findings.some(
    (finding) => SEVERITY_RANK[finding.severity] <= SEVERITY_RANK.P2,
  );
  if (hasBlockingFinding) {
    return {
      state: 'Needs changes before approval',
      mergeGuidance: 'Address the P0/P1/P2 findings before treating this PR as ready to approve.',
    };
  }

  return {
    state: 'Mergeable with non-blocking comments',
    mergeGuidance: 'Only P3/nit findings were found; jbot-review does not consider these blocking.',
  };
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
