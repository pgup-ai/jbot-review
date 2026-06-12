# Roadmap

## Next: OpenCode SDK modernization (validate each via dogfood + golden set)

- **Migrate sessions to `@opencode-ai/sdk/v2` for native structured output.**
  The v2 `session.prompt` accepts `format: { type: "json_schema", schema,
retryCount }`, which enforces the findings schema at the SDK layer with
  built-in retries — retiring our salvage parser (`parseJsonObject` candidate
  extraction) and the one-shot JSON repair loop. Biggest reliability win
  available; needs runtime validation because v2 request/response shapes
  differ (`path.sessionID`, message envelopes).
- **Replace 2s polling with `client.event.subscribe()` (SSE).** The current
  loop refetches the full message list (including large diff-context parts)
  every 2 seconds per session, up to 6 sessions in parallel for up to 15
  minutes. The event stream pushes message/session updates so messages are
  fetched once, on completion. Alternatively, `session.messages` accepts a
  `limit` query param — verify its ordering semantics before using it.
- **Drop the chdir mutex in favor of per-request `directory`.**
  `session.create`/`promptAsync`/`messages` accept `query.directory`; one
  server could then serve any workspace without mutating process-global cwd
  (`startOpencode`'s serialization exists only for that hack). Verify the
  directory param fully scopes tool execution (git, file reads) in app mode
  before removing the chdir.
- **Upgrade `@opencode-ai/sdk` 1.16.2 → 1.17.x** and re-check the surfaces
  above; v1 `session.prompt` gains `outputFormat` in newer releases per the
  docs.

## Later: feedback memory for review quality

- Learn from explicit human replies to J-Bot comments, such as "Not applied" explanations and recurring corrections.
- Mine repeated senior-review patterns into durable, editable repository guidance rather than hidden model state.
- Keep learning transparent and manageable so teams can inspect, edit, or remove remembered review rules.
- Use learned rules only as review guidance; do not auto-resolve or suppress future findings without current-code evidence.
