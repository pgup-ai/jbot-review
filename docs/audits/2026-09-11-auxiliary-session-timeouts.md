# Auxiliary session timeouts

Why auxiliary review sessions (lens passes, guideline check, addressed check,
changes-since summary) still time out or come back incomplete, from the last
two days of `J-Bot Code Review` runs on `integral-xyz/fms` (Depot CI) and
`integral-xyz/fms-frontend` (GitHub Actions). Observational only: no code,
configuration, or pool change was made.

## Answer

Four distinct mechanisms produce the "did not complete" auxiliary sessions.
They differ in cause and fix, and only two are timeouts.

| #   | Mechanism                                                                                               |     Sessions | Attempts | What the log says                                                                     |
| --- | ------------------------------------------------------------------------------------------------------- | -----------: | -------: | ------------------------------------------------------------------------------------- |
| 1   | Fixed 300 s post-main grace: a slow auxiliary route is cut off 5 minutes after a fast main pass         |           20 |       14 | `<label> still running 300s after the main review; abandoning it.`                    |
| 2   | CommandCode route failures within seconds (dead model, provider 5xx, catalog miss). Not timeouts        |           39 |       12 | `exited 9: The model produced no response (continuation budget exhausted)` and kin    |
| 3   | OpenCode free tier `Free usage exceeded`: opencode retries forever, jbot waits until the finder timeout | 22 (+4 main) |        7 | `prompt still running (1446s, retry attempt 1: Free usage exceeded, subscribe to Go)` |
| 4   | 600 s hard cap on the `review-interactions` lens                                                        |            4 |        4 | `review-interactions timed out`                                                       |

Mechanism 1 is the only one that is a jbot deadline decision, and it is the
single largest cause of incomplete reviews: 14 of the 31 incomplete
reviews in finished attempts have grace abandonment as their only auxiliary
failure. Mechanism 2 is the largest cause of _reruns_: a CommandCode route failed the
same way as the main model in 13 attempts (10 of them on the
muse route), and the in-session retry reused that model and failed again.

What is **not** the cause: the global session cap of 5 (auxiliary queue time
was 0 s in every attempt; only `-continue`/`-repair` follow-ups start late),
the 30-minute time budget (never binding: the grace formula returns the full
300 s whenever less than 19.5 minutes have elapsed with verification on), verification budget
(no run skipped verification for lack of time), and Devin or Cline as the
auxiliary backend (both completed every session: Devin 37/37,
Cline 33/33).

## Method

- Depot: `depot ci workflow list --name "J-Bot Code Review"` (100 workflows),
  `depot ci workflow show` for attempt ids, `depot ci logs --timestamps` for
  every attempt: 98 attempt logs.
- GitHub: `gh run list --workflow jbot-review.yml` (150 runs, 30 not skipped),
  the per-attempt logs API for every attempt, plus every
  `jbot-review-telemetry` artifact (43): 47 attempt logs.
- A parser classifies every session from its `Calling … prompt` line to its
  completion, skip, abandonment, or timeout line; durations come from log
  timestamps. Telemetry artifacts confirm queue vs execution time for the
  GitHub side.
- Rates below use the 111 attempts that finished (Depot `finished`,
  GitHub `success`) and exclude sessions that only failed because the run had
  already ended (main failure teardown, cancellation): 336 auxiliary
  sessions, 266 completed (79%).
- Window: 2026-09-09 21:25 UTC to 2026-09-11 14:26 UTC. Three reviewer images
  ran (`acc484ea…` to 09-10 16:51, `0bafc656…` to 19:35, `f5f860aa…` after;
  the last is #214). 21 attempts were cancelled by the per-PR
  concurrency group and are excluded from rates.

## How the deadlines actually work

At the time of this audit (before the change on this branch), every auxiliary
session was submitted in the same second as the main shard and inherited the
finder timeout (1470 s at the 30-minute budget). But when the main pass
finished, `computeAuxiliaryGraceMs` started a settle grace of
`min(300 s, budget − elapsed − 30 s − 300 s)`; at these run lengths that was
always 300 s. Anything still running is abandoned and aborted by label. So the
effective auxiliary deadline is **main duration + 300 s**, independent of the
auxiliary route's own speed and of the 24 minutes of budget still unused.
Separately, `limitReviewBackendSessions` caps `review-interactions` alone at
600 s of execution (added in #206).

Main passes are short: median 96 s across 99 finished attempts,
62% under two minutes.

| Main model                                    | n   | median s | max s |
| --------------------------------------------- | --- | -------- | ----- |
| `commandcode/deepseek/deepseek-v4-flash-fast` | 20  | 98       | 574   |
| `opencode/muse-spark-1.3-contributor-free`    | 18  | 111      | 246   |
| `opencode-go/muse-spark-1.3-contributor`      | 14  | 92       | 200   |
| `commandcode/gpt-5.6-luna`                    | 14  | 12       | 17    |
| `cline/cline-free/muse-spark-1.3-contributor` | 8   | 56       | 133   |
| `devin/swe-2-medium`                          | 7   | 222      | 308   |
| `opencode-go/deepseek-flash`                  | 5   | 397      | 522   |
| `commandcode/deepseek/deepseek-v4.1-flash`    | 5   | 279      | 513   |
| `commandcode/meta/muse-spark-1.3-contributor` | 4   | 76       | 203   |
| `opencode-go/omen-alpha`                      | 3   | 290      | 325   |
| `commandcode/z-ai/glm-5.3-flash`              | 1   | 640      | 640   |

Completed auxiliary sessions by route:

| Aux route                                     | n   | median s | p90 s | max s |
| --------------------------------------------- | --- | -------- | ----- | ----- |
| `devin/swe-2-medium`                          | 37  | 45       | 157   | 413   |
| `opencode-go/muse-spark-1.3-contributor`      | 37  | 27       | 68    | 111   |
| `commandcode/deepseek/deepseek-v4-flash-fast` | 37  | 50       | 377   | 600   |
| `commandcode/gpt-5.6-luna`                    | 34  | 14       | 25    | 52    |
| `cline/cline-free/muse-spark-1.3-contributor` | 33  | 26       | 59    | 93    |
| `opencode/muse-spark-1.3-contributor-free`    | 29  | 36       | 104   | 354   |
| `commandcode/deepseek/deepseek-v4.1-flash`    | 25  | 10       | 161   | 295   |
| `opencode-go/deepseek-flash`                  | 21  | 17       | 244   | 388   |
| `commandcode/z-ai/glm-5.3-flash`              | 10  | 106      | 385   | 524   |
| `opencode-go/omen-alpha`                      | 3   | 49       | 49    | 63    |

The pool rotates per workflow attempt across the whole pool, so main and
auxiliary land on 78 distinct pairings in this window. A
12-second `gpt-5.6-luna` main paired with a 4–7-minute `deepseek-flash` or
`glm-5.3-flash` auxiliary is a routine draw, and that pairing is exactly what
mechanism 1 kills.

## 1. Grace abandonment (main + 300 s)

Every abandonment fired at exactly 300 s after the main pass. In all
20 cases the main pass was fast and the auxiliary route was one of three
slow ones.

| Attempt                                                                                            | Main model                                    | Main s | Aux session                 | Aux route                                  | Ran for s | Job wall s |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------- | -----: | --------------------------- | ------------------------------------------ | --------: | ---------: |
| [msf4xsvkzn](https://depot.dev/orgs/sr28q68rf1/workflows/vf280tvv4k)                               | `commandcode/gpt-5.6-luna`                    |      9 | `review-interactions`       | `opencode-go/deepseek-flash`               |       304 |        399 |
| [4zc0kxxd11](https://depot.dev/orgs/sr28q68rf1/workflows/ksv0vh73fr)                               | `commandcode/gpt-5.6-luna`                    |     13 | `guideline-compliance`      | `commandcode/deepseek/deepseek-v4.1-flash` |       313 |        358 |
| [4zc0kxxd11](https://depot.dev/orgs/sr28q68rf1/workflows/ksv0vh73fr)                               | `commandcode/gpt-5.6-luna`                    |     13 | `review-interactions`       | `commandcode/deepseek/deepseek-v4.1-flash` |       313 |        358 |
| [cs0q9wm8zk](https://depot.dev/orgs/sr28q68rf1/workflows/tm3ctkv5nf)                               | `commandcode/gpt-5.6-luna`                    |     13 | `review-interactions`       | `opencode-go/deepseek-flash`               |       301 |        410 |
| [vkqqp7kfln](https://depot.dev/orgs/sr28q68rf1/workflows/sk45z90v19)                               | `opencode/muse-spark-1.3-contributor-free`    |     32 | `review-interactions`       | `commandcode/z-ai/glm-5.3-flash`           |       346 |        390 |
| [wzc4nfkx6s](https://depot.dev/orgs/sr28q68rf1/workflows/b0zdsc8lm5)                               | `cline/cline-free/muse-spark-1.3-contributor` |     44 | `review-interactions`       | `commandcode/deepseek/deepseek-v4.1-flash` |       344 |        398 |
| [qv1r88prvm](https://depot.dev/orgs/sr28q68rf1/workflows/2khg16rn8q)                               | `commandcode/deepseek/deepseek-v4-flash-fast` |     45 | `review-interactions`       | `commandcode/deepseek/deepseek-v4.1-flash` |       345 |        448 |
| [34506830729 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34506830729/attempts/1) | `cline/cline-free/muse-spark-1.3-contributor` |     52 | `review-interactions`       | `opencode-go/deepseek-flash`               |       334 |        442 |
| [34506830729 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34506830729/attempts/1) | `cline/cline-free/muse-spark-1.3-contributor` |     52 | `review-frontend`           | `opencode-go/deepseek-flash`               |       334 |        442 |
| [34506830729 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34506830729/attempts/1) | `cline/cline-free/muse-spark-1.3-contributor` |     52 | `guideline-compliance`      | `opencode-go/deepseek-flash`               |       334 |        442 |
| [qvpwpdh6dz](https://depot.dev/orgs/sr28q68rf1/workflows/mvlwnd1l4k)                               | `opencode/muse-spark-1.3-contributor-free`    |     69 | `guideline-compliance`      | `commandcode/z-ai/glm-5.3-flash`           |       382 |        424 |
| [qvpwpdh6dz](https://depot.dev/orgs/sr28q68rf1/workflows/mvlwnd1l4k)                               | `opencode/muse-spark-1.3-contributor-free`    |     69 | `review-interactions`       | `commandcode/z-ai/glm-5.3-flash`           |       382 |        424 |
| [34418701096 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34418701096/attempts/1) | `commandcode/deepseek/deepseek-v4-flash-fast` |     74 | `changes-since-last-review` | `opencode/muse-spark-1.3-contributor-free` |       354 |        489 |
| [34418701096 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34418701096/attempts/1) | `commandcode/deepseek/deepseek-v4-flash-fast` |     74 | `addressed-prior-comments`  | `opencode/muse-spark-1.3-contributor-free` |       354 |        489 |
| [fzcqmjnxsc](https://depot.dev/orgs/sr28q68rf1/workflows/s15zjwwvxs)                               | `commandcode/deepseek/deepseek-v4-flash-fast` |     86 | `guideline-compliance`      | `opencode-go/deepseek-flash`               |       372 |        536 |
| [dvt6b8n1m9](https://depot.dev/orgs/sr28q68rf1/workflows/3135b7991c)                               | `opencode-go/muse-spark-1.3-contributor`      |    110 | `review-interactions`       | `opencode-go/deepseek-flash`               |       410 |        495 |
| [rt12jhsl0z](https://depot.dev/orgs/sr28q68rf1/workflows/z4f96q111f)                               | `opencode-go/muse-spark-1.3-contributor`      |    128 | `review-interactions`       | `opencode-go/deepseek-flash`               |       428 |        564 |
| [r4h8bfxz4h](https://depot.dev/orgs/sr28q68rf1/workflows/xv646h37b0)                               | `opencode/muse-spark-1.3-contributor-free`    |    159 | `review-interactions`       | `opencode-go/deepseek-flash`               |       459 |        512 |
| [r4h8bfxz4h](https://depot.dev/orgs/sr28q68rf1/workflows/xv646h37b0)                               | `opencode/muse-spark-1.3-contributor-free`    |    159 | `guideline-compliance`      | `opencode-go/deepseek-flash`               |       459 |        512 |
| [34417502223 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34417502223/attempts/1) | `opencode-go/omen-alpha`                      |    290 | `review-frontend`           | `commandcode/z-ai/glm-5.3-flash`           |       611 |        932 |

Cost: these attempts spent 345–450 s (one 642 s) of wall time after
the main pass, then discarded the work. Median job wall for incomplete Depot
reviews is 399 s against 177 s for complete ones.

Why those routes are slow is visible in their token counts. On CommandCode the
interactions lens is generation-bound: the "flash" models emit 10–37 K output
tokens at 30–120 tokens/s.

| Aux route (interactions lens, completed)      | n   | output tokens median |   max | dur median s | max s |
| --------------------------------------------- | --- | -------------------: | ----: | -----------: | ----: |
| `opencode-go/muse-spark-1.3-contributor`      | 14  |                   20 |   579 |           64 |   111 |
| `commandcode/gpt-5.6-luna`                    | 12  |                 1138 |  2299 |           16 |    30 |
| `commandcode/deepseek/deepseek-v4-flash-fast` | 8   |                10248 | 17209 |           74 |   600 |
| `opencode/muse-spark-1.3-contributor-free`    | 7   |                   20 |   537 |           83 |   142 |
| `commandcode/deepseek/deepseek-v4.1-flash`    | 3   |                32757 | 37351 |          173 |   286 |
| `opencode-go/deepseek-flash`                  | 2   |                  648 |   900 |          283 |   388 |
| `opencode-go/omen-alpha`                      | 1   |                 2291 |  2291 |           63 |    63 |
| `commandcode/z-ai/glm-5.3-flash`              | 1   |                19642 | 19642 |          524 |   524 |

On OpenCode Go, `deepseek-flash` reports tiny usage but stays `busy` for
5–6 minutes (tool loop or provider latency; opencode's usage line covers only
the final step). Its auxiliary completion rate is the worst of any route still
in the current pool.

## 2. CommandCode route failures (seconds, not timeouts)

| Aux route                                     | Failure                  | Sessions |
| --------------------------------------------- | ------------------------ | -------: |
| `commandcode/meta/muse-spark-1.3-contributor` | CLI exit 9 (no response) |       24 |
| `commandcode/meta/muse-spark-1.3-contributor` | CLI exit 7 (API error)   |        6 |
| `commandcode/gpt-5.6-luna`                    | CLI exit 7 (API error)   |        5 |
| `commandcode/deepseek/deepseek-v4.1-flash`    | unknown model            |        3 |
| `commandcode/deepseek/deepseek-v4.1-flash`    | CLI exit 7 (API error)   |        1 |

- `commandcode/meta/muse-spark-1.3-contributor` failed 30 of
  30 auxiliary sessions from 2026-09-10 13:09 to 2026-09-11 01:41 UTC,
  every one within 5–45 s. As main it failed permanently in
  10 attempts because the fresh-session retry keeps the same model
  (example: [bdnp69mcmv](https://depot.dev/orgs/sr28q68rf1/workflows/q16v804d4d): main, retry and three
  auxiliary sessions all exit 9 within 32 s). It is no longer in the current
  pool.
- `commandcode/deepseek/deepseek-v4.1-flash` returned `unknown model` for
  every session between 16:51 and 17:18 UTC on 2026-09-10 and completed
  25 sessions afterwards: a catalog miss, not a timeout. It is still in the pool.
- `commandcode/gpt-5.6-luna` hit `The API server encountered an error` five
  times.

These are reported in the review footer as "did not complete successfully",
indistinguishable from a timeout, and each one that also hit main produced a
manual rerun (attempt counts up to 4).

## 3. OpenCode free tier stalls

`opencode/muse-spark-1.3-contributor-free` was main or auxiliary in 37 attempts;
7 stalled on `Free usage exceeded, subscribe to Go` and one more failed on
`Rate limit exceeded (Console)`.

| Attempt                                                                                            | Free route role | Attempt status | Longest retry loop s | Job wall s | Outcome                       |
| -------------------------------------------------------------------------------------------------- | --------------- | -------------- | -------------------: | ---------: | ----------------------------- |
| [34418701096 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34418701096/attempts/1) | aux             | success        |                  302 |        489 | incomplete                    |
| [67p56rsl10](https://depot.dev/orgs/sr28q68rf1/workflows/zz0mts012r)                               | aux             | finished       |                   61 |        171 | incomplete                    |
| [34529776672 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34529776672/attempts/1) | main            | success        |                 1386 |       1556 | permanently: review timed out |
| [34531496667 a1](https://github.com/integral-xyz/fms-frontend/actions/runs/34531496667/attempts/1) | main+aux        | cancelled      |                  121 |        239 |                               |
| [k77k30fps5](https://depot.dev/orgs/sr28q68rf1/workflows/jdpl71pcfq)                               | main+aux        | failed         |                 1447 |       1506 | permanently: review timed out |
| [k77k30fps5](https://depot.dev/orgs/sr28q68rf1/workflows/jdpl71pcfq)                               | main+aux        | cancelled      |                  542 |        618 |                               |
| [00sjrwxjsh](https://depot.dev/orgs/sr28q68rf1/workflows/2jngfsd8xq)                               | aux             | cancelled      |                   61 |        124 |                               |

opencode's session status stays `retry attempt 1` for the whole window;
`waitForAssistantMessage` in `src/shared/opencode.ts` logs it as progress and
keeps polling until the finder timeout. Two Depot attempts and one GitHub
attempt therefore ran 25 minutes, posted nothing, and failed the job. When
the same route is only the auxiliary, its sessions stall until the grace
abandons them.

## 4. The 600 s interactions cap

| Attempt                                                                                            | Aux route                                     | Ran for s |               Main s | Context bytes |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------: | -------------------: | ------------: |
| [1p5s3s3g6g](https://depot.dev/orgs/sr28q68rf1/workflows/1kw9msmtc3)                               | `commandcode/z-ai/glm-5.3-flash`              |       600 | — (main also failed) |        454990 |
| [9jvx47rsbk](https://depot.dev/orgs/sr28q68rf1/workflows/3jrk6v8p77)                               | `commandcode/deepseek/deepseek-v4.1-flash`    |       600 |                  289 |             — |
| [k77k30fps5](https://depot.dev/orgs/sr28q68rf1/workflows/jdpl71pcfq)                               | `opencode/muse-spark-1.3-contributor-free`    |       588 | — (main also failed) |             — |
| [34482201625 a3](https://github.com/integral-xyz/fms-frontend/actions/runs/34482201625/attempts/3) | `commandcode/deepseek/deepseek-v4-flash-fast` |       600 |                  471 |        205575 |

In three of four cases the grace would have expired within seconds of the cap
anyway. Only the 471 s main case lost time the grace would still have allowed.
The cap is a minor contributor.

## Other observations

- fms-frontend had an `Invalid API key` window on 2026-09-11 13:01–13:51 UTC:
  every OpenCode-routed session failed in 4–22 s until reruns rotated the pool
  onto CommandCode ([34602002974](https://github.com/integral-xyz/fms-frontend/actions/runs/34602002974) took four attempts).
  Auth failures are non-retryable and should not consume an attempt per pool
  entry.
- 21 attempts were cancelled mid-review by the per-PR concurrency
  group (a new push). Their auxiliary sessions show as failed in telemetry but
  are not timeouts.
- `gpt-5.6-luna` as main completes in a median 12 s with ~650 output tokens.
  That is fast enough to make mechanism 1 near-certain for any slow auxiliary
  route, and it is worth checking separately whether such a pass is doing a
  real review.

## Current pool exposure

The pool in the most recent attempts of both consumers:

`opencode/muse-spark-1.3-contributor-free, opencode-go/muse-spark-1.3-contributor, opencode-go/deepseek-flash, commandcode/deepseek/deepseek-v4-flash-fast, commandcode/gpt-5.6-luna, commandcode/deepseek/deepseek-v4.1-flash, cline/cline-free/muse-spark-1.3-contributor, devin/swe-2-medium, devin/swe-2-medium`

Of these, `opencode-go/deepseek-flash` (42% auxiliary non-completion, all grace),
`commandcode/deepseek/deepseek-v4.1-flash` (26%), and the free OpenCode route
(stalls) are the routes that will keep producing incomplete auxiliary passes
under the current deadline model.

Auxiliary non-completion by route, finished attempts only:

| Aux route                                     | Sessions | Not completed | Breakdown                                                                 |
| --------------------------------------------- | -------: | ------------: | ------------------------------------------------------------------------- |
| `commandcode/meta/muse-spark-1.3-contributor` |       30 |     30 (100%) | 24 CLI exit 9 (no response), 6 CLI exit 7 (API error)                     |
| `opencode-go/deepseek-flash`                  |       36 |      15 (42%) | 10 cut off by grace, 5 provider error                                     |
| `commandcode/z-ai/glm-5.3-flash`              |       15 |       5 (33%) | 4 cut off by grace, 1 600s cap                                            |
| `commandcode/deepseek/deepseek-v4.1-flash`    |       34 |       9 (26%) | 4 cut off by grace, 3 unknown model, 1 600s cap, 1 CLI exit 7 (API error) |
| `opencode/muse-spark-1.3-contributor-free`    |       34 |       5 (15%) | 4 provider error, 1 cut off by grace                                      |
| `commandcode/gpt-5.6-luna`                    |       39 |       5 (13%) | 5 CLI exit 7 (API error)                                                  |
| `commandcode/deepseek/deepseek-v4-flash-fast` |       38 |        1 (3%) | 1 600s cap                                                                |
| `devin/swe-2-medium`                          |       37 |        0 (0%) | —                                                                         |
| `cline/cline-free/muse-spark-1.3-contributor` |       33 |        0 (0%) | —                                                                         |
| `opencode-go/muse-spark-1.3-contributor`      |       37 |        0 (0%) | —                                                                         |
| `opencode-go/omen-alpha`                      |        3 |        0 (0%) | —                                                                         |

By session label:

| Label                       | Sessions | Not completed | Grace | 600 s cap | CLI fast-fail | Provider error |
| --------------------------- | -------: | ------------: | ----: | --------: | ------------: | -------------: |
| `review-interactions`       |       88 |      27 (31%) |    11 |         3 |            11 |              2 |
| `review-frontend`           |       30 |       8 (27%) |     2 |         0 |             5 |              1 |
| `guideline-compliance`      |       87 |      17 (20%) |     5 |         0 |            10 |              2 |
| `addressed-prior-comments`  |       61 |      10 (16%) |     1 |         0 |             7 |              2 |
| `changes-since-last-review` |       70 |       8 (11%) |     0 |         0 |             6 |              2 |

## Options

Implemented on this branch: the runway floor from option 1 (grace =
`max(300 s, 600 s − aux runtime)`), the non-retryable no-response class from
option 3, and the footer reasons from option 4. Route changes and the
quota/auth fail-fast stay separate.

1. **Give auxiliary sessions a deadline of their own.** The grace should not
   be the only clock: a floor measured from the auxiliary session's own start
   (bounded by the run deadline), or a per-route runway, would let a 6-minute
   lens finish after a 12-second main. The trade is tail latency; the 14
   grace attempts already pay 345–450 s of tail and get nothing for it.
   Alternatively shrink the work: the interactions lens emits 10–37 K output
   tokens on CommandCode flash models.
2. **Fail fast on quota and auth states.** Treat `Free usage exceeded`,
   `Rate limit exceeded`, and `Invalid API key` (401, `isRetryable: false`)
   as terminal after a short bound instead of polling to 1470 s, and let the
   pool skip the route within the run rather than per workflow attempt.
3. **Route health in the pool.** `commandcode/meta/muse-spark-1.3-contributor`
   is already out; `deepseek-v4.1-flash` on CommandCode and `deepseek-flash`
   on OpenCode Go are the remaining high-failure auxiliary routes. A retry
   that reuses a model that just returned exit 9 or `unknown model` is wasted.
4. **Name the cutoff in the footer and telemetry.** "Did not complete" hides
   four causes; coverage rows already carry `aborted-after-grace` vs
   `timeout`, so the posted footer could say which.
5. The 600 s interactions cap can stay or go; the data does not justify
   touching it before 1–3.

Any change to 1–3 alters model inputs or finding disposition and falls under
the review-quality gate in AGENTS.md.

## Limits

Two days, two consumers, one 30-minute budget and one concurrency setting.
No precision or recall was measured; "completed" means the session returned
parseable output, not that its findings were good. CommandCode and Devin
sessions are opaque in telemetry, so tool activity inside the slow CommandCode
lenses is inferred from output token volume. Depot has no telemetry artifacts;
its numbers come from log timestamps at one-second resolution.

Raw inputs (attempt logs, telemetry artifacts, parsed `attempts.json`) are in
the session scratchpad and were not committed.
