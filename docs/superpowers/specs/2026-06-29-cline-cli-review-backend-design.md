# Cline CLI review backend (local-token auth) — design

- **Status:** approved (design + POC), implementing
- **Date:** 2026-06-29
- **Scope:** add the Cline CLI as a pluggable CLI review backend, authenticated by a
  local `cline auth` token (Cline account, ChatGPT subscription via `openai-codex`, or
  BYOK) carried into CI via a GitHub secret.

## Goal

Let jbot-review drive review sessions through the `cline` CLI (like `devin`,
`command-code`, `cursor`, and `codex`), billed against whatever provider the operator
signed into locally. The credential is extracted once from a local `cline auth`,
stored as a GitHub secret, and written into the runner at runtime so `cline` runs
read-only review prompts.

### Non-goals

- No change to the review pipeline, prompts, finding contracts, or markers.
- No dynamic Cline model listing — use cline's default model for the mode (the local
  `model`/`reasoning` are stripped; override with `JBOT_REVIEW_MODEL=<mode>/<model>`).
- No `--hooks-dir` read-approval policy (see Prompt delivery — argv, not a hook).

The two billing modes are **two jbot providers** — `cline` (pay-as-you-go) and
`cline-pass` (subscription) — sharing one backend and the `CLINE_AUTH_JSON` secret,
differing only by `--provider` (= the provider id) and their model namespace. The
operator selects the mode via `JBOT_REVIEW_PROVIDER`.

## Background — two POC findings that shape the design

A live POC against the installed `cline` (v3.0.34) settled two things:

1. **Read-only is enforced by `--auto-approve false`, not `--plan`.** With
   `--plan --auto-approve true`, plan mode happily wrote a file; with
   `--plan --auto-approve false` the same write was denied (headless = no approver =
   deny). So `--auto-approve false` is the load-bearing read-only control (invariant
   #8); `--plan` is a secondary behavioral layer. `--auto-approve true` / `--yolo` are
   never emitted.

2. **Cline cannot receive jbot prompts on stdin headlessly.** jbot's review prompts
   routinely exceed Linux's 128KB single-argv limit (`MAX_ARG_STRLEN`), which is why
   every other CLI backend feeds the prompt on stdin (see `cursor.ts` runCursorPrompt).
   Cline does **not** read stdin under `--json` in any spawn form — seven variants
   (Node pipe, file-fd, `cat | cline`, `cline < file`, ±positional arg) all fail
   `"requires a prompt argument or piped stdin"`; its stdin detection only fires under
   an interactive TTY. Only a **positional argv** prompt works. So cline is delivered
   the prompt via argv, and its guideline budget is capped so the prompt stays
   argv-safe (see Prompt delivery).

## Architecture — slots into the existing CLI-backend pattern

CLI backends are pluggable; Cline is the fifth tenant. One module plus six mechanical
wiring points:

| Layer                      | Codex                    | Cline (new)                          |
| -------------------------- | ------------------------ | ------------------------------------ |
| Backend module             | `src/shared/codex.ts`    | `src/shared/cline.ts`                |
| Dispatch                   | `isCodexProvider`        | `isClineProvider`                    |
| Credential write (runtime) | `writeCodexAuth`         | `writeClineAuth`                     |
| Provider entry             | `PROVIDERS.codex`        | `PROVIDERS.cline`                    |
| Action input               | `codex-auth`             | `cline-auth`                         |
| Workflow secret            | `CODEX_AUTH_JSON`        | `CLINE_AUTH_JSON`                    |
| CLI binary                 | `npm i -g @openai/codex` | `npm i -g cline`                     |
| Prompt delivery            | stdin (`-`)              | **argv** (capped budget — stdin N/A) |
| Home isolation             | `CODEX_HOME` env         | **`HOME` env** (`~/.cline`)          |
| Model response             | `--output-last-message`  | **`run_result.text`** from `--json`  |

## Detailed design

### 1. Credential flow: local → secret → runner → CLI

- **Source:** `~/.cline/data/settings/providers.json` after a local `cline auth`. The
  OAuth token (`settings.auth.{accessToken,refreshToken,accountId,expiresAt}`) lives in
  this file in plaintext, carryable like codex's `auth.json`.
- **Secret:** `CLINE_AUTH_JSON` = the raw contents of `providers.json` (paste as-is). On
  write jbot keeps only each provider's `auth` token (strips `model`/`reasoning`), so the
  review uses cline's default model for the mode, not the operator's local prefs.
  The **billing mode** is the jbot provider (`cline` pay-as-you-go / `cline-pass`
  subscription) — both read this same secret and differ only by `--provider`.
- **Seed once:** `gh secret set CLINE_AUTH_JSON < ~/.cline/data/settings/providers.json`.
- **Re-seed:** only when a run errors auth/`Unauthorized` (token expired/revoked). For
  OAuth providers Cline refreshes the access token transparently from the stored
  refresh token; jbot contains no OAuth logic.

The value flows through the existing generic key path: `selectReviewBackends` routes it
to a new `clineAuth` field; the runner hands it to `writeClineAuth`.

### 2. `src/shared/cline.ts`

Mirrors `codex.ts` (per-process `HOME` isolation, fail-open parsing), diverging only
where cline's behavior forces it (argv prompt, NDJSON response, guideline cap):

- `CLINE_PROVIDER_ID = 'cline'`, `CLINE_PASS_PROVIDER_ID = 'cline-pass'`; `isClineProvider`
  matches both (one backend, two billing modes).
- `clineProvidersPath(home)` → `<home>/.cline/data/settings/providers.json`.
- `writeClineAuth(auth, clineHome)` — strip `model`/`reasoning` (`stripClineModelReasoning`,
  token-only), mkdir the nested settings dir `0700`, write `providers.json` `0600`. Throw
  on empty/invalid input.
- `buildClineCliArgs({ model })` → `['--json', '--plan', '--auto-approve', 'false',
'--provider', providerID]`, plus `--model` when not `default`. `--provider` is the billing
  mode = the model's provider prefix (`cline` / `cline-pass`); cline's `-P` defaults to
  `cline` and ignores lastUsedProvider, so jbot sets it explicitly. cline requires
  `--model` as `modelType/model`: cline-pass models are namespaced under the mode
  (`cline-pass/glm-5.2`) so jbot prepends the provider; pay-as-you-go `cline` models already
  carry their type (`deepseek/deepseek-v4-flash`). Hence the GitHub-setting refs:
  `cline/<type>/<model>` and `cline-pass/<model>`. Bypass flags never emitted; the prompt
  is the final positional arg in `runClinePrompt`; cwd is the spawn `cwd`.
- `clineEnvForHome(clineHome)` — `{ ...process.env, HOME: clineHome }` with every
  supported-provider api-key env (`CLINE_STRIPPED_ENV_KEYS`) deleted so the carried
  `providers.json` wins deterministically and an ambient key can't silently switch
  provider/billing. Cline is multi-provider, so the set is broader than codex's.
- `runClinePrompt(...)` — per-process `mkdtemp` home, `copyFileSync` `providers.json`
  into it (concurrent sessions must not race on the file Cline rewrites when it
  refreshes the token), spawn `cline` with the argv prompt and
  `env = clineEnvForHome(dir)`, then `parseClineFinalMessage(stdout)`. Reuse
  `parseReview` / `parseFindingVerdicts` and the single JSON-repair retry, like the
  siblings.
- `parseClineFinalMessage(stdout)` — parse the NDJSON, return the `run_result` event's
  `.text` (the clean final message — concatenating `agent_event.event.text` would
  duplicate the stream). Empty/missing → caller throws (fail loud), like codex's
  empty-`--output-last-message` guard.
- Public entry points: `runClineReview`, `runClineAddressedPriorCommentsCheck`,
  `runClineGuidelineComplianceCheck`, `runClineFindingVerification`,
  `runClineChangesSinceLastReview` — identical signatures to the codex equivalents so
  `runner.ts` wiring is symmetric.

### 3. Prompt delivery — argv, capped budget, hard guard

Because cline is argv-only headless and Linux caps a single arg at 128KB:

- **Guideline cap.** `runClineReview` / `runClineGuidelineComplianceCheck` clamp the
  incoming `guidelines` string to `CLINE_GUIDELINE_BUDGET_BYTES = 24 * 1024` (matching
  the finder budget) before `assembleReviewPrompt` via the shared, UTF-8-safe
  `truncateUtf8WithNotice` (invariant #4 omission note). With prContext ≤ ~40KB (diff budget) + 24KB guidelines + ~10KB
  instructions, the prompt lands ~74KB — comfortably argv-safe. This trades some
  guideline context in cline's main pass; acceptable, and the routing work is already
  shrinking that corpus.
- **Hard guard.** `runClinePrompt` throws if the assembled prompt exceeds
  `CLINE_MAX_ARGV_BYTES = 120 * 1024` (defense-in-depth; should never fire after the
  cap). Aux sessions fail open (invariant #3); a main session that somehow overflows
  aborts with a clear error rather than `E2BIG` from the kernel.

Why not a `--hooks-dir` read-approval policy (write the prompt to a file, let cline
read it): it adds a novel read-only surface the other backends don't have and is the
load-bearing control if the cap is wrong — over-engineered for the win. Revisit only if
the guideline cap proves too tight.

### 4. Wiring — the six edits

1. `src/shared/backend-selection.ts`: add `CLINE_PROVIDER_ID` to `CliBackendID`, a
   branch in `cliBackendForProvider`, and a `clineAuth` field in
   `ReviewBackendSelection` routed like `codexAuth`.
2. `src/shared/config.ts`: `PROVIDERS.cline` and `PROVIDERS['cline-pass']` (defaultModel
   `<mode>/default`, both `keyEnv: 'CLINE_AUTH_JSON'`, `keyInput: 'cline-auth'`,
   `promptCache: false`); add `'cline'` and `'cline-pass'` to `modelSupportsPromptCache`.
3. `src/shared/runner.ts`: a `writeClineAuth` block beside the codex credential write
   (allocate a temp `clineHome`, add it to `cleanupCliHomes`); register `cline` in the
   `cliBackends` record and wire `createClineBackend`.
4. `action.yml`: add a `cline-auth` input and `INPUT_CLINE-AUTH: ${{ inputs.cline-auth }}`.
5. `.github/workflows/jbot-review.yml`: add `cline-auth: ${{ secrets.CLINE_AUTH_JSON }}`.
6. `Dockerfile`: append `cline@latest` to the existing `npm install -g` line.

### 5. Read-only & invariant compliance

- **Invariant #8 (read-only):** `--auto-approve false` denies every tool call in
  headless mode (POC-proven); `--plan` adds a behavioral layer. No bypass flags. Cline
  cannot edit the workspace.
- **No-tools directive (prompt-bound review):** because `--auto-approve false` denies
  *reads* too, cline stalls (emits prose, not JSON) when the base prompt tells it to run
  the git diff / grep steps. `NO_TOOLS_REVIEW_DIRECTIVE` (prepended in `buildClinePromptArg`)
  overrides those steps so cline reviews only the embedded diff/context. Tradeoff: cline is
  prompt-bound — no exploration of omitted files or caller cross-referencing the exploring
  backends do — bought for zero read/write/exec on untrusted PR code. The diff budget +
  sharding cover typical PRs. Verified e2e: glm-5.2 and deepseek-v4-flash both return valid
  findings against an embedded diff with an empty workspace.
- **Invariant #3 (aux sessions fail open):** unchanged; a cline lens/guideline/verify
  failure (incl. an over-budget guard throw) degrades only that session.
- **Invariants #1/#2/#10:** unaffected — cline is just another session driver; decision
  logic stays in the pure modules; the diff stays full-scope (the cap touches
  guidelines, never the diff).

## Operational runbook

- **Seed:** `gh secret set CLINE_AUTH_JSON < ~/.cline/data/settings/providers.json`.
- **Select:** repo var `JBOT_REVIEW_PROVIDER=cline` (and/or `JBOT_AUX_PROVIDER=cline`),
  optionally `JBOT_REVIEW_MODEL=cline/<model>`.
- **Re-seed trigger:** a run logs a Cline auth failure (`Unauthorized`/login required).
  Re-run `cline auth` locally, then re-run the seed command.

## Risks & mitigations

| Risk                                                      | Mitigation                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Prompt exceeds the argv limit on a large PR               | Guideline cap keeps prompts ~74KB; `CLINE_MAX_ARGV_BYTES` guard fails clean (fail-open for aux).         |
| Capped guidelines reduce cline's main-review recall       | Accepted; finder-equivalent budget, and the guideline corpus is being reduced anyway. Overridable later. |
| Ambient provider key switches Cline's provider/billing    | `clineEnvForHome` strips the common api-key envs; the carried `providers.json` wins. Unit-tested.        |
| Refresh token eventually expires/revoked                  | Run fails clean with an auth error; re-seed (documented runbook).                                        |
| **ToS** — personal subscription powering an automated bot | Accepted by the operator; documented. Same posture as the codex backend.                                 |

## Testing (invariant #10)

Pure-unit, no network:

- `buildClineCliArgs` — read-only flags present, `--provider` = the model's mode prefix,
  `--model` omitted on `default`, bypass flags never present.
- `isClineProvider` — matches both `cline` and `cline-pass`.
- `stripClineModelReasoning` — drops `model`/`reasoning`, keeps the `auth` token.
- `writeClineAuth` — writes `<home>/.cline/data/settings/providers.json`, mode `0600`,
  token-only (model/reasoning stripped); errors on empty/invalid input.
- `selectReviewBackends` — `provider=cline-pass` routes through the shared cline backend.
- `clineEnvForHome` — sets `HOME`, strips the ambient api-key envs, leaves
  `process.env` untouched.
- `parseClineFinalMessage` — returns `run_result.text`; empty on missing/garbage.
- `selectReviewBackends` — `provider=cline` (and aux=cline) routes `clineAuth` and sets
  `needsOpencode` correctly.

## Acceptance criteria

- `provider: cline` runs a full review via `cline --json`, posts findings through the
  normal pipeline, and never writes to the workspace.
- With no `CLINE_AUTH_JSON`, selecting cline fails with a clear, actionable error.
- An ambient `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the job env does not change Cline's
  provider/billing path.
- `npm run typecheck` / `lint` / `test` / `build` green; new unit tests pass.

## Open questions / future

- If the guideline cap proves too tight for recall, revisit the `--hooks-dir`
  file-prompt path or push upstream for headless stdin support.
- Cline reports per-run token usage in `run_result.usage`; wiring `onTokenUsage` is a
  cheap future enhancement (skipped now to match the other CLI backends).
