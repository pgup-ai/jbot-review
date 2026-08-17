/**
 * Bash guardrail — an ACCIDENT filter, NOT a security boundary. Measured
 * (2026-07-09, opencode 1.17): the literal forms are blocked, but one-step
 * rewrites walk straight through — `git -c core.pager=cat commit` evades
 * `git commit*`, `sh -c "rm x"` evades `rm*`, and `echo x > f` needs no denied
 * command name at all. So this stops a well-behaved model that reaches for
 * `git stash`/`git checkout` to orient itself (the real, observed failure mode,
 * and the one that would clobber a developer's uncommitted work in local mode).
 * It does NOT stop an injected one. Isolation — the ephemeral CI container and
 * the app's temp clone — remains the actual boundary; never relax another layer
 * because this exists.
 *
 * Subcommands whose common form is a READ — `git branch`, `git tag`,
 * `git worktree list` — are absent deliberately: denying them would block the
 * read, and their mutating flags are not an accident a model falls into.
 *
 * The `*: allow` catch-all is load-bearing: opencode defaults UNMATCHED commands
 * to "ask" once a rule map exists, which would hang a headless run.
 */
export const BASH_PERMISSIONS = {
  '*': 'allow',
  'git commit*': 'deny',
  'git push*': 'deny',
  'git checkout*': 'deny',
  'git switch*': 'deny',
  'git reset*': 'deny',
  'git clean*': 'deny',
  'git stash*': 'deny',
  'git restore*': 'deny',
  'git rm*': 'deny',
  'git mv*': 'deny',
  'git rebase*': 'deny',
  // Split, not `git merge*`: that glob also swallows the read-only
  // `git merge-base`, `git merge-tree`, and `git merge-file`.
  'git merge': 'deny',
  'git merge *': 'deny',
  'git cherry-pick*': 'deny',
  'git revert*': 'deny',
  'git apply*': 'deny',
  'git am*': 'deny',
  'rm*': 'deny',
} as const;
