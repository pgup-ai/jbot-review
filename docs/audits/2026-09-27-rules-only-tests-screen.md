# Rules-only test files screen — 2026-09-27

## Setup

This is the first live run of `JBOT_RULES_ONLY_TESTS`, which is opt-in and off by
default.

**What the flag does.** Test files whose diff only adds tests leave the main and
lens review pages, and only the guideline pass checks them. A file does not count
as additive when an existing file gains:

- a focus marker,
- a setup/teardown hook, or
- a module mock.

**Corpus.** An internal recall set of 12 PR heads from a private backend
repository, with 54 known issues.

Across all 12 heads, the classifier marks 12 test files as rules-only. They make up
9.6% of all diff bytes (49.6 KB of 518.7 KB), and 6 of the 12 heads have at least
one. 4 of the 54 known issues sit at least partly in those files, all of them
judgment calls rather than written-rule violations. The hook rule keeps a fifth
known issue, which sits in a hook added to an existing spec, in the main review.

**Cases.** The two heads with the most rules-only bytes:

| Case | Rules-only files | Rules-only bytes | Share of diff |
| ---- | ---------------- | ---------------- | ------------- |
| A    | 1                | 27.4 KB          | 36%           |
| B    | 2                | 7.9 KB           | 26%           |

**Arms.** For each case, one run with the flag off and one with it on, run
concurrently: 4 reviews in total. All runs use
`opencode/muse-spark-1.3-contributor-free` (free, $0) through `review:local` in
dry-run mode.

**Scoring.** Keyword matching against the known issues, plus the AACR judge
(`judge:findings`, `opencode/nemotron-3-ultra-free`).

## Results

| 1 run per arm                        | A off | A on  | B off | B on |
| ------------------------------------ | ----- | ----- | ----- | ---- |
| Main pages                           | 4     | 3     | 2     | 1    |
| Slowest main page                    | 94 s  | 106 s | 76 s  | 83 s |
| Review wall time                     | 145 s | 146 s | 78 s  | 84 s |
| Main input tokens (incl. cache)      | 255k  | 409k  | 582k  | 392k |
| Guideline-pass input tokens          | 179k  | 179k  | 87k   | 87k  |
| Findings posted                      | 0     | 1     | 0     | 0    |
| Known issues matched (keyword/judge) | 0/2   | 0/2   | 0/6   | 0/6  |

**Speed: no gain.**

- Main pages run in parallel, so review time follows the slowest page.
- Removing a test file's own page (A) did not shorten that page.
- When the remaining files packed into fewer, larger pages (B), the one page ran
  slower.
- Both cases were within run-to-run noise.

**Tokens: inconclusive.** Main input fell 33% in B, with one session fewer, and
rose 60% in A. Exploration turns vary more between runs than the removed bytes do.

**Guideline pass: unchanged.** Its input matched across arms to within 10 tokens.
Context-pack evidence varies from run to run, which explains the small difference.
The pass is the same by construction.

**Quality: nothing to compare.** At this effort, the model found none of the 8
known issues in either arm.

- The one posted finding came from the guideline pass in A with the flag on. It is
  a genuine written-rule violation in the rules-only test file.
- The flag-off guideline pass had the same input and missed it, which is ordinary
  run-to-run variance.
- The flag-off main review, which did see the file, did not report it either.

## Verdict

Keep the flag off by default. On this model, rules-only routing does not buy
review time, because the page that finishes last sets the review time, and test
files are rarely on that page. The mechanism works as designed:

- rules-only files leave the main pages;
- the guideline pass still checks them and reports real rule violations;
- the review body names them.

A default flip would need a slow-page case, where test bytes sit on the page that
finishes last. It would also need the full benchmark (AGENTS.md).

## Caveats

- One run per arm. Page timing and token counts vary more between runs than these
  differences.
- There were only two cases, both from a single repository, and both used a
  single weak free model. With a stronger or slower model, or under a tighter
  session cap, the page count may matter more.
- The known-issue key comes from human review threads. Findings it does not list
  may still be genuine.
