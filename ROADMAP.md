# Roadmap

## Next: OpenCode SDK modernization (validate each via dogfood + golden set)

- **Drop the chdir mutex in favor of per-request `directory`.**
  `session.create`/`promptAsync`/`messages`/`status` accept `query.directory`;
  we now pass it while still spawning the server from the workspace cwd for
  compatibility. Next step: verify the directory param fully scopes tool
  execution (git, file reads) in app mode before removing the chdir mutex.

## Completed

- **Migrate sessions to `@opencode-ai/sdk/v2`.** Use the v2 SDK import and its
  flat session API (`promptAsync`/`messages`/`status` with projected message
  reads). Native JSON-schema `format` was evaluated and **not** adopted: the
  live `opencode-go` provider routes schema output through tool_choice paths
  that small models satisfy with tool-only messages, so prompt-level JSON plus
  `parseJsonObject` and the one-shot repair loop remain the validation path.
- **Prompt completion keys on the assistant message, not session idle.** The
  wait polls `session.messages`/`session.status` and returns as soon as the new
  assistant message reports `time.completed` (or the session reports idle).
  An earlier SSE/`event.subscribe()` rewrite that waited only for session idle
  was reverted — under `opencode-go` the session can stay `busy` long after the
  message completes, which hung every shard to the timeout.
- **Upgrade `@opencode-ai/sdk` 1.16.2 -> 1.17.5.** Re-checked the generated
  type surfaces: v1 supports per-request `query.directory`,
  `session.messages` `limit`, and `event.subscribe()`; v2 exposes JSON-schema
  output formatting but still needs a dedicated migration branch.

## Later: feedback memory for review quality

- Learn from explicit human replies to J-Bot comments, such as "Not applied" explanations and recurring corrections.
- Mine repeated senior-review patterns into durable, editable repository guidance rather than hidden model state.
- Keep learning transparent and manageable so teams can inspect, edit, or remove remembered review rules.
- Use learned rules only as review guidance; do not auto-resolve or suppress future findings without current-code evidence.
