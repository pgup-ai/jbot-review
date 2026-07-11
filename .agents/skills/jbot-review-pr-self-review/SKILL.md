---
name: jbot-review-pr-self-review
description: Run a pre-PR or pre-push self-review for jbot-review changes. Use before opening, updating, or marking a jbot-review PR ready; after addressing review feedback; or when asked to audit a branch for invariant violations, incomplete provider surfaces, security regressions, missing tests, or contract drift.
---

# jbot-review-pr-self-review

Audit the final branch after implementation and before publication.

## Workflow

1. Inspect the complete change against the real base:
   - `git status --short --branch`
   - fetch and resolve the intended base, normally `origin/main`
   - inspect `git diff --stat`, `git diff --check`, and every changed/untracked file
   - after committing, confirm the same scope with `git diff origin/main...HEAD`
2. Re-read `AGENTS.md` and verify the final diff against every applicable invariant.
3. Trace every changed contract through its full surface. For provider work, check:
   - provider catalog, model parsing, backend selection, runner lifecycle, and cleanup
   - Action inputs/env mapping, local mode, Docker installation, examples, docs, and workflows
   - main/aux combinations, unchanged existing-provider behavior, and prompt-cache policy
4. Review the trust boundaries manually:
   - no secret values in logs, child environments, argv, reports, or committed fixtures
   - auth files and temp homes have narrow permissions and deterministic cleanup
   - model sessions cannot edit the checkout or activate repo-controlled hooks/plugins/config
   - full-diff coverage fails closed for the main review; auxiliary sessions fail open
   - concurrent sessions cannot race mutable credentials or shared state
5. Verify external CLI/API assumptions against current documentation and an installed-version smoke test when credentials permit. Separate confirmed behavior from unresolved operational risk.
6. Run `jbot-review-de-slop`, apply every valid finding, and inspect the updated diff again.
7. Validate in proportion to risk:
   - focused tests for new pure helpers and routing
   - `npm run format`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
   - build the Docker image when CLI packaging changes
   - dogfood the real review pipeline when auth and provider availability permit
8. Reinspect the final committed diff. Do not call the branch ready when validation or a required contract remains unexplained.

## Report

Lead with remaining findings. If none remain, report:

```text
Self-review: no P1/P2 issues found
Seams touched: <list>
Validation: <commands>
Residual risk: <none or concrete gap>
```
