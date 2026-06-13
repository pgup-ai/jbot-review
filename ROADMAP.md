# Roadmap

## Next: OpenCode SDK modernization (validate each via dogfood + golden set)

- **Drop the chdir mutex in favor of per-request `directory`.**
  `session.create`/`promptAsync`/`messages`/`status` accept `query.directory`;
  we now pass it while still spawning the server from the workspace cwd for
  compatibility. Next step: verify the directory param fully scopes tool
  execution (git, file reads) in app mode before removing the chdir mutex.

## Completed

- **Migrate sessions to `@opencode-ai/sdk/v2` for native structured output.**
  Use the v2 SDK import and pass JSON-schema `format` objects on review,
  guideline, addressed-thread, verifier, and repair prompts. Keep
  `parseJsonObject` and the one-shot repair loop as fallback validation until
  dogfood + golden runs prove the native schema path is enough on its own.
- **Replace 2s full-message polling with `client.event.subscribe()` (SSE).**
  Wait for `message.updated`/`session.status` events, then fetch the completed
  assistant message once by id. Keep the bounded polling path as a compatibility
  fallback if event subscription is unavailable.
- **Upgrade `@opencode-ai/sdk` 1.16.2 -> 1.17.5.** Re-checked the generated
  type surfaces: v1 supports per-request `query.directory`,
  `session.messages` `limit`, and `event.subscribe()`; v2 exposes JSON-schema
  output formatting but still needs a dedicated migration branch.

## Later: feedback memory for review quality

- Learn from explicit human replies to J-Bot comments, such as "Not applied" explanations and recurring corrections.
- Mine repeated senior-review patterns into durable, editable repository guidance rather than hidden model state.
- Keep learning transparent and manageable so teams can inspect, edit, or remove remembered review rules.
- Use learned rules only as review guidance; do not auto-resolve or suppress future findings without current-code evidence.
