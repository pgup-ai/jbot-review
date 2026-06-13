# Roadmap

## Next: OpenCode SDK modernization (validate each via dogfood + golden set)

- **Migrate sessions to `@opencode-ai/sdk/v2` for native structured output.**
  The v2 generated request types expose JSON-schema output formatting
  (`type: "json_schema"` plus `schema` and `retryCount`), which should enforce
  the findings schema at the SDK layer with built-in retries — eventually
  retiring our salvage parser (`parseJsonObject` candidate extraction) and the
  one-shot JSON repair loop. Biggest reliability win available; needs runtime
  validation because v2 request/response shapes differ (`path.sessionID`,
  message envelopes).
- **Replace 2s polling with `client.event.subscribe()` (SSE).** The current
  loop refetches the full message list (including large diff-context parts)
  every 2 seconds per session, up to 6 sessions in parallel for up to 15
  minutes. The event stream pushes message/session updates so messages are
  fetched once, on completion. Alternatively, `session.messages` accepts a
  `limit` query param — verify its ordering semantics before using it.
- **Drop the chdir mutex in favor of per-request `directory`.**
  `session.create`/`promptAsync`/`messages`/`status` accept `query.directory`;
  we now pass it while still spawning the server from the workspace cwd for
  compatibility. Next step: verify the directory param fully scopes tool
  execution (git, file reads) in app mode before removing the chdir mutex.

## Completed

- **Upgrade `@opencode-ai/sdk` 1.16.2 -> 1.17.5.** Re-checked the generated
  type surfaces: v1 supports per-request `query.directory`,
  `session.messages` `limit`, and `event.subscribe()`; v2 exposes JSON-schema
  output formatting but still needs a dedicated migration branch.

## Later: feedback memory for review quality

- Learn from explicit human replies to J-Bot comments, such as "Not applied" explanations and recurring corrections.
- Mine repeated senior-review patterns into durable, editable repository guidance rather than hidden model state.
- Keep learning transparent and manageable so teams can inspect, edit, or remove remembered review rules.
- Use learned rules only as review guidance; do not auto-resolve or suppress future findings without current-code evidence.
