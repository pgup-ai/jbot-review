# Roadmap

## Done: OpenCode V2 cutover (2026-09)

- The backend now targets `@opencode/client` + `@opencode/cli` 2.x (design:
  `docs/superpowers/specs/2026-09-16-opencode-v2-migration-design.md`). The
  earlier `@opencode-ai/sdk/v2` stall was a caller-supplied message id on the
  1.x server's v2 routes; the V2 driver sends none and waits with `session.wait`.
- Follow-ups: flip `JBOT_VERIFY_FORK` / `JBOT_REVIEWER_AGENT` defaults after
  the eval; the durable session log (`session.log`) as a telemetry source once
  `follow` works upstream; run stats as a telemetry row; guideline text as
  API-managed instruction entries; agent `steps` caps as a harness-level
  exploration budget; review playbooks as opencode skills.

## Later: feedback memory for review quality

- Learn from explicit human replies to J-Bot comments, such as "Not applied" explanations and recurring corrections.
- Mine repeated senior-review patterns into durable, editable repository guidance rather than hidden model state.
- Keep learning transparent and manageable so teams can inspect, edit, or remove remembered review rules.
- Use learned rules only as review guidance; do not auto-resolve or suppress future findings without current-code evidence.
