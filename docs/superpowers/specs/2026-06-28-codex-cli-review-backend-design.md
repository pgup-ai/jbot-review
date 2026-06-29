# Codex CLI review backend (ChatGPT-subscription auth) — design

- **Status:** approved (design), pending implementation plan
- **Date:** 2026-06-28
- **Scope:** add OpenAI Codex CLI as a third pluggable CLI review backend, authenticated
  by a ChatGPT Plus/Pro subscription (OAuth), carried into CI via a GitHub secret.

## Goal

Let jbot-review drive review sessions through the `codex` CLI (like it already does
for `devin` and `command-code`), billed against a ChatGPT subscription instead of
per-token OpenAI API usage. The subscription credential is extracted once from a
local `codex login`, stored as a GitHub secret, and written into the runner at
runtime so `codex exec` runs read-only review prompts.

### Non-goals

- No change to the review pipeline, prompts, finding contracts, or markers.
- No dynamic Codex model listing (use the configured/default model directly).
- No automated GitHub-secret rotation (not needed — see Background).
- The API-key auth mode for Codex is intentionally out of scope; we use subscription
  (OAuth) auth. (Codex still supports API keys; we just don't wire that path.)

## Background — why subscription auth is viable in ephemeral CI

The concern with subscription (OAuth) auth in a GitHub Actions runner is that the
runner filesystem is destroyed each job, so any token Codex refreshes mid-run is
discarded. If OpenAI rotated refresh tokens as strictly single-use, the stored
secret would die after the first refresh and every later run would fail
`invalid_grant`.

We measured this directly against `https://auth.openai.com/oauth/token`
(client_id `app_EMoamEEZ73f0CkXaXp7hrann`, the constant baked into the `codex`
binary) using the live local refresh token:

| Probe step                        | Result                                                  | Meaning                                      |
| --------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| Refresh #1 with `R0`              | `200`, new access token, **new refresh token returned** | server rotates _issuance_                    |
| Refresh #2 with the **same `R0`** | `200`, new access token                                 | **the original token stays valid after use** |
| access-token `expires_in`         | `864000` (10 days)                                      | long-lived access token                      |

Conclusion: **the stored refresh token is reusable.** OpenAI issues a new refresh
token on each call but does not invalidate the prior one, so an ephemeral runner can
refresh from the same stored token across runs until that token eventually expires or
is revoked (logout / password change) — on the order of weeks, not per-run. Local and
CI use do not collide, because old tokens remain valid alongside new ones.

This removes the only structural objection to Approach B. The refresh itself happens
_inside_ the `codex` CLI; jbot writes `auth.json` and runs `codex exec`, and Codex
transparently refreshes the 10-day access token from the stored refresh token when
needed. jbot contains no OAuth logic.

## Architecture — slots into the existing CLI-backend pattern

CLI backends are already pluggable; Codex is the third tenant of a pattern built for
exactly this. Each backend is one module plus six mechanical wiring points:

| Layer                      | Devin                         | CommandCode                 | Codex (new)              |
| -------------------------- | ----------------------------- | --------------------------- | ------------------------ |
| Backend module             | `src/shared/devin.ts`         | `src/shared/commandcode.ts` | `src/shared/codex.ts`    |
| Dispatch                   | `isDevinProvider`             | `isCommandCodeProvider`     | `isCodexProvider`        |
| Credential write (runtime) | `writeDevinCredentials`       | `writeCommandCodeAuth`      | `writeCodexAuth`         |
| Provider entry             | `config.ts` `PROVIDERS.devin` | `PROVIDERS.commandcode`     | `PROVIDERS.codex`        |
| Action input               | `devin-windsurf-api-key`      | `commandcode-access-key`    | `codex-auth`             |
| Workflow secret            | `DEVIN_WINDSURF_API_KEY`      | `COMMANDCODE_ACCESS_KEY`    | `CODEX_AUTH_JSON`        |
| CLI binary                 | curl install script           | `npm i -g command-code`     | `npm i -g @openai/codex` |

## Detailed design

### 1. Credential flow: local → secret → runner → CLI

- **Source:** `~/.codex/auth.json` after a local `codex login` (the `tokens` block plus
  `account_id` / `auth_mode: "chatgpt"`).
- **Secret:** `CODEX_AUTH_JSON` = base64 of the whole `auth.json`. Base64 avoids
  multiline/JSON-escaping issues in GitHub secrets, and carrying the full file
  preserves `account_id` + `auth_mode` so Codex selects subscription mode.
- **Seed once:** `base64 -i ~/.codex/auth.json | gh secret set CODEX_AUTH_JSON`.
- **Re-seed:** only when a run errors `invalid_grant` (token finally expired/revoked).
  Expected cadence: weeks. Not per-run, not per-10-days.

The value flows through the existing generic key path: `workflow/index.ts` reads
`getInputOrEnv(cfg.keyInput, cfg.keyEnv)` into `apiKey`; `selectReviewBackends` routes
it to a new `codexAuth` field; the runner hands it to `writeCodexAuth`. No
codex-specific change in `workflow/index.ts`.

### 2. `src/shared/codex.ts`

Mirror `commandcode.ts` structure (stdin prompt, `home` isolation, fail-open parsing):

- `export const CODEX_PROVIDER_ID = 'codex'`; `isCodexProvider(id)`.
- `writeCodexAuth(authB64, codexHome)` — decode base64, write `${codexHome}/auth.json`
  with mode `0600` (mkdir the temp `codexHome` `0700`). Throw a clear error if the
  secret is empty or not valid base64/JSON. `codexHome` is the temp dir passed as
  `CODEX_HOME` (it replaces `~/.codex`), so `auth.json` lives at its root.
- `buildCodexCliArgs({ model, lastMessageFile, workspace })` →
  `['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
'--ignore-user-config', '-C', workspace, '-o', lastMessageFile, '-m', modelID, '-']`
  (omit `-m` when `modelID === 'default'`). Prompt is fed on **stdin** (`-`).
- `runCodexPrompt(...)` — `mkdtemp`, spawn `codex` with those args and
  `env = codexEnvForHome(home)`, write the prompt to stdin, wait, then read the
  `-o` last-message file as the model response. Reuse `parseReview` /
  `parseFindingVerdicts` and the single JSON-repair retry, exactly like the siblings.
- Public entry points: `runCodexReview`, `runCodexAddressedPriorCommentsCheck`,
  `runCodexGuidelineComplianceCheck`, `runCodexFindingVerification` — identical
  signatures to the Devin/CommandCode equivalents so `runner.ts` wiring is symmetric.
- `classifyCodexPromptFailure(output)` — detect plan rate-limit / weekly-cap /
  usage-exceeded for clean degradation (mirror `classifyCommandCodePromptFailure`).
- `codexEnvForHome(codexHome)` — **critical correctness point.** Returns
  `{ ...process.env, CODEX_HOME: codexHome }` **with `OPENAI_API_KEY`,
  `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` deleted.** Codex's auth precedence puts
  those env vars _above_ `auth.json`; if an ambient `OPENAI_API_KEY` (e.g. because the
  `openai` provider is also configured) leaked into the child, Codex would silently
  switch to per-token API billing and defeat the entire feature. Stripping them forces
  the subscription `auth.json` to win deterministically. (Analogous to commandcode
  deleting `COMMAND_CODE_API_KEY`.)

Output handling note: `codex exec` streams progress to stdout/stderr; the final
assistant message is written to the `-o` file. We read the file, not stdout — cleaner
than commandcode's stdout capture.

### 3. Wiring — the six edits

1. `src/shared/backend-selection.ts`: add `CODEX_PROVIDER_ID` to `CliBackendID`, a
   branch in `cliBackendForProvider`, and a `codexAuth` field in
   `ReviewBackendSelection` routed like `devinApiKey` / `commandCodeAccessKey`.
2. `src/shared/config.ts`: `PROVIDERS.codex = { defaultModel: 'codex/gpt-5.1-codex',
keyEnv: 'CODEX_AUTH_JSON', keyInput: 'codex-auth', models: { default: { promptCache:
false } } }`; add `'codex'` to the early-return in `modelSupportsPromptCache`.
3. `src/shared/runner.ts`: a `writeCodexAuth(backendSelection.codexAuth, codexHome)`
   block beside the Devin/CommandCode credential writes (allocate a temp home, mirror
   commandcode's `home` threading); register `codex` in the `cliBackends` record and
   wire its four methods.
4. `action.yml`: add a `codex-auth` input and `INPUT_CODEX-AUTH: ${{ inputs.codex-auth }}`.
5. `.github/workflows/jbot-review.yml`: add `codex-auth: ${{ secrets.CODEX_AUTH_JSON }}`.
6. `Dockerfile`: append `@openai/codex@latest` to the existing `npm install -g` line.

### 4. Read-only & invariant compliance

- **Invariant #8 (read-only, three layers):** `--sandbox read-only` is a kernel-enforced
  sandbox mode — stronger than Devin's allow/deny config or CommandCode's
  `--permission-mode plan`. `--ignore-user-config` prevents a workspace `config.toml`
  from loosening it. `git` reads still work.
- **Invariant #3 (aux sessions fail open):** unchanged — the runner already wraps
  lens/guideline/addressed/verification sessions so a backend failure degrades only
  that session. Codex weekly-cap exhaustion in an aux session must not fail the run or
  drop findings.
- **Invariant #1 (full-diff scope), #2 (trust-boundary in code), #10 (pure logic
  tested):** unaffected; Codex is just another session driver.

## Operational runbook

- **Seed:** `base64 -i ~/.codex/auth.json | gh secret set CODEX_AUTH_JSON` (repo or org).
- **Select:** set repo var `JBOT_REVIEW_PROVIDER=codex` (and/or `JBOT_AUX_PROVIDER=codex`),
  optionally `JBOT_REVIEW_MODEL=codex/<model>`.
- **Re-seed trigger:** a run logs a Codex auth failure (`invalid_grant`/login required).
  Re-run `codex login` locally, then re-run the seed command.

## Risks & mitigations

| Risk                                                            | Mitigation                                                                                                                                                            |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ToS** — personal ChatGPT plan powering an automated bot       | Accepted by the operator; documented. Subscription/enterprise plans are the lower-risk fit.                                                                           |
| Refresh token eventually expires/revoked                        | Run fails clean with an auth error; re-seed (weeks cadence). Documented runbook.                                                                                      |
| Ambient `OPENAI_API_KEY` silently switches Codex to API billing | `codexEnvForHome` strips `OPENAI_API_KEY`/`CODEX_API_KEY`/`CODEX_ACCESS_TOKEN`; unit-tested.                                                                          |
| Subscription weekly rate caps                                   | `classifyCodexPromptFailure` + fail-open aux sessions; a main shard that exhausts the cap aborts rather than posting partial coverage (matches time-budget behavior). |
| `defaultModel` guess (`gpt-5.1-codex`) may be wrong/renamed     | Overridable via the `model` input / `JBOT_REVIEW_MODEL`; verify during implementation.                                                                                |

## Testing (invariant #10)

Pure-unit, no network:

- `buildCodexCliArgs` — flags present, `-m` omitted on `default`, stdin marker `-`.
- `writeCodexAuth` — writes `${home}/.codex/auth.json`, mode `0600`, base64 decoded;
  errors on empty/invalid input.
- `codexEnvForHome` — sets `CODEX_HOME`, strips the three ambient auth env vars.
- `classifyCodexPromptFailure` — rate-limit / usage-exceeded classification.
- `selectReviewBackends` — `provider=codex` (and aux=codex) routes `codexAuth` and sets
  `needsOpencode` correctly.

## Acceptance criteria

- `provider: codex` runs a full review via `codex exec` against the subscription, posts
  findings through the normal pipeline, and never writes to the workspace.
- With no `CODEX_AUTH_JSON`, selecting codex fails with a clear, actionable error.
- An ambient `OPENAI_API_KEY` in the job env does not change Codex's billing path.
- `npm run typecheck` / `lint` / `test` / `build` green; new unit tests pass.

## Open questions / future

- Confirm the current best default Codex model id during implementation.
- Optional later: a scheduled "token health" check that warns before `invalid_grant`.
- The hosted-app path (persistent VPS) could instead persist refreshes on disk; this
  spec targets the ephemeral GitHub Actions runner.
