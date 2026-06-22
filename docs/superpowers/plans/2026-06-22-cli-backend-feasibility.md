# CLI Backend Feasibility Research and Spike Plan

> **For agentic workers:** This is a research handoff, not an implementation
> plan to execute blindly. Re-check current CLI docs before coding because CLI
> surfaces and hosted-agent terms change quickly.

**Goal:** Decide whether `jbot-review` should support shell-driven agent CLIs as
review backends alongside the current OpenCode SDK/server path.

**Scope:** Feasibility, ranking, and spike criteria for Codex CLI, Claude Code,
Devin CLI, CommandCode CLI, and other noninteractive coding-agent CLIs. No code
changes are implied by this document.

**Context7 status:** Context7 was requested by repo policy for current CLI docs,
but `npx ctx7@latest library "Devin CLI" ...` failed with a monthly quota error.
Primary vendor docs were used instead. For a future refresh, run
`npx ctx7@latest login` or set `CONTEXT7_API_KEY`.

## Current Architecture

`jbot-review` is already close to having an internal "agent backend" seam, but
that seam is currently implicit and OpenCode-shaped:

- `src/workflow/index.ts` parses GitHub Action inputs and calls `runPrReview`.
- `src/app/*` handles the hosted-app/webhook path and also reaches
  `runPrReview`.
- `src/shared/runner.ts` assembles repository, PR, diff, guideline, prior-thread,
  and shard context. It starts OpenCode, runs review sessions and auxiliary
  passes, then sends findings into filtering and posting.
- `src/shared/opencode.ts` owns OpenCode server lifecycle, provider config,
  session creation, `promptAsync`, wait/poll behavior, abort handling, JSON
  extraction, repair, and usage extraction.
- `src/shared/prompt.ts` owns all review prompt text and demands raw structured
  JSON with `summary` and `findings`.
- `src/shared/filter.ts` is backend-neutral after findings exist. It suppresses
  noise files, dedupes, applies prior-thread suppression, gates confidence, and
  computes verdicts.
- `src/shared/github.ts` is backend-neutral after filtered findings exist. It
  validates anchors, uses markers, posts review comments, resolves/replies to
  threads, and preserves the GitHub-facing contract.
- `src/shared/config.ts`, `action.yml`, `.env.example`, and docs expose the
  provider/auth matrix. Any backend change has to be wired through this matrix.

OpenCode currently provides more than "an API call":

- Session lifecycle via server start/stop, client creation, session creation, and
  session-scoped prompting.
- Provider/model/key configuration in one generated config surface.
- Read-only enforcement in three layers: plan agent, config permission denies,
  and per-prompt tool flags disabling write/edit/patch.
- Tool availability that still permits useful read-only shell work such as
  `git diff`, `git log`, and `git grep`.
- Completion waiting, fallback polling, abort/timeout behavior, and failure
  classification.
- Strict JSON parsing plus repair for malformed main review output.
- Usage metadata extraction when the provider exposes it.

The existing finding pipeline can remain mostly unchanged if a new backend emits
the same structured review JSON. The hard part is making each CLI satisfy the
same operational contract as OpenCode.

## Backend Contract

A CLI backend should not be accepted as a primary posting source unless it
satisfies this contract:

```ts
export interface ReviewAgentBackend {
  name: string;
  runReview(input: {
    cwd: string;
    prompt: string;
    timeoutMs: number;
    abortSignal: AbortSignal;
    metadata: {
      owner: string;
      repo: string;
      pullNumber: number;
      shardId?: string;
      passKind: 'main' | 'lens' | 'guideline' | 'verify' | 'addressed';
    };
  }): Promise<{
    text: string;
    findingsJson?: unknown;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      costUsd?: number;
    };
    provider?: string;
    model?: string;
    sessionId?: string;
    rawLogPath?: string;
    exitCode?: number;
    timedOut?: boolean;
  }>;
}
```

Operational requirements:

- Noninteractive execution: no prompts, no REPL, no browser/device-code flow
  during review.
- Deterministic final output: either native JSON/schema mode or a stable final
  answer channel that can be parsed without tool traces.
- Read-only workspace guarantee: no edits, patching, generated files, or hidden
  config mutations in the checkout.
- Useful read-only shell: allow at least `git diff`, `git log`, `git grep`, and
  file reads, or the review quality will regress.
- Timeout and cancellation: parent process can kill the CLI and all children.
- Exit-code semantics: distinguish success, model refusal, auth failure, rate
  limit, invalid prompt, timeout, and truncated output where possible.
- Log capture: stdout, stderr, raw final text, and structured traces should be
  captured without leaking secrets into GitHub comments.
- Usage reporting: token/cost metadata should be captured when available, and
  explicitly marked unavailable otherwise.

## Ranking

| Rank | CLI                                       | Noninteractive support                                           | Structured output                                                            | Read-only/security fit                                                         | Observability                                                        | Recommendation                                           |
| ---- | ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------- |
| 1    | Codex CLI                                 | Strong: `codex exec` is designed for noninteractive automation   | Strong: output schema and last-message output are documented                 | Good, but CI secret handling and tool permissions still need a spike           | Good: JSONL/structured streams and code-review cookbook path         | Best first primary-backend spike                         |
| 2    | Claude Code                               | Strong: `claude -p` headless mode                                | Strong: JSON/stream-json and JSON schema are documented                      | Needs permission-mode verification for jbot's read-only-plus-git-shell model   | Good: JSON result and usage metadata                                 | Strong second candidate                                  |
| 3    | Devin CLI                                 | Strong: `devin -p`, `--prompt-file`, `--export`, and `acp` exist | Medium: no documented final-answer schema mode; ATIF export may be parseable | Strong: permissions, profiles, and sandbox/autonomous mode are well documented | Medium/strong: ATIF export includes richer transcript and usage/cost | Promising tier-2 spike, especially as auxiliary lens     |
| 4    | CommandCode CLI                           | Strong: `cmd -p`/`--print`, stdin, max turns, trust flags        | Weak/unknown: no clearly documented schema final-answer mode found           | Mixed: default headless blocks writes and shell; `--yolo` is too broad         | Limited compared with Codex/Claude/Devin                             | Auxiliary-only unless JSON and shell contract are proven |
| 5    | Gemini CLI / Qwen Code                    | Plausible: documented headless prompt modes                      | Medium/unknown: JSON output exists, schema guarantees need verification      | Needs permission and sandbox proof                                             | Unknown to medium                                                    | Worth later spike if provider diversity matters          |
| 6    | OpenCode CLI                              | Strong: `opencode run` and JSON format                           | Good, but redundant with existing SDK/server path                            | Existing SDK path is stronger and already integrated                           | Existing SDK path is better                                          | Do not replace SDK with CLI without a specific reason    |
| 7    | Cursor CLI                                | Strong: headless agent mode exists                               | Weak/medium: schema support appears missing or limited                       | Ask/read-only modes need current verification                                  | Mixed; cost/metadata gaps reported                                   | Experimental only                                        |
| 8    | Goose / Continue / CodeBuddy / Letta Code | Headless modes exist                                             | Unknown or weak for strict schema                                            | Needs proof                                                                    | Unknown                                                              | Investigate only after top candidates                    |
| 9    | Aider                                     | Scriptable, but edit-oriented                                    | Weak for structured review output                                            | Poor fit for no-mutation review                                                | Limited for this use case                                            | Not recommended as primary backend                       |

## Devin CLI Notes

Devin CLI is more feasible than a generic "interactive agent CLI" because it
has explicit noninteractive commands and a permission system.

Relevant documented surfaces:

- `devin -p "prompt"` runs a single-turn session, prints the response to stdout,
  and exits. This is the important path for CI scripts and automation.
- `devin -- your prompt here` starts the interactive REPL preloaded with a
  prompt, so it is not the correct review backend path.
- `--prompt-file <FILE>` lets the review prompt be passed without shell quoting
  risk.
- `--permission-mode` supports Normal, Accept Edits, Bypass, and Autonomous.
- Normal mode auto-approves read-only tools and asks for write/execute.
- Autonomous mode requires `--sandbox`; shell commands and fetches run inside an
  OS-level sandbox, while direct edit/write still prompts.
- Bypass mode auto-approves all tool calls and should not be used for posted
  review runs.
- Plan and Ask profiles are read-only profiles. Plan mode has read-only tools
  such as grep, glob, read, todo, ask-user-question, and exit-plan-mode.
- Permissions can be configured by scope and by tool. Documented tool names
  include `read`, `edit`, `grep`, `glob`, and `exec`.
- Config files live in global and repo-local locations such as
  `~/.config/devin/config.json`, `.devin/config.json`, and
  `.devin/config.local.json`.
- Config can include model, permissions, MCP servers, gitignore behavior,
  auto-update behavior, and sandbox network allow/deny lists.
- `--export [PATH]` writes an ATIF transcript. Recent changelog notes say ATIF
  includes token/cost data and richer per-step usage/cost fields.
- `devin acp` runs Devin as an Agent Client Protocol server over stdio using
  JSON-RPC. This is likely better for a durable integration than scraping a TTY,
  but it is a larger integration than a simple CLI adapter.

Main Devin risks for `jbot-review`:

- No documented `--output-format json` or JSON Schema mode for the final answer
  from `devin -p` was found in the docs reviewed.
- `devin list --format json` exists, but that is session listing, not the review
  result.
- If final stdout contains prose, markdown fences, tool summaries, or trace
  snippets, `jbot-review` would have to rely on the same best-effort extraction
  and repair path used for model output. That is acceptable for a spike, but weak
  for a primary posting backend.
- First-time auth still has to be solved outside CI. Docs include
  `devin auth login`, `auth status`, and manual-token flow options for
  remote/SSH usage.
- Auto-update behavior should be disabled or pinned for CI reproducibility.
- The sandbox and permission config have to be tested against the exact jbot
  workflow: full diff read, file reads, `git diff`, `git log`, `git grep`, no
  writes, no edits, no external secret access.

Suggested Devin spike command shape:

```bash
devin \
  --permission-mode normal \
  --prompt-file /tmp/jbot-review-prompt.txt \
  --export /tmp/jbot-review-devin.atif \
  -p
```

If the CLI requires the prompt as the value of `-p`, prefer:

```bash
devin \
  --permission-mode normal \
  --export /tmp/jbot-review-devin.atif \
  -p "$(cat /tmp/jbot-review-prompt.txt)"
```

The spike should prefer a repo-local `.devin/config.local.json` generated in a
temporary test checkout, not committed, with only the minimum read and git
execution permissions needed for review.

## Option Comparison

### Keep OpenCode SDK and add providers

This remains the lowest-risk production path. The repo already has OpenCode
lifecycle, permission, parsing, and usage behavior. More first-class providers
can be added through the existing provider matrix without introducing process
management, shell quoting, CLI update, or auth persistence problems.

Choose this when the desired model/provider is available through OpenCode.

### Add a generic CLI backend abstraction

This is feasible, but only if treated as a strict backend contract, not as
"spawn anything and parse stdout." The abstraction should live below
`runner.ts`, preserving the existing prompt, filtering, and GitHub posting
pipeline.

This becomes worthwhile if at least one CLI proves all of:

- Stable noninteractive mode.
- Schema-compatible final output.
- No workspace mutation.
- Reliable timeout/cancel behavior.
- CI-friendly auth.
- Enough observability for failures and cost control.

### One-off Codex CLI experiment

This is the least risky prototype. Codex has the best currently documented
alignment with `jbot-review` because it has explicit noninteractive execution,
schema-constrained output, JSONL streams, and an official code-review cookbook
for CI.

Keep it behind a feature flag and dry-run mode until it passes golden fixtures
and mutation checks.

### External CLIs as auxiliary lens passes

This is safer than using them as the primary posting source. A CLI can generate
candidate findings or a second-opinion lens, but OpenCode remains the source
that produces posted findings. Broken auxiliary passes already fail open by repo
invariant.

This is a good fit for Devin, CommandCode, Cursor, Gemini, Qwen, Goose, and
Continue while their schema and permission contracts are unproven.

### Do nothing

Do nothing unless a CLI offers a stable noninteractive JSON contract or there is
a concrete provider/model gap that OpenCode cannot cover. A review bot that
posts comments needs predictable output and failure behavior more than it needs
maximum agent-brand coverage.

## Recommendation

Conditional yes: `jbot-review` can support CLI backends, but the production
bar should be high. The existing pipeline can stay intact if the backend emits
the current review JSON shape. The risky work is around execution, permissions,
auth, observability, and CI reliability.

Recommended order:

1. Keep OpenCode SDK/server as the default and stable path.
2. Build a dry-run-only Codex CLI adapter spike first.
3. Use the same adapter contract to test Claude Code if Codex succeeds or if
   provider diversity is needed.
4. Spike Devin CLI as a tier-2 candidate focused on permission/sandbox quality
   and ATIF observability, not as the first primary backend.
5. Keep CommandCode and other CLIs as auxiliary/lens candidates until they prove
   schema-constrained final output.

What would make CLI backends a bad idea for this repo:

- The CLI cannot produce strict JSON or a stable final answer channel.
- The CLI needs interactive auth during a review run.
- The CLI writes files, updates config, or mutates the checkout by default.
- The CLI mixes tool traces into stdout in a way that breaks parsing.
- Timeout or cancellation leaves child processes running.
- Usage, model, and failure metadata are unavailable enough that review failures
  become hard to diagnose.
- Vendor terms or product behavior do not support unattended CI automation for
  this use case.

## Minimal Spike Deliverables

### Phase 1: Contract and fixture harness

- Define an internal backend result shape equivalent to the interface above.
- Add a dry-run harness that feeds an existing replay/golden prompt to a backend
  and captures stdout, stderr, exit code, elapsed time, usage, and raw logs.
- Do not post GitHub comments from CLI output during the spike.

Validation:

- Prompt assembly remains in `src/shared/prompt.ts`.
- Filtering and GitHub posting APIs are not modified.
- The harness can compare parsed findings against existing golden fixtures.

### Phase 2: Codex CLI primary spike

- Run with noninteractive execution and schema-constrained output.
- Pass prompt via file/stdin where possible to avoid shell quoting issues.
- Capture final JSON separately from logs.
- Enforce timeout and process-tree kill.
- Verify `git status --porcelain` is unchanged after each run.

Validation:

- 10 consecutive fixture runs produce parseable JSON.
- No workspace mutation.
- No interactive prompt or hang.
- Findings can flow through existing `filter.ts` logic unchanged.
- Usage/model metadata is captured or explicitly marked unavailable.

### Phase 3: Devin CLI tier-2 spike

- Authenticate once outside the review run.
- Use `devin -p` or `--prompt-file` for single-turn noninteractive execution.
- Use Normal or read-only profile permissions first; do not use Bypass.
- Test Autonomous with `--sandbox` only after Normal mode behavior is understood.
- Generate ATIF export and inspect whether final answer, session id, model,
  token usage, cost, and errors are machine-readable enough.
- Prove a minimal permission config that allows file reads and safe git commands
  while denying edits, writes, destructive exec, and secret-file reads.

Validation:

- No workspace mutation across repeated runs.
- Final stdout or ATIF contains a reliably extractable review JSON block.
- Permission prompts never appear in CI mode.
- Sandbox/network behavior does not block required local repo inspection.
- Auth can be prepared on a runner/VPS without exposing credentials to logs.

### Phase 4: Compare and decide

- Run the same fixture set through OpenCode, Codex CLI, Claude Code, and Devin
  CLI if available.
- Compare parse success, recall, precision, runtime, cost metadata, failure
  modes, and mutation checks.
- Promote only candidates that pass all noninteractive and no-mutation gates.

## Sources

- Codex CLI noninteractive docs:
  https://developers.openai.com/codex/noninteractive
- Codex CLI reference:
  https://developers.openai.com/codex/cli/reference
- Codex code-review cookbook:
  https://developers.openai.com/cookbook/examples/codex/build_code_review_with_codex_sdk
- Codex GitHub Action:
  https://developers.openai.com/codex/github-action
- Claude Code headless mode:
  https://code.claude.com/docs/en/headless
- Devin CLI quickstart:
  https://docs.devin.ai/cli
- Devin CLI essential commands:
  https://docs.devin.ai/cli/essential-commands
- Devin CLI commands and flags:
  https://docs.devin.ai/cli/reference/commands
- Devin CLI permissions:
  https://docs.devin.ai/cli/reference/permissions
- Devin CLI configuration:
  https://docs.devin.ai/cli/reference/configuration/config-file
- Devin CLI changelog:
  https://docs.devin.ai/cli/changelog/stable
- CommandCode headless mode:
  https://commandcode.ai/docs/core-concepts/headless
- CommandCode CLI reference:
  https://commandcode.ai/docs/reference/cli
- CommandCode security:
  https://commandcode.ai/docs/resources/security
- Gemini CLI headless docs:
  https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
- Qwen Code headless docs:
  https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
- OpenCode CLI docs:
  https://opencode.ai/docs/cli/
- Cursor CLI headless docs:
  https://cursor.com/docs/cli/headless
- Cursor CLI output format docs:
  https://cursor.com/docs/cli/reference/output-format
- Goose headless docs:
  https://goose-docs.ai/docs/tutorials/headless-goose/
- Continue CLI headless docs:
  https://docs.continue.dev/cli/headless-mode
- Aider scripting docs:
  https://aider.chat/docs/scripting.html
- Aider options docs:
  https://aider.chat/docs/config/options.html
- CodeBuddy headless docs:
  https://www.codebuddy.ai/docs/cli/headless
- Letta Code headless docs:
  https://docs.letta.com/letta-code/headless/
