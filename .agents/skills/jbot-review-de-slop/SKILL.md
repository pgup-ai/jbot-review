---
name: jbot-review-de-slop
description: Run a deletion-biased cleanup pass on jbot-review changes. Use when asked to de-slop a branch, remove AI-generated-looking code, reduce over-engineering, or perform a hostile cleanup before pushing, opening, or updating a PR.
---

# jbot-review-de-slop

Keep only code, tests, docs, and configuration that earn their place.

## Workflow

1. Inspect `git status --short --branch`, `git diff --stat`, `git diff --check`, the full worktree diff, and every untracked file. When commits exist, also inspect `git diff origin/main...HEAD`.
2. Review only branch changes. Preserve unrelated user work.
3. Delete or simplify:
   - comments that narrate code instead of explaining a non-obvious invariant
   - one-use helpers, wrappers, types, options, or files that do not reduce complexity
   - duplicate validation, impossible-state guards, rethrow-only catches, and speculative fallbacks
   - provider-specific branches where an existing backend primitive or shared policy fits
   - repeated docs/config text, low-value tests, unused exports, and unrelated cleanup
4. Search before keeping new logic. Prefer existing prompt assembly, parsing, process timeout, concurrency, config, filtering, and cleanup primitives.
5. Keep additions only when they fix requested behavior, preserve an existing contract, enforce a jbot-review invariant, cover a real regression, or document a concrete operational constraint.
6. Do not simplify away full-diff coverage, fail-open auxiliary behavior, in-code trust boundaries, prompt budgets, marker contracts, or three-layer read-only enforcement.
7. Run focused validation after edits and inspect the diff once more.

## Report

For each meaningful finding, report the file and issue, why it was slop, and whether the cleanup was applied. Finish with:

```text
Cut: <removed or simplified surface>
Net line delta: <git diff --numstat summary>
Validation: <commands>
Residual risk: <none or concrete gap>
```
