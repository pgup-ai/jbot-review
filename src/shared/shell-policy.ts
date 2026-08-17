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
 * `git branch` and `git tag` are absent deliberately: their mutation is a FLAG
 * (`-D`, `-d`), so denying the subcommand would block the read too, and a model
 * does not reach for `-D` by accident. Where the mutation has its own
 * subcommand name (`git submodule update`, `git worktree remove`) it is denied
 * outright — that costs no read.
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
  // Not `git merge*`: that glob also swallows the read-only `git merge-base`
  // and `git merge-tree`. No bare `git merge` rule either — opencode does not
  // document whether a wildcard-free pattern is anchored, and a prefix match
  // would deny those same reads; bare `git merge` falls to the catch-all.
  'git merge *': 'deny',
  // Writes <current-file> in place unless given -p/--stdout.
  'git merge-file*': 'deny',
  'git cherry-pick*': 'deny',
  'git revert*': 'deny',
  'git apply*': 'deny',
  'git am*': 'deny',
  'git submodule update*': 'deny',
  'git submodule deinit*': 'deny',
  'git worktree remove*': 'deny',
  'rm*': 'deny',
} as const;
