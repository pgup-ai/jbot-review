# Golden review set

Regression harness for review quality: PRs with labeled expected findings.
Run `npm run eval` to score; CI can gate prompt/pipeline changes on it
(exit 1 when any `mustFind` finding is missed).

## Case layout

```
fixtures/golden/<case-name>/
  expected-findings.json   # labels (committed)
  actual-findings.json     # one run's findings (gitignored — produce per
                           # evaluation; a committed actual would make the
                           # gate trivially green forever)
```

`expected-findings.json`:

```json
{
  "exhaustive": false,
  "findings": [
    {
      "path": "apps/core/src/x.ts",
      "lineStart": 50,
      "lineEnd": 70,
      "category": "data-integrity",
      "mustFind": true,
      "description": "ASCII-only normalization drops non-Latin duplicate names",
      "keywords": ["non-latin", "ascii", "unicode", "cjk"]
    }
  ]
}
```

- `mustFind: true` findings count toward recall; label competitor catches and
  human-confirmed bugs this way. `mustFind: false` marks nice-to-haves.
- `exhaustive: true` means the labels are complete, so every unmatched actual
  finding counts as noise/precision loss — use it for clean PRs and fully
  labeled cases.
- Matching is fuzzy: same path, line within ±5 of the labeled range
  (file-level findings match any line), and at least one keyword in the
  finding title+body when keywords are given.

`actual-findings.json` is an array of the reviewer's findings
(`{path, line, severity, title, body}`). Produce it from a dry run
(`dry-run: true` logs every finding) or a replay against the case's PR, then
score the whole set:

```
npm run eval                 # fixtures/golden
npm run eval -- path/to/set  # alternate root
```

## Seeding the set

Grow this set from real failures — every production miss (a competitor bot or
human catches what jbot didn't) becomes a case. Seed cases to add:

- `fms-3064` — Python tool gated off at turn start, breaking the unchanged
  deferred-exposure path (Bugbot catch; category `logic`,
  cross-hunk interaction).
- `fms-3055` — three Claude catches: subagent provider options not threaded
  (`contract`), duplicate groups beyond 200 unretrievable (`data-integrity`),
  ASCII-only normalization (`data-integrity`); plus jbot's own 10K-scan-cap
  finding as a regression guard.
- Two or three clean PRs with `"exhaustive": true, "findings": []` to measure
  noise.

Because flash-tier models are high-variance, compare configurations across
~3 runs per case, not single runs.
