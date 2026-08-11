---
name: jbot-review-de-slop
description: Run a deletion-biased cleanup pass on jbot-review changes. Use when asked to de-slop a branch, remove AI-generated-looking code, reduce over-engineering, or perform a hostile cleanup before pushing, opening, or updating a PR.
---

# jbot-review-de-slop

Keep only code, tests, docs, and configuration that earn their place.

## Workflow

1. Inspect `git status --short --branch`, `git diff --stat`, `git diff --check`, the full worktree diff, and every untracked file. When commits exist, also inspect `git diff <base>...HEAD` against the PR base (usually `origin/main`).
2. Review only branch changes. Preserve unrelated user work.
3. Adjudicate comments block by block; a diff-wide "comments look fine" is not a verdict:
   - Enumerate every added or modified comment block first. Starting point: `git diff -U0 -- '*.ts' | grep -nE '^[+-][[:space:]]*(//|/\*|\*)'`; the unit of judgment is each match's full enclosing block in the file, not the diff fragment. A fully deleted block is already `cut`; paired `-`/`+` matches on the same block are one adjudication, not two.
   - Record one verdict per block: `cut` (the default), `rewrite` (true rationale at excess length — compress to the one or two lines stating what the code cannot say), or `keep` (concise and non-obvious). "It explains intent" justifies content, never length.
   - Restating what the code does, narrating what the old code did, or describing sibling code paths never justifies a keep.
4. Adjudicate added test cases the same way; coverage is never a keep reason (body edits inside existing cases get ordinary diff review, not the cut default):
   - Enumerate them first. Starting point: `git diff -U0 -- '*.test.ts' | grep -nE '^[+-][[:space:]]*(it|test)(\.[a-zA-Z]+)*(<.*>)?\('`. Matches on `-` lines are removals or renames — check them against step 8, do not verdict them as new cases.
   - Record one verdict per case: `cut` (the default), `fold` (assertions worth keeping that belong in an existing case), or `keep`.
   - A case earns `keep` only by naming the failure it alone would catch; a case whose failure always accompanies a sibling's failure is duplicate.
5. Delete or simplify:
   - one-use helpers, wrappers, types, options, or files that do not reduce complexity
   - duplicate validation, impossible-state guards, rethrow-only catches, and speculative fallbacks
   - assertions weakened or deleted inside existing tests to make a change pass; restore them when the contract is unchanged, or update them to assert the new contract when the PR states that behavior change — a rationale alone never discharges the assertion
   - provider-specific branches where an existing backend primitive or shared policy fits
   - repeated docs/config text, unused exports, and unrelated cleanup
6. Search before keeping new logic. Prefer existing prompt assembly, parsing, process timeout, concurrency, config, filtering, and cleanup primitives.
7. Keep additions only when they fix requested behavior, preserve an existing contract, enforce a jbot-review invariant, cover a real regression, or document a concrete operational constraint.
8. Do not simplify away full-diff coverage, fail-open auxiliary behavior, in-code trust boundaries, prompt budgets, marker contracts, or three-layer read-only enforcement. If deleting something might change product behavior or remove required evidence, flag it instead of guessing.
9. Run focused validation after edits and inspect the diff once more.

## Report

For each meaningful finding, report the file and issue, why it was slop, and whether the cleanup was applied. Finish with:

```text
Cut: <removed or simplified surface>
Comments: <blocks adjudicated> — <kept> kept, <rewritten> rewritten, <cut> cut
Tests: <cases adjudicated> — <kept> kept, <folded> folded, <cut> cut
Net line delta: <tracked git diff --numstat; list untracked files separately with line counts or binary>
Validation: <commands>
Residual risk: <none or concrete gap>
```

If no issues remain, say that directly, still report the adjudication counts, and list the validation run.
