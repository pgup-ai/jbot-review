# Roadmap

## Abandoned: `@opencode-ai/sdk/v2` client migration

- **The v2 client (`@opencode-ai/sdk/v2`) breaks review completion** and was
  reverted to the proven v1 client (`@opencode-ai/sdk`). Same installed package
  (`1.17.5`) and same spawned server in both cases — only the client API surface
  differs. Under v2, every review shard streamed `busy` for the full per-prompt
  budget and never produced a completed assistant message, so the run timed out
  (`did not finish within 1770s`). The v1 client completes the same PRs in
  minutes (confirmed against other branches' runs). Root cause was upstream of
  the wait: the model session never terminates under the v2 `promptAsync` path
  (suspected `agent: 'plan'` / caller-supplied `messageID` semantics), so no
  wait logic — message-completion or session-idle — could help.
- Native JSON-schema `format` and the SSE/`event.subscribe()` wait were part of
  the same v2 effort and went with it. They added no production value: `format`
  was inert for the live `opencode-go` provider, and the SSE wait keyed on a
  session-idle signal that never fires under that gateway. Prompt-level JSON +
  `parseJsonObject` + the one-shot repair loop remain the validation path.
- If v2 is revisited, isolate the non-termination first (drop the caller
  `messageID`, verify the `plan` agent is honored) on a throwaway branch before
  touching the review runtime.

## Later: feedback memory for review quality

- Learn from explicit human replies to J-Bot comments, such as "Not applied" explanations and recurring corrections.
- Mine repeated senior-review patterns into durable, editable repository guidance rather than hidden model state.
- Keep learning transparent and manageable so teams can inspect, edit, or remove remembered review rules.
- Use learned rules only as review guidance; do not auto-resolve or suppress future findings without current-code evidence.
