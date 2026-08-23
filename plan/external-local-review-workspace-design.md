# External-checkout local review — design (2026-08-23)

`review:local` already reviews whichever Git worktree is `process.cwd()`. Make
that capability explicit and safe with two arguments:

```bash
npm run review:local -- \
  --workspace /path/to/checked-out-repo \
  --base origin/main
```

The caller owns cloning, fetching, and checking out the desired branch or PR
head. jbot-review only reviews the prepared checkout.

## Why this shape

The current cross-repository invocation works only by changing into the target
repository and calling jbot-review's `tsx` executable by absolute path. Running
`npm --prefix <jbot-review> run review:local` points `process.cwd()` back at
jbot-review and silently reviews the wrong repository. A supported workspace
argument removes that footgun without adding a network-facing PR importer.

Three boundaries keep the change small:

1. **The checkout is the input.** No clone, fetch, branch switch, GitHub API, or
   PR-number handling belongs in local review.
2. **Diff semantics do not change.** The review remains merge-base to working
   tree, including tracked uncommitted changes. Untracked files remain excluded
   unless the caller marks them intent-to-add.
3. **The target is review data, not configuration.** jbot configuration and
   artifacts remain owned by the launching checkout; repository guidelines and
   source context come from the target checkout.

## Command contract

`review:local` accepts:

- `--workspace <path>`: an existing local Git worktree. Relative paths resolve
  from the directory where the command was launched. A path inside a worktree
  normalizes to that worktree's top-level directory.
- `--base <ref>`: the locally available base ref or SHA. It takes precedence
  over `JBOT_LOCAL_BASE`; when neither is supplied, the existing
  `origin/HEAD` then `origin/main` fallback remains.
- `--preview`: existing credential-free preview behavior.

Unknown arguments, missing values, a nonexistent workspace, a bare/non-Git
directory, an unavailable base ref, or a base with no common ancestor fail
before any model session starts. The command never fetches to repair an
unavailable or stale ref.

The current invocation without either new argument remains byte-for-byte
compatible in behavior:

```bash
npm run review:local
```

## Startup and path ownership

The local entry point captures one absolute `launchRoot` before changing the
process working directory, then performs startup in this order:

1. Parse arguments without side effects.
2. Load `.env` from `launchRoot`, with the real process environment
   retaining precedence.
3. Resolve and validate the workspace, then change to its Git top level.
4. Resolve the explicit argument or environment base ref.
5. Run the existing local-review pipeline from the target worktree.

Bootstrap loads exactly one `.env`, from `launchRoot`, before any `chdir`. It
never additionally loads an `.env` from a distinct target workspace. If
`launchRoot` and the target Git root are the same (including
`--workspace .`), this preserves today's single repo-root `.env` behavior.
This prevents a distinct arbitrary checkout from changing the model, provider,
gateway, output, or credential configuration. Repository-scoped guideline
discovery (`AGENTS.md` and the existing supported files) still runs from the
target root because those files are intentional review context.

Every launcher-owned configuration and output path derives from the captured
`launchRoot`, never from the post-`chdir` process cwd. The built-in
`artifactRoot` is the absolute `<launchRoot>/.jbot-review`; a relative
`JBOT_BENCHMARK_OUTPUT` resolves against `launchRoot`, while an absolute value
stays absolute. Consequently:

- configuration loads from `<launchRoot>/.env`;
- telemetry writes to `<artifactRoot>/telemetry.jsonl`;
- the optional local report writes to `<artifactRoot>/last-run.md`;
- gateway-isolation telemetry is preserved to that same `artifactRoot` rather
  than the target or temporary worktree;
- relative benchmark output is resolved once from `launchRoot` before `chdir`.

Git operations, source discovery, guideline discovery, blast-radius lookup,
and model-session workspace access use the target Git root. This separation
keeps the external checkout unchanged by the review driver's own output. The
existing explicit local-report and telemetry behavior remains unchanged when
the launch directory and target workspace are the same.

## Review data flow

After bootstrap, the current pipeline remains authoritative:

1. Resolve the base ref and merge base against target `HEAD`.
2. Build the complete merge-base-to-working-tree diff.
3. Discover target-repository guidelines and supplementary context under their
   existing budgets.
4. Run `runPrReview` in enforced dry-run mode against the target workspace.
5. Print the existing report and write optional artifacts through the resolved
   launcher-owned paths.

Report content stays unchanged in this scope. Research callers that need an
immutable run manifest should record the checked-out base and head SHAs before
invocation rather than expanding this local-input adapter.

Gateway-routed review keeps its existing committed-HEAD contract and exclusion
of uncommitted changes. `--workspace` does not infer or populate
`JBOT_ACP_GATEWAY_REPO`, `JBOT_ACP_GATEWAY_REF`, or credentials from the target
remote.

## Components

- A small pure local-argument module owns parsing, precedence, and path
  resolution. It has no Git or process side effects.
- `src/local/index.ts` owns bootstrap, worktree validation, `chdir`, and wiring
  the resolved base and artifact directory into the existing pipeline.
- The telemetry sink accepts an optional explicit artifact directory; all
  existing callers retain the workspace-local default. The local driver passes
  `artifactRoot` through both ordinary and gateway-isolated review paths.
- `src/local/util.ts` continues to own dotenv and report formatting; report
  content does not change.

No new dependency is required.

## Testing

Pure unit tests cover:

- `--workspace` and `--base` parsing, missing values, and unknown arguments;
- CLI-over-environment base precedence;
- relative workspace resolution and Git-root normalization;
- launch-directory artifact paths;
- relative and absolute benchmark-output resolution.

A temporary-repository integration test invokes `--preview` against a target
worktree different from the launch directory and proves:

- the diff and guideline discovery come from the target;
- the launch directory's `.env` is used and a target `.env` is ignored;
- preview leaves the target's pre-existing Git status unchanged;
- an invalid base fails before credentials or sessions are required;
- the original no-argument local workflow still selects the launch checkout.

Normal validation is `npm test`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, and `npm run build`, followed by a credential-free
external-worktree `--preview` smoke run.

## Non-goals

- Accepting a GitHub PR URL or number.
- Preparing, switching, creating, or deleting the caller's target checkout or
  worktrees. The existing internal gateway-isolation worktree remains required
  and unchanged.
- Reading PR title/body, comments, checks, prior review threads, or live state.
- Posting findings to GitHub.
- Making private-repository authentication decisions.
- Running repository-provided setup, build, or test commands.

A checked-out PR head is therefore reviewed as code and local repository
context, not as a live GitHub PR. A later research adapter may supply immutable
base/head SHAs and PR metadata, but it should build on this local-workspace
contract rather than expand this command's responsibilities.
