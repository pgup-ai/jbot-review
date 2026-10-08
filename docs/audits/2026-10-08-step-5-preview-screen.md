# Step 5 Preview as a review model

_2026-10-08_

Step 5 Preview reviews small pull requests about as well as DeepSeek V4.1 Flash,
and it costs nothing this week. It takes roughly twice as long, and it could not
finish either of the two large PRs we gave it. We would use it on small and
medium PRs while the free window lasts. We would not put it in a default model
pool.

## Getting it running

OpenCode Zen serves the model as `opencode/step-5-preview-free`, free for a
week from 2026-10-08. The models.dev entry lists a 1M-token context, image and
video input, and a 65,536-token output limit.

J-Bot needs no OpenCode bump. The pinned `@opencode/cli@2.0.24` ships no catalog
entry for this model, but the server reads models.dev when it starts, so session
readiness passed on the first try. Set `MODEL=opencode/step-5-preview-free` and
`OPENCODE_API_KEY`.

## What we ran

Every run used local mode (`npm run review:local`) at `0906459`, once per PR,
with verification off and 10 concurrent sessions.

We started with jbot-review #286, a 9-file PR that fits on one review page. We
used effort low there, because that is how we had measured DeepSeek V4.1 Flash
on the same PR the day before.

Then we ran eight PRs from a private production TypeScript monorepo. An
earlier audit gave each one an answer key, 44 known issues in total. These runs
used effort high, one pass and a 30-minute budget, two reviews at a time. A
script matched posted findings to the key by keyword. We then read every finding
the script did not match and credited three more by hand.

## Results

| PR   | Files | Pages | Wall time                  | Known issues found          |
| ---- | ----: | ----: | -------------------------- | --------------------------- |
| #286 |     9 |     1 | 8.2 min (DeepSeek 4.4 min) | the real bug DeepSeek found |
| A    |     4 |     2 | 17.7 min                   | 3 of 7                      |
| B    |     8 |     1 | 10.0 min                   | 1 of 5                      |
| C    |     8 |     1 | 14.6 min                   | 1 of 3                      |
| D    |     9 |     3 | 13.5 min                   | 2 of 8                      |
| E    |    10 |     2 | 19.8 min                   | 0 of 2                      |
| F    |    13 |     2 | 19.8 min                   | 1 of 6                      |
| G    |    20 |     3 | failed at 29.5 min         | none posted (3 in the key)  |
| H    |    32 |     4 | failed at 28.1 min         | none posted (10 in the key) |

Step 5 found 8 of the 31 known issues on the six PRs it finished. On A and B it
found 4, the same count DeepSeek V4.1 Flash reached on 2026-09-26. That DeepSeek
run used older J-Bot code, so treat the tie as a rough match.

On #286 both models found the same real bug. A telemetry helper gained a
workspace parameter that three backends never pass. Step 5 also traced a side
effect in the shell-read classifier that DeepSeek did not mention.

The median review took 16 minutes, about 1.5 to 2 times DeepSeek. B was the
exception, at 10.0 minutes against DeepSeek's 12.0.

## The large PRs failed

Both failures came from a single page. On G, one page returned an empty
response and its retry ran past the budget. On H, one page stopped with a
partial result. J-Bot refuses to post a review that skips part of the diff, so
one stuck page fails the whole run.

This is the deciding result. A model that works on 13 files and stalls on 20
cannot be a default for repositories that open large PRs.

## Recommendation

Use Step 5 Preview for PRs up to about 13 files while it is free. Keep it out
of the default pool. Before it gets a pool slot, it needs a time budget of at
least 45 minutes and a repeat run on the two large PRs.

## Limits

Each PR ran once. Flash-class models swing by about two known issues between
identical runs, so a single row can mislead. We did not pair DeepSeek on C
through H, and the A and B comparison crosses a code change. The review-quality
corpus did not run, and no defaults changed.
