import type { Finding } from "./types.ts";

import { Octokit as CoreOctokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

const Review = CoreOctokit.plugin(paginateRest, restEndpointMethods);
export type Octokit = InstanceType<typeof Review>;

export interface PrFile {
  filename: string;
  patch?: string;
}

export type Verdict = "APPROVE" | "COMMENT" | "REQUEST_CHANGES";

/** Lists changed files (with their patches) in the pull request. */
export async function listPrFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PrFile[]> {
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  return files.map((f) => ({ filename: f.filename, patch: f.patch }));
}

/**
 * Decision rubric (biased toward approval), computed in code rather than left
 * to the model:
 *   - any critical            -> REQUEST_CHANGES (blocks merge)
 *   - one or more warnings    -> COMMENT (does not block)
 *   - suggestions only / none -> APPROVE
 */
export function decideVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === "critical")) return "REQUEST_CHANGES";
  if (findings.some((f) => f.severity === "warning")) return "COMMENT";
  return "APPROVE";
}

/** Posts one review; inline-anchorable findings become inline comments. */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  verdict: Verdict,
  body: string,
  inlineFindings: Finding[],
): Promise<void> {
  const comments = inlineFindings.map((f) => ({
    path: f.path,
    line: f.line,
    side: "RIGHT" as const,
    body: `**${label(f.severity)} — ${f.title}**\n\n${f.body}`,
  }));

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: verdict,
      body,
      comments,
    });
  } catch {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: verdict,
        body: `${body}\n\n_(inline comments omitted — failed to anchor to diff lines)_`,
      });
    } catch {
      // Both attempts failed; the caller handles logging.
      throw new Error("Failed to post review to GitHub");
    }
  }
}

function label(severity: Finding["severity"]): string {
  return severity[0].toUpperCase() + severity.slice(1);
}
