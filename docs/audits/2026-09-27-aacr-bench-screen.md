# AACR-Bench holdout screen — 2026-09-27

## Setup

This is the first external holdout run of jbot on
[AACR-Bench](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench), using
`npm run holdout:aacr`. Holdout discipline applies: the result is reported, never
tuned against.

- **Sample:** 10 PRs, 1 per language, seed 20260927
  (`test/fixtures/aacr-bench/sample-10.json`), with 68 expert-verified comments.
- **Code:** `feat/aacr-bench-holdout` at 2c95894. Full default pipeline via
  `review:local`, verification included.
- **Models:** free Zen routes; space-bunny at its default high effort, muse at its default.
- **Judge:** the official AACR matcher and prompt, run on
  `opencode/nemotron-3-ultra-free`. The paper used Qwen3-235B. Before the run, this
  judge agreed with 10 of 12 hand-labelled finding–issue pairs. Both disagreements
  credited a near-miss from the same bug family.

## Results

| 10 PRs, 68 comments   | space-bunny-free      | muse-spark-1.3-contributor-free |
| --------------------- | --------------------- | ------------------------------- |
| Semantic matches      | 5                     | 6                               |
| Semantic P / R        | 0.192 / 0.074         | 0.400 / 0.088                   |
| **SEM-F1**            | 0.107                 | 0.144                           |
| Line P / R / F1       | 0.385 / 0.147 / 0.213 | 0.533 / 0.118 / 0.193           |
| Comments posted       | 26                    | 15                              |
| Wall, median (total)  | 222 s (2,797 s)       | 55 s (545 s)                    |
| Tokens per PR, median | 893k in / 18.9k out   | 175k in / 4.8k out              |
| Failed PRs            | 0                     | 0                               |

**Quality.** The models differ by one match out of 68. At this sample size, that is
noise.

**Speed and cost.** These differences are real. Muse was faster on 9 of the 10 PRs
and used about 5× fewer tokens.

**Published SEM-F1, for orientation only.** The paper's figures use a different judge,
frontier models and all 200 PRs, so they are not comparable to this screen:

| System      | SEM-F1 |
| ----------- | ------ |
| OCR         | 21–25% |
| Claude Code | ~12%   |
| Codex       | ~8%    |

## Caveats

- **Sample size.** 10 PRs cannot resolve less than about a 2× effect. Widen to
  50–60 stratified PRs before quoting a number.
- **Judge leniency.** The judge tends to accept near-misses from the same bug family,
  which inflates matches. Its sampling temperature isn't controlled through opencode.
- **Contamination.** The PRs are public.
- **Delivery.** Verification refuted 7 of space-bunny's 34 candidates. Both react
  candidates were refuted, so that PR posted nothing.

## Operational notes

- **Clones.** Treeless bare clones fetch in 1–10 s. Checkouts pull only head files,
  and the cache under `.jbot-review/aacr/repos` is 960 MB for these 10 repos.
- **Git LFS.** Repos that use LFS (for example cline/cline) keep pointer files, since
  git-lfs may be absent.
