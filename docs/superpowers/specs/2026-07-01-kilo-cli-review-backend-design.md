# Kilo CLI review backend (local-auth reuse, free-gateway default) — design

- **Status:** implemented (all gates green; live e2e on `kilo/kilo-auto/free` flagged the seeded div-by-zero bug, workspace untouched)
- **Date:** 2026-07-01
- **Scope:** add the Kilo CLI (`@kilocode/cli`, binary `kilo`) as a pluggable CLI
  review backend, authenticated by a local `kilo auth login` credential carried into
  CI via a GitHub secret, defaulting to the free model gateway. Full in-repo
  integration **plus** the `jbot-review-app` `PROVIDER_CATALOG` entry.

## Goal

Let jbot-review drive review sessions through the `kilo` CLI (like `devin`,
`command-code`, `cursor`, `codex`, and `cline`), billed against whatever the operator
signed into locally — including Kilo's **free model gateway** (`kilo/kilo-auto/free`).
The credential is captured once from a local `kilo auth login`, stored as a GitHub
secret, and injected into the runner at runtime so `kilo` runs read-only review
prompts.

### Non-goals

- No change to the review pipeline, prompts, finding contracts, or markers.
- No `--variant` reasoning-effort wiring (Kilo exposes it; CLI backends skip
  `modelOptions` like their siblings — future enhancement).
- No use of `kilo serve` + jbot's opencode SDK client (Approach B, rejected below):
  it contradicts the CLI-backend pattern and couples us to Kilo's server API + in-server
  gateway auth.
- No token-usage wiring (`kilo stats` exists; skipped to match the other CLI backends).

Kilo is modeled as **one jbot provider** — `kilo` — with the secret **required**
(anonymous free-gateway access exists but 404s the auto-router and is rate-limited
200 req/hr/IP, unusable on a shared runner IP; see POC). The operator selects it via
`JBOT_REVIEW_PROVIDER=kilo`.

## Background — Kilo is an opencode fork, and POC findings that shape the design

`@kilocode/cli` (v7.3.54) is a fork of `sst/opencode` — the exact engine jbot already
runs (`src/shared/opencode.ts`). Its `run`/`models`/`serve` commands, `auth.json`
shape, and agent modes inherit opencode semantics. A live credentialed POC against the
installed `kilo` (v7.3.54), using the operator's local login and the free model,
settled everything below:

1. **Prompt delivery is stdin — no argv cap.** `kilo run` accepted a prompt piped on
   stdin (it created a session and only failed at the model step, never the Cline error
   "requires a prompt argument"). So Kilo is a clean stdin backend like `cursor`/`codex`;
   the Cline capped-argv path (24KB guideline truncation) is **not** needed. Prompts
   routinely exceed Linux's 128KB single-argv limit, so stdin is the required path
   anyway.

2. **Machine-readable output is `--format json` → NDJSON events.** `kilo run --format
   json` (choices: `default` | `json`) streams one JSON object per line:
   `{"type":..., "timestamp":..., "sessionID":..., ...}`. The final assistant text is
   carried in events of `type:"text"`; failures surface as `type:"error"` with
   `error.data.message`. POC: the assistant text lives at **`event.part.text`** (not a
   top-level `.text`), and text events are **cumulative snapshots** (a 5-line reply came
   as one event with the full text). Robust parse = read lines, `JSON.parse` each (skip
   non-JSON log lines), keep the **last** `type:"text"` event's `part.text` (never
   concat); empty ⇒ fail loud.

3. **Read-only agent + the bypass flags to avoid.** `--agent plan` is a valid agent
   (accepted headless, no error) and is the same read-only layer jbot's opencode
   integration already uses (invariant #8). The **bypass** flags confirmed present and
   never to be emitted: `--auto` (auto-approve all) and `--dangerously-skip-permissions`.

4. **Per-process `HOME`/`XDG_DATA_HOME` isolation is mandatory.** Every `kilo`
   invocation opens and migrates `~/.local/share/kilo/kilo.db` (+ WAL) and reads auth
   from `~/.local/share/kilo/auth.json`. Setting `HOME` + `XDG_DATA_HOME` to a temp dir
   relocated the whole data dir (POC-confirmed), so concurrent sessions must each get an
   isolated dir or they race on the SQLite DB (not just auth).

5. **Free-gateway model id is `kilo/kilo-auto/free` — gateway-prefixed (gotcha).**
   `kilo models --refresh` (works anonymously; pulls models.dev) lists 251 models, all
   `kilo/<vendor>/<model>`, including the free ones: `kilo/kilo-auto/free` (smart-router)
   and siblings `kilo/kilo-auto/{small,efficient,balanced,frontier}`, plus `:free`
   models (`kilo/stepfun/step-3.7-flash:free`, `kilo/openrouter/free`,
   `kilo/nvidia/nemotron-3-*:free`, `kilo/cohere/north-mini-code:free`,
   `kilo/poolside/laguna-*:free`). **A run with the bare `--model kilo-auto/free`
   returned "Model not found"** — the leading `kilo/` gateway prefix is load-bearing.
   Because jbot's provider id (`kilo`) coincides with Kilo's gateway provider id
   (`kilo`), `parseModelName` strips it; `buildKiloCliArgs` must re-add it (the
   `cline-pass/<model>` pattern).

6. **Credentialed run + read-only + large-stdin all confirmed.** Env-injected
   `KILO_AUTH_CONTENT` (738-char auth.json) ran `kilo/kilo-auto/free` successfully
   (EXIT 0, `part.text` returned). A **150KB** stdin prompt was ingested fine (no
   argv/stdin cap — Kilo's edge over Cline). `--agent plan` without `--auto`
   **auto-denies** a write tool (file never created) and does **not** hang — but a
   denied tool yields near-empty text, so `NO_TOOLS_REVIEW_DIRECTIVE` is **required**
   (not merely precautionary) to keep the review prompt-bound and JSON-emitting.

## Approaches considered

- **A — CLI-spawn backend (chosen).** New `src/shared/kilo.ts` modeled on
  `cursor.ts`/`codex.ts`: spawn `kilo run --format json` with the prompt on stdin.
  Follows the mandated CLI pattern; treats Kilo as one more CLI.
- **B — reuse jbot's opencode server via `kilo serve` (rejected).** Since Kilo *is*
  opencode, point jbot's `opencode.ts` client at a `kilo serve` process. Rejected:
  contradicts the "follow the CLI pattern" instruction, couples to Kilo's server API +
  in-server gateway auth, and carries version-drift risk.

## Architecture — slots into the existing CLI-backend pattern

Kilo is the sixth CLI tenant. One module plus the mechanical wiring points:

| Layer                      | Cursor / Codex reference        | Kilo (new)                                       |
| -------------------------- | ------------------------------- | ------------------------------------------------ |
| Backend module             | `src/shared/{cursor,codex}.ts`  | `src/shared/kilo.ts`                             |
| Dispatch predicate         | `isCursorProvider`              | `isKiloProvider`                                |
| Credential (runtime)       | `cursorEnvForKey` (env, no file)| `kiloEnvForAuth` (**env `KILO_AUTH_CONTENT`**, no file) + isolated HOME/XDG |
| Provider entry             | `PROVIDERS.cursor`              | `PROVIDERS.kilo`                                |
| Action input               | `cursor-api-key`                | `kilo-auth`                                      |
| Workflow secret            | `CURSOR_API_KEY`                | `KILO_AUTH_CONTENT`                             |
| CLI binary                 | `curl cursor.com/install`       | `npm i -g @kilocode/cli`                         |
| Prompt delivery            | stdin                           | **stdin** (POC-confirmed)                        |
| Read-only                  | `--mode plan`                   | `--agent plan` + no-tools directive              |
| Model response             | stdout text                     | **`type:"text"` events** from `--format json`    |
| Model listing              | `listCursorModels`              | `listKiloModels` (`kilo models`)                 |
| Model default              | CLI default                     | **`kilo/kilo-auto/free`** (deterministic)        |

## Detailed design

### 1. Credential flow: local → secret → runner → CLI

- **Source:** `~/.local/share/kilo/auth.json` after a local `kilo auth login`. It's a
  map `provider → {type:"oauth", refresh, access, expires, ...} | {type:"api", key} |
  {type:"wellknown", key, token}`. It natively carries either an OAuth subscription
  (with a **refresh token that survives CI**) or a plain API key — satisfying "reuse the
  local oauth (json or api key)".
- **Secret:** `KILO_AUTH_CONTENT` = the raw contents of `auth.json` (paste as-is), the
  same paste-whole-file UX as Codex/Cline.
- **Injection:** the CLI reads `KILO_AUTH_CONTENT` from the env directly — no file
  written. `kiloEnvForAuth` also sets an isolated `HOME` + `XDG_DATA_HOME` (temp dir)
  so any token-refresh write-back and the per-run SQLite DB are contained and
  non-racing.
- **Seed once:** `gh secret set KILO_AUTH_CONTENT < ~/.local/share/kilo/auth.json`.
- **Re-seed:** only on an auth error (token revoked); for OAuth, Kilo refreshes the
  access token transparently from the stored refresh token; jbot contains no OAuth logic.

The value flows through the existing generic key path: `selectReviewBackends` routes it
to a new `kiloAuth` field; the runner hands it to the Kilo startup block.

### 2. `src/shared/kilo.ts`

Mirrors `cursor.ts` (env-carried credential, stdin prompt, fail-open parsing),
diverging where Kilo's behavior requires it (isolated HOME for the DB, NDJSON parse,
gateway-prefixed model, no-tools directive):

- `KILO_PROVIDER_ID = 'kilo'`, `KILO_CLI_BIN = 'kilo'`, `KILO_GATEWAY_MODEL =
  'kilo-auto/free'`; `isKiloProvider(id)` exact-matches `kilo`.
- `buildKiloCliArgs({ model })` → `['run', '--format', 'json', '--agent', 'plan',
  '--model', <kiloModel>]`, where `<kiloModel>` re-adds the gateway prefix stripped by
  `parseModelName`: `kilo/${modelID}`, with `modelID === 'default'` mapped to
  `kilo/kilo-auto/free`. Bypass flags (`--auto`, `--dangerously-skip-permissions`)
  never emitted. **[learning-mode contribution: the model-mapping + read-only args.]**
- `buildKiloPromptInput(prompt)` → prepend `NO_TOOLS_REVIEW_DIRECTIVE` (as `cline` does)
  so a read-only agent reviews the embedded context instead of stalling on a denied
  git/grep step. (Kept even though stdin is used; the directive is about tool use, not
  delivery.)
- `kiloEnvForAuth(auth, home)` — validate `auth` is non-empty JSON (fail fast, like
  codex), return `{ ...process.env, KILO_AUTH_CONTENT: auth, HOME: home, XDG_DATA_HOME:
  join(home, '.local/share') }` with ambient provider keys stripped
  (`KILO_STRIPPED_ENV_KEYS`: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `KILO_API_KEY`,
  `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, …) so the carried auth wins.
- `parseKiloFinalMessage(stdout)` — split lines, `JSON.parse` each (skip non-JSON log
  lines), return the **last** `type:"text"` event's **`part.text`** (POC: text lives at
  `part.text`; events are cumulative ⇒ take-last, never concat); if a `type:"error"`
  event is the terminal state, surface `error.data.message`; empty ⇒ caller throws
  (fail loud). **[learning-mode contribution: the event-selection logic.]**
- `listKiloModels(home)` / `parseKiloModelList(output)` — run `kilo models` for the
  startup observability log (mirrors `listCursorModels`); pure parser splits
  `provider/model-id` lines. Best-effort: runner logs and continues on failure.
- `runKiloPrompt(...)` — `mkdtemp` per-process home, spawn `kilo` with `input = prompt`
  (stdin) and `env = kiloEnvForAuth(auth, dir)`, `parseKiloFinalMessage(stdout)`, one
  JSON-repair retry, `rm -rf` the temp home in `finally`.
- Public entry points identical in shape to the codex/cursor equivalents:
  `runKiloReview`, `runKiloAddressedPriorCommentsCheck`,
  `runKiloGuidelineComplianceCheck`, `runKiloFindingVerification`,
  `runKiloChangesSinceLastReview`.

### 3. Prompt delivery — stdin (no cap)

Prompt on stdin via `spawnWithTimeout({ input: prompt })`, exactly like `cursor.ts`.
No guideline cap, no argv guard — POC-confirmed Kilo reads stdin. `--format json` on
stdout is parsed; stray INFO log lines (Kilo emits some to stdout on init) are skipped
by the non-JSON-tolerant parser.

### 4. Read-only & invariant compliance (invariant #8)

- **Layer 1 — agent:** `--agent plan` (config-level deny of edit/write/terminal).
- **Layer 2 — no bypass:** `--auto` / `--dangerously-skip-permissions` never emitted, so
  a denied tool stays denied headless.
- **Layer 3 — no-tools directive:** `NO_TOOLS_REVIEW_DIRECTIVE` prepended so the review
  is prompt-bound (reviews the embedded diff/context; no exploration), avoiding a
  read-only stall. Tradeoff identical to Cline's: no file exploration/caller
  cross-ref, bought for zero read/write/exec on untrusted PR code; diff budget +
  sharding cover typical PRs. **POC-confirmed required**: `--agent plan` auto-denies
  tools without hanging, but a denied tool yields near-empty output, so the directive
  keeps the review prompt-bound and JSON-emitting.
- **Invariant #3 (aux fail-open):** a Kilo lens/guideline/verify failure degrades only
  that session.
- **Invariants #1/#2/#10:** unaffected — Kilo is another session driver; decision logic
  stays in the pure modules; the diff stays full-scope.

### 5. Model default (free gateway) & listing

- `config.ts` `PROVIDERS.kilo.defaultModel = 'kilo/kilo-auto/free'` so CI defaults to
  the free smart-router without a local `kilo.jsonc`. `buildKiloCliArgs` maps the jbot
  `default` sentinel to the same, and preserves the `kilo/` gateway prefix on any
  explicit model (POC gotcha #5).
- `listKiloModels` runs `kilo models` at startup (like `listCursorModels`) so the run
  log shows the available catalog incl. free models — answering "print all available
  models via the CLI" in the operational surface.

### 6. Wiring — the in-repo edits

1. `src/shared/backend-selection.ts`: add `KILO_PROVIDER_ID` to `CliBackendID`, a branch
   in `cliBackendForProvider`, and a `kiloAuth` field in `ReviewBackendSelection` routed
   like `codexAuth`.
2. `src/shared/config.ts`: `PROVIDERS.kilo` (`defaultModel: 'kilo/kilo-auto/free'`,
   `keyEnv: 'KILO_AUTH_CONTENT'`, `keyInput: 'kilo-auth'`, `models.default.promptCache:
   false`); add `'kilo'` to `modelSupportsPromptCache`'s early-return set.
3. `src/shared/runner.ts`: import Kilo fns; add `createKiloBackend`; a startup block
   (allocate temp `kiloHome`, `cleanupKiloHome`, add to `cleanupCliHomes`) that reads
   `backendSelection.kiloAuth` (throw if missing), builds the backend; register `kilo`
   in the `cliBackends` record; log `listKiloModels` best-effort.
4. `action.yml`: `kilo-auth` input + `INPUT_KILO-AUTH: ${{ inputs.kilo-auth }}`.
5. `.github/workflows/jbot-review.yml`: `kilo-auth: ${{ secrets.KILO_AUTH_CONTENT }}`.
6. `Dockerfile`: append `@kilocode/cli@latest` to the `npm install -g` line + a
   `kilo --version` check.
7. `README.md`: credential-table row (`kilo auth login` → paste `~/.local/share/kilo/
   auth.json`), provider-table row (`kilo` / `kilo/kilo-auto/free` / `kilo-auth` /
   `KILO_AUTH_CONTENT`), env-var list, and the "how auth is materialized" paragraph
   (env-injected, isolated HOME/XDG, removed after run).

### 7. App catalog — `jbot-review-app`

`packages/shared/src/index.ts`: add `'kilo'` to the `Provider` union and model list, and
a `PROVIDER_CATALOG.kilo` entry — `keysUrl` (Kilo console/dashboard, verified from the
site at implementation time, not guessed), `credentialFormat: 'json'`,
`credentialFile.extract` (whole-file, like codex, with a JSON-parse sanity check),
`keyPattern`/`keyPlaceholder`, and `credentialHelp` ("run `kilo auth login`, paste
`~/.local/share/kilo/auth.json`"). Cross-referenced against jbot-review so the
`keyEnv`/`keyInput` names match exactly.

## Operational runbook

- **Seed:** `gh secret set KILO_AUTH_CONTENT < ~/.local/share/kilo/auth.json`.
- **Select:** repo var `JBOT_REVIEW_PROVIDER=kilo` (and/or `JBOT_AUX_PROVIDER=kilo`);
  defaults to `kilo/kilo-auto/free`. Override with `JBOT_REVIEW_MODEL=kilo/<vendor>/<model>`
  (keep the `kilo/` prefix).
- **Re-seed trigger:** a run logs a Kilo auth failure. Re-run `kilo auth login` locally,
  then re-run the seed command.

## Risks & mitigations

| Risk                                                      | Mitigation                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Denied tool under `--agent plan` yields empty output      | POC: does not hang, auto-denies; `NO_TOOLS_REVIEW_DIRECTIVE` keeps output JSON-shaped; never emit `--auto`. |
| Bare model id 404s (`kilo-auto/free` vs `kilo/kilo-auto/free`) | `buildKiloCliArgs` preserves the `kilo/` gateway prefix; unit-tested; POC-observed.            |
| Free auto-router unavailable without a Kilo account       | Secret required; docs say run needs a valid `KILO_AUTH_CONTENT`; clear error when missing.          |
| Concurrent sessions race on `kilo.db`/auth               | Per-process temp `HOME`+`XDG_DATA_HOME`; POC-confirmed the data dir relocates.                       |
| Ambient provider key overrides carried auth               | `kiloEnvForAuth` strips the common api-key envs; carried `KILO_AUTH_CONTENT` wins. Unit-tested.      |
| Stray INFO log lines on stdout corrupt JSON parse         | Line-by-line `JSON.parse` skips non-JSON, like `parseClineFinalMessage`.                             |
| **ToS** — personal subscription powering an automated bot | Accepted/documented by the operator; same posture as codex/cline.                                   |

## Testing (invariant #10) — pure-unit, no network

- `buildKiloCliArgs` — `run --format json --agent plan` present; `--model` preserves the
  `kilo/` prefix; `default` → `kilo/kilo-auto/free`; bypass flags never present.
- `isKiloProvider` — matches `kilo`, rejects casing/whitespace variants.
- `kiloEnvForAuth` — sets `KILO_AUTH_CONTENT`, `HOME`, `XDG_DATA_HOME`; strips ambient
  api-key envs; leaves `process.env` untouched; throws on empty/invalid JSON.
- `parseKiloFinalMessage` — returns the last `type:"text"` text; surfaces
  `type:"error"` message; empty on missing/garbage.
- `parseKiloModelList` — extracts `provider/model-id` lines; skips headers/blank/log
  lines.
- `selectReviewBackends` — `provider=kilo` (and aux=kilo) routes `kiloAuth` and sets
  `needsOpencode` correctly.

## Acceptance criteria

- `provider: kilo` runs a full review via `kilo run --format json`, defaults to
  `kilo/kilo-auto/free`, posts findings through the normal pipeline, and never writes to
  the workspace.
- With no `KILO_AUTH_CONTENT`, selecting `kilo` fails with a clear, actionable error.
- An ambient `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in the job env does not change Kilo's
  auth/billing path.
- `npm run typecheck` / `lint` / `test` / `build` green; new unit tests pass.
- App: the Keys page shows a Kilo entry that accepts the pasted `auth.json`.

## Open questions / future

- Wire `--variant` to `modelOptions.reasoningEffort` if paid tiers want effort control.
- Wire `onTokenUsage` from `kilo stats` / the `--format json` usage events (skipped now
  to match the other CLI backends).
- If `--agent plan` proves too permissive/strict headless, evaluate `--agent ask`.
