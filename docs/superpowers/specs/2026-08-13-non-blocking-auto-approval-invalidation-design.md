# Non-blocking auto-approval invalidation

## Goal

Keep J-Bot auto-approval useful without allowing a failed review run to block a pull request that another reviewer has approved.

## Design

J-Bot approves only the exact head it reviewed. It does not submit `REQUEST_CHANGES` to supersede an earlier approval. When a pull request receives another push, the repository's **Require approval of the most recent reviewable push** rule makes the earlier approval insufficient for merging. A successful clean review may approve the new head; a failed or non-clean review leaves approval to another eligible reviewer.

Enabling **Require approval of the most recent reviewable push** is a prerequisite for safe use of J-Bot auto-approval. Without it, an approval for an older head may continue to satisfy branch protection after a push.

Same-head reruns retain an existing J-Bot approval. J-Bot still refuses to post another approval when the pull request is closed, draft, not mergeable, changes head during review, has new findings, or has unresolved J-Bot findings. A same-head rerun that newly finds an issue does not invalidate the existing approval; this is the deliberate tradeoff that avoids giving J-Bot a blocking veto without review-dismissal authority.

Consumer workflows continue to own repository policy. FMS Frontend separately replaces the obsolete `INPUT_AUTO-APPROVE` environment bridge with the wrapper's declared `with: auto-approve` input. J-Bot does not duplicate CI gates and never calls review-dismissal APIs.

## Error handling

An ambiguous approval-posting failure or failed post-approval continuity check fails the review run without submitting a blocking review. The existing approval safety checks remain otherwise unchanged.

## Validation

- Runner-level tests cover old-head approval startup and same-head non-clean reruns, proving the review proceeds and no `REQUEST_CHANGES` review is created.
- Approval tests preserve exact-head approval and duplicate suppression. Ambiguous approval submission and failed post-approval continuity checks remain fatal without posting a compensating review.
- J-Bot's canonical workflow contract test continues to require `with: auto-approve`. FMS Frontend validates its consumer workflow independently with YAML parsing, `actionlint`, and an assertion that the action step has the `with: auto-approve` binding and no `INPUT_AUTO-APPROVE` bridge.
