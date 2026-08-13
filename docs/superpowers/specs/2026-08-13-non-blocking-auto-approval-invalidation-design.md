# Non-blocking auto-approval invalidation

## Goal

Keep J-Bot auto-approval useful without allowing a failed review run to block a pull request that another reviewer has approved.

## Design

J-Bot approves only the exact head it reviewed. It does not submit `REQUEST_CHANGES` to supersede an earlier approval. When a pull request receives another push, the repository's **Require approval of the most recent reviewable push** rule makes the earlier approval insufficient for merging. A successful clean review may approve the new head; a failed or non-clean review leaves approval to another eligible reviewer.

Same-head reruns retain an existing J-Bot approval. J-Bot still refuses to approve when the pull request is closed, draft, not mergeable, changes head during review, has new findings, or has unresolved J-Bot findings.

Consumer workflows continue to own repository policy. They must pass the declared `auto-approve` action input and may enable the latest-push approval rule in branch protection. J-Bot does not duplicate CI gates or require review-dismissal authority.

## Error handling

An ambiguous approval-posting failure or failed post-approval continuity check fails the review run without submitting a blocking review. The existing approval safety checks remain otherwise unchanged.

## Validation

- Unit tests prove stale and same-head approvals never produce `REQUEST_CHANGES`.
- Unit tests preserve exact-head approval, duplicate suppression, and post-approval continuity checks.
- Workflow contract tests prove the canonical and consumer workflows pass `auto-approve` through `with:`.
