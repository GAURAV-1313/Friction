# lc-research

Tooling for calibrating the Anchor tutor's habit-detection rules against a real LeetCode account.
Nothing here touches the Friction product or its database.

## 1. Export an account (run on the account owner's machine)

Needs Node 18 or newer, nothing else. Copy `extract.js` to the machine, then:

```bash
LEETCODE_COOKIE="LEETCODE_SESSION=<value>; csrftoken=<value>" node extract.js --check
```

`--check` only verifies the login and prints how many problems it sees. Then run the real export:

```bash
LEETCODE_COOKIE="LEETCODE_SESSION=<value>; csrftoken=<value>" node extract.js
```

Getting the two cookie values in Chrome: open leetcode.com while logged in, press F12, open the
Application tab, then Storage, then Cookies, then `https://leetcode.com`, and copy the Value column
for `LEETCODE_SESSION` and `csrftoken`. The cookie never gets written to disk or printed.

It creates a folder `lc-export-<username>-<date>/`. Zip that folder and send it. If the run stops
(rate limit, network, closed laptop), run the same command again with `--resume`.

Time: about one request per second. An account with ~600 solved problems and ~1500 submissions
takes roughly 30 to 45 minutes. Use `--families dp,graph` to only download per-submission details
for dynamic-programming and graph problems, which cuts that to under 15 minutes.

## 2. What the export contains

| file | contents |
|---|---|
| `whoami.json`, `profile.json` | username, per-tag solved counts, accepted/failed counts per difficulty |
| `solved.json`, `attempted.json` | every solved / attempted-but-unsolved problem with tags and difficulty |
| `submissions.json` | every submission: verdict, language, timestamp, and the submitted code |
| `problems/<slug>.json` | tags, similar questions, official hints, statement |
| `details/<id>.json` | judge details per submission: failing test, expected vs actual output, runtime error, runtime percentile |
| `manifest.json` | counts and settings |

It contains the account owner's own source code. Keep it out of git (the folder is ignored).

## 3. Analyze an export (run here)

```bash
node analyze.js <export-dir> --seed subpatterns.json
```

Writes `<export-dir>/analysis/`: per-problem attempt sequences with verdict buckets, per-family and
per-sub-pattern aggregates, the same self-relative gap computed against four competing baselines
(lifetime, last 90 days, last 100 problems, difficulty-matched), the habit candidates the design's
v0 thresholds would fire, anchor coverage under each eligibility rule, a `labeling_sample.json`
of failed submissions with code and the next attempt, and `report.md`.

`make_fixture.js` builds a synthetic export with a planted habit to exercise the pipeline.
`verify_seed.js` checks a drafted sub-pattern seed against LeetCode and writes `subpatterns.json`.

## 4. Labeling (no LLM API key needed)

The bug-locus labeling of `labeling_sample.json` is done by Claude agents in this repo's session,
each reading one failed submission, its judge output, and the next attempt, and deciding where the
bug really was. Their labels are compared against the rule-based `bucket` to measure precision.

Labeling run (from the repo, after analyze.js):

```bash
# 1. launch the labeling workflow with args.items = contents of <export>/analysis/labeling_index.json
# 2. save the workflow result to <export>/analysis/labels.json
node lc-research/score_labels.js <export>/analysis/labels.json <export>/analysis/label_scores.json
```

## 5. Corpus artifacts

- `subpatterns.json`: 30 structural sub-patterns (16 DP, 14 graph), 535 distinct problems, every slug verified
  live against LeetCode, hand-pruned. Each slug has exactly one primary sub-pattern. `subpatterns.verified_raw.json`
  is the pre-pruning version; `seed_draft.json` is the raw agent draft.
- `catalog.json` (from `fetch_catalog.js`, public, no login): the entire LeetCode catalogue with tags, difficulty,
  paid flag and acceptance rate. LeetCode now ships fine-grained algorithm tags (`dijkstra`, `0-1-knapsack`,
  `complete-knapsack`, `dp-on-trees`, `longest-increasing-subsequence`, `tarjans-scc-algorithm`, `0-1-bfs`, ...),
  which the analyzer uses as a fourth anchor-eligibility rule alongside the seed, similar-questions links, and
  specific-tag overlap.
