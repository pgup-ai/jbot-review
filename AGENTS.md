# jbot-review — agent guide

Agentic PR reviewer: an opencode server drives read-only review sessions over
a checked-out repo; structured JSON findings become diff-anchored GitHub
review comments. This file is the single source of truth for agents working
in this repo; `CLAUDE.md` just points here.

## Commands

- `npm test` — all tests (node:test via tsx); single file: `node --import tsx --test test/<file>.test.ts`
- `npm run typecheck` / `npm run lint` / `npm run format` — tsc, oxlint (deny-warnings), prettier (owns formatting)
- `npm run build` — esbuild bundles to `dist/` (committed; rebuild when src changes)
- `npm run replay` — render the review context from `fixtures/replay/` without posting
- `npm run eval` — score review quality against `fixtures/golden/` (see its README)

## Architecture

| Module                         | Responsibility                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/workflow/index.ts`        | GitHub Action entry: parse inputs → `runPrReview`                                               |
| `src/app/*`                    | Webhook-app entry: auth, clone, queue → `runPrReview`                                           |
| `src/shared/runner.ts`         | Orchestrator: context assembly → parallel sessions → finding pipeline → post. Keep it THIN.     |
| `src/shared/prompt.ts`         | ALL prompt text + pure assembly functions. No prompt strings anywhere else.                     |
| `src/shared/opencode.ts`       | opencode server lifecycle, sessions, response parsing (strict + repair)                         |
| `src/shared/review-context.ts` | PR metadata context + budgeted guideline discovery/preloading                                   |
| `src/shared/diff-context.ts`   | Budgeted diff-hunk embedding + the shared path-risk taxonomy (`PATH_PATTERNS`)                  |
| `src/shared/blast-radius.ts`   | Call sites of changed exported symbols (git grep, best-effort)                                  |
| `src/shared/filter.ts`         | Pure finding pipeline: noise files, dedupe, prior-thread suppression, confidence gate, verdicts |
| `src/shared/report.ts`         | Pure review-body layout: outside-the-diff findings section + multi-shard summary dedupe         |
| `src/shared/github.ts`         | GitHub REST/GraphQL: listing, posting, markers, thread resolution                               |
| `src/shared/eval.ts`           | Golden-set scoring (recall/precision/noise) for `scripts/eval-review.ts`                        |

## Invariants — do not break these

1. **Full-diff scope, always.** Every review run covers the complete
   base...head diff — as one session or as the UNION of parallel shards
   (`shardFilesForReview`: every changed file in exactly one shard, anchoring
   clamped in code). Never reintroduce delta-only review scope; "what changed
   since the last run" applies to the summary TEXT only
   (`buildSummaryScopeBlock`). Repeat-comment noise is handled downstream by
   `suppressPreviouslyReported`, not by narrowing the model's input.
2. **Trust-boundary rules live in code, not prompts.** Confidence gating,
   duplicate suppression, verdict application, and severity filtering are
   enforced in `filter.ts`; the prompt versions are guidance only.
3. **Auxiliary sessions fail open.** Lens passes, the addressed check, the
   guideline pass, and finding verification must never fail the run or drop
   findings when they break. A broken precision filter must not become a
   recall hole.
4. **Every injected context block has a hard byte budget** and lists what it
   omitted (diff hunks, guidelines, prior threads). No unbounded prompt
   fragments.
5. **Prompt assembly order:** base instructions → guidelines → PR context →
   optional lens → output reminder LAST (recency bias for small models).
   Schemas use concrete JSON examples, never union syntax. Each rule is
   stated exactly once.
6. **Markers are contracts.** `FINDING_MARKER` / `REVIEW_MARKER` /
   `ADDRESSED_MARKER` in `github.ts` are how prior runs recognize their own
   output; every posting path must include them (use the shared body
   builder).
7. **Three-dot diff only** (`base...head`): GitHub patches — which anchors
   are validated against — are merge-base-relative.
8. **Read-only enforced in three layers** for every opencode session: the
   `plan` agent, config-level `permission.edit/external_directory: deny`,
   and per-prompt `tools: { write/edit/patch: false }`. The review must
   never mutate the workspace; bash stays allowed for git diff/log/grep.
9. **Resolved threads never suppress** re-detections — a re-detection at a
   resolved location is a regression signal.
10. **Extract pure logic for tests.** New decision logic goes in a pure
    module (like `filter.ts`/`eval.ts`), unit-tested; `runner.ts` only wires.

## Conventions

- TypeScript ESM with `.ts` import specifiers (run via tsx); no new
  dependencies without clear need.
- Tests: node:test + `node:assert/strict`; pin invariants, not incidental
  prose (prompt tests assert structure and load-bearing phrases only).
- Prompt constants are template literals: escape backticks as `` \` `` and
  write `\\n` for a literal `\n` the model should see.
- Eval golden set: `fixtures/golden/`; `actual-findings.json` is gitignored —
  never commit run artifacts, they make the gate trivially green.

<!-- context7 -->

Use the `ctx7` CLI to fetch current documentation whenever the user asks about a library, framework, SDK, API, CLI tool, or cloud service -- even well-known ones like React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot. This includes API syntax, configuration, version migration, library-specific debugging, setup instructions, and CLI tool usage. Use even when you think you know the answer -- your training data may not reflect recent changes. Prefer this over web search for library docs.

Do not use for: refactoring, writing scripts from scratch, debugging business logic, code review, or general programming concepts.

## Context7 Steps

1. Resolve library: `npx ctx7@latest library <name> "<user's question>"` -- use the official library name with proper punctuation (e.g., "Next.js" not "nextjs", "Customer.io" not "customerio", "Three.js" not "threejs").
2. Pick the best match (ID format: `/org/project`) by exact name match, description relevance, code snippet count, source reputation (High/Medium preferred), and benchmark score (higher is better). If results do not look right, try alternate names or queries.
3. Fetch docs: `npx ctx7@latest docs <libraryId> "<user's question>"`.
4. Answer using the fetched documentation.

You MUST call `library` first to get a valid ID unless the user provides one directly in `/org/project` format. Use the user's full question as the query; specific and detailed queries return better results than vague single words. Do not run more than 3 commands per question. Do not include sensitive information (API keys, passwords, credentials) in queries.

For version-specific docs, use `/org/project/version` from the `library` output (e.g., `/vercel/next.js/v14.3.0`).

If a command fails with a quota error, inform the user and suggest `npx ctx7@latest login` or setting `CONTEXT7_API_KEY` env var for higher limits. Do not silently fall back to training data.

Run Context7 CLI requests outside Codex's default sandbox. If a Context7 CLI command fails with DNS or network errors such as ENOTFOUND, host resolution failures, or fetch failed, rerun it outside the sandbox instead of retrying inside the sandbox.

<!-- context7 -->

## Review MCP Stack

Keep the review stack tight. Use MCPs only when they provide a more authoritative source of truth than local code inspection.

### GitHub MCP

Use GitHub MCP as the primary live-state source for PR review workflows. Fetch PR review threads, flat issue comments, review submissions, commit checks, workflow runs, job steps, and logs before drawing conclusions about the current PR state.

When fixing or validating review feedback, compare the current diff against the live GitHub state instead of relying only on local files. Re-query unresolved review threads after pushes or replies, and stop based on the live thread state.

### Context7

Use Context7 when a change adds or modifies usage of an external API, SDK, framework, CLI, or cloud service such as OpenAI, Anthropic, GitHub Actions, or Octokit. Treat it as a docs verifier for current API contracts, request/response shapes, auth expectations, deprecations, and version-specific behavior.

Do not use Context7 as a general reviewer. If the code change does not touch an external contract, prefer local code inspection, tests, and repository patterns.

### GitHub Actions Logs

For dogfooding and failed review runs, inspect the exact workflow run, job steps, and job logs before deciding whether the issue is a code regression, provider/API failure, auth or configuration problem, or transient infrastructure failure.

Do not call a dogfood run validated from local checks alone when the posted bot comment, check result, or workflow logs are the actual validation surface.
