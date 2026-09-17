# OpenCode SDK audit: `@opencode-ai/sdk` 1.x vs the new `@opencode/*` 2.x

Question: should jbot switch from `@opencode-ai/sdk` (pinned `^1.18.27`,
`opencode-ai@1.18.27` in the Docker image) to the new `@opencode/sdk`, and
what would it gain? Sources: npm registry metadata, the published 2.0.5
tarballs, the V2 docs (`opencode.ai/v2/docs`), the upstream `dev` branch, and
an isolated end-to-end probe of `opencode serve` 2.0.5 driven by
`@opencode/client` on Node 24. Observational; nothing changed.

## Decision

Overridden the same day: the maintainer chose to migrate to V2 anyway, as a
hard cutover targeting `@opencode/client` + `@opencode/cli`, to get the
stronger harness. The risks below became plan items; the design lives in
`docs/superpowers/specs/2026-09-16-opencode-v2-migration-design.md`. The
recommendation is kept as written for the record.

## Answer

**Stay on `@opencode-ai/sdk` 1.x. Do not adopt `@opencode/sdk`.** Three
reasons:

1. **`@opencode/sdk` is not the successor of what jbot uses.** It is an
   in-process host that embeds the whole server (`@opencode/server` +
   `@opencode/core` + `effect@4.0.0-rc.112`). As published (2.0.5) it does not
   load on Node at all: every relative import in its `dist/` is extensionless
   (24 of 24; `@opencode/server` 124 of 124), so Node 24 fails with
   `ERR_MODULE_NOT_FOUND` before any code runs. A default `npm install` also
   dies in node-gyp (`tree-sitter-powershell`), and with `--ignore-scripts`
   it pulls 404 packages / 419 MB. Even if it worked, in-process means no
   child-process boundary, and jbot's credential scrub relies on the child
   copying its environment at spawn.
2. **The real V2 target is a whole-stack migration, not a package swap:**
   `@opencode/client` (network client) + `@opencode/cli` (the V2 `opencode
serve` binary) + V2 config shape + a V2 plugin port + a rewrite of the
   session-driving code. The V2 docs are explicit: "Integrations that call the
   V1 server API must migrate to the V2 API" and "V1 plugin implementations do
   not run in V2".
3. **Nothing forces it yet, and V2 is days old.** 2.0.0 shipped 2026-09-12
   and reached 2.0.5 by 2026-09-16 (five patches in four days). The 1.x line
   is still released in lockstep (`@opencode-ai/sdk` 1.18.31 on 2026-09-14),
   is not deprecated on npm, and the caret pin cannot cross a major. The
   endpoints jbot would depend on most (`session.wait`, the durable session
   log, MCP add/connect) are under `/api/experimental/`.

Revisit when a trigger below fires. When it does, target `@opencode/client`,
and start from the ROADMAP note: the earlier `@opencode-ai/sdk/v2` attempt
failed on session non-termination, and the V2 prompt path has the same
ingredients (durable admission via `resume`, caller-supplied message `id`,
agent selection).

## What the packages actually are

| Package            | What it is                                                                                                                          | State on 2026-09-16                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@opencode-ai/sdk` | V1: hey-api HTTP client + `createOpencode` child-process spawner. 777 KB, one dependency.                                           | 1.18.31 (2026-09-14). Not deprecated. Upstream calls it "legacy"; the `sdk-next` README says the new host "will replace the existing generated `@opencode-ai/sdk` after its consumers migrate". |
| `@opencode/sdk`    | V2 in-process host: `OpenCode.create()` runs the server's HTTP router in memory, no listener. Also exports `/workerd` (Cloudflare). | 2.0.5. Bun-only as published (see above).                                                                                                                                                       |
| `@opencode/client` | V2 network client. Promise root export, `/effect`, `/solid`, `/service` (machine-wide shared background service discovery).         | 2.0.5. Loads on Node 24; 12 packages / 62 MB (`effect` arrives via `@opencode/schema`).                                                                                                         |
| `@opencode/cli`    | V2 server binary (`opencode serve`).                                                                                                | 2.0.5. 188 MB unpacked (darwin-arm64).                                                                                                                                                          |

Upstream layout (`anomalyco/opencode`, default branch `dev`): the 1.x SDK is
`packages/sdk/js`; the V2 host is `packages/sdk-next` (workspace name
`@opencode-ai/sdk-next`, published as `@opencode/sdk`); the V2 client is
`packages/client` (published as `@opencode/client`). Note the name-reuse plan
above: a future `@opencode-ai/sdk@2.x` may be the in-process host, so keep the
caret pin on `^1.x`.

## What jbot uses today

- `src/shared/opencode.ts`: `createOpencode({ hostname, port, timeout, config })`
  spawns `opencode serve`; config travels as `OPENCODE_CONFIG_CONTENT`; the
  spawn window sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`, an empty
  `XDG_CONFIG_HOME`, and strips credential env vars (invariant 8).
- Client surface: `session.create/promptAsync/messages/status/abort`,
  `tool.ids`, `mcp.add/connect/disconnect`; per-prompt `agent: 'plan'`,
  `model`, and `tools: { write/edit/patch: false }`. Completion is detected by
  polling status and messages; the SSE wait was abandoned (ROADMAP).
- `src/shared/opencode-hardening.ts`: a V1 plugin using the `tool.definition`
  hook to rewrite bash's wire schema for Gemini-backed proxies.
- Also touched by any migration: `test/opencode-repair.test.ts` (type import),
  `scripts/build.ts` (external), `Dockerfile` (binary pin), README notes.

## Measured on V2 2.0.5 (scratch dir, isolated `HOME`/`XDG_*`)

- `opencode serve --hostname 127.0.0.1 --port N` boots and prints
  `server listening on …` then `server password …`. There is no `--password`
  flag (flags: `--hostname`, `--port`, `--cors`, `--service`, `--stdio`); the
  password is generated per process. Auth is HTTP Basic with user `opencode`;
  unauthenticated requests get 401. jbot would parse the password from stdout
  the way it parses the URL today.
- `@opencode/client` on Node 24 drove it end to end: `server.status`,
  `agent.list` (built-ins `build`, `plan`, `general`, `explore` plus hidden
  maintenance agents), `config.get`, `provider.list`.
- `OPENCODE_CONFIG_CONTENT` is honored: the injected document shows up in
  `config.get` and is normalized to the V2 shape
  (`provider.x.options.apiKey` became `providers.x.settings.apiKey`).
  Unexplained: the injected provider did not appear in `provider.list` and a
  custom agent did not appear in `agent.list`, in both env and file form. V2
  activation semantics differ from V1; this must be understood before relying
  on env-injected provider keys.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` still works on the V2 binary: a project
  `.opencode/opencode.json` loads by default (3 config documents) and is
  dropped with the flag (1 document). `OPENCODE_PURE=1` does nothing in V2.
  `XDG_CONFIG_HOME` is honored. V2 `core` reads none of these itself; the
  compiled CLI does. Plugin auto-load from `.opencode/plugins/` was not
  exercised; the docs say it is automatic, so verify with a real plugin file
  before trusting the flag for invariant 8 layer 4.

## V1 → V2 mapping for jbot's call sites

| jbot today (V1)                                                  | V2 equivalent                                                                                                        | Note                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `createOpencode()` spawner                                       | none in the client; spawn `opencode serve` yourself and parse URL + password                                         | `Service.ensure()` manages one shared background service per machine, wrong model for per-run config |
| `OPENCODE_CONFIG_CONTENT`                                        | same env var, V1 shape auto-normalized                                                                               | provider activation open question above                                                              |
| `session.create({ body, query: { directory } })`                 | `session.create({ location: { directory }, agent, model, permissions })`                                             | agent, model and permission rules move to session level                                              |
| `session.promptAsync({ body: { agent, model, tools, parts } })`  | `session.prompt({ sessionID, text, files?, resume? })`                                                               | no per-prompt agent/model/tools; layer 3 of invariant 8 becomes a `permissions` ruleset              |
| poll `session.status` / `session.messages`                       | `session.wait` (experimental) or `session.log({ after, follow })` durable stream; `message.list` is cursor-paginated | the replayable log is the one thing V1 lacks                                                         |
| `session.abort`                                                  | `session.interrupt`                                                                                                  |                                                                                                      |
| `tool.ids`                                                       | no tool-listing endpoint in the V2 client                                                                            | used today for the readiness probe and tool telemetry                                                |
| `mcp.add/connect/disconnect`                                     | same names, `/api/experimental/mcp/...` routes                                                                       | context7 injection survives                                                                          |
| plugin `tool.definition` hook                                    | no equivalent; `session.hook("context")` can edit `event.tools`                                                      | or show V2's bash schema no longer emits `exclusiveMinimum`                                          |
| `permission: { edit: 'deny', external_directory: 'deny', bash }` | ordered `permissions: [{ action, resource, effect }]`                                                                | V1 object form is auto-normalized per the migration guide                                            |
| `plan` agent                                                     | still built in: denies edits except `~/.opencode/plan`, shell stays permission-controlled                            |                                                                                                      |

## What a switch would buy

1. A durable, replayable per-session event log with an `after` cursor and
   `follow`, plus a server-side `session.wait`. This is the concrete fix for
   the wait-logic problems in ROADMAP; both are experimental today.
2. Typed Promise client with declared domain errors and `ClientError`,
   per-request `AbortSignal`, and an `onActivity` callback for streaming
   keepalives.
3. Session-level `permissions` rules, `agent` and `model` at create time, and a
   first-class `location: { directory }` instead of the `directory` query hack.
4. Server auth by default, which closes "anything on localhost can drive the
   review server" in the multi-run app.
5. Future-proofing: 1.x is explicitly the legacy line.

## What it would cost

- Whole-stack change: V2 binary pin, config shape, plugin port, session-driving
  rewrite, auth plumbing, tests, docs. `src/shared/opencode.ts` is a
  review-quality trigger path, so the core benchmark subset should run
  (three repetitions) before merge. (Cutover PR: the maintainer scaled this
  down to one smoke pair × 2 arms × 1 repetition on the free Zen model,
  advisory only, no ledger row; see the PR.)
- Same failure class as the abandoned `sdk/v2` attempt; isolate the
  non-termination on a throwaway branch first, as ROADMAP prescribes.
- Experimental endpoints on the critical path; `effect` is at an RC.
- Open question on provider activation (above).

## Revisit triggers

- `npm view @opencode-ai/sdk deprecated` returns text, or 1.x stops tracking
  CLI releases.
- `session.wait` and the session log leave `/api/experimental/`; `effect` 4.0
  goes stable.
- A provider or feature jbot needs is V2-only.
- A V1 bug that upstream fixes only in V2.

## Re-running the probe

In a scratch directory with `HOME` and `XDG_*` pointed inside it:
`npm i @opencode/cli@<v> @opencode/client@<v>`, start
`node_modules/.bin/opencode serve --hostname 127.0.0.1 --port <p>` with
`OPENCODE_CONFIG_CONTENT` set, read the printed password, then call the API
with `OpenCode.make({ baseUrl, headers: { authorization: 'Basic ' +
base64('opencode:' + password) } })`.
