# Recall

**A LeetCode tutor that refuses to give you the answer.**

Recall reads your own LeetCode submission history once, builds a deterministic model of what
you know from it, and then — while you sit on a problem page — hands you hints anchored to
problems *you personally already solved*.

It is a second, self-contained product inside the Friction repo. It shares Friction's database,
its auth, and its `node_modules`, and changes none of them. See
[Separation from Friction](#separation-from-friction).

> This document is the system-level guide: what Recall is, how data moves through it, why it is
> built this way, and how to run it. Two narrower references already exist and are not repeated
> here:
> [`extension-leetcode/README.md`](extension-leetcode/README.md) (file-by-file inventory, load-unpacked steps)
> and [`backend/src/lc/README.md`](backend/src/lc/README.md) (module contracts and wire names).

---

## Contents

- [What makes it different](#what-makes-it-different)
- [The three pieces](#the-three-pieces)
- [Architecture](#architecture)
- [Separation from Friction](#separation-from-friction)
- [How a student's history becomes a hint](#how-a-students-history-becomes-a-hint)
- [The student model](#the-student-model)
- [The hint ladder, the guard, and the model](#the-hint-ladder-the-guard-and-the-model)
- [Database](#database)
- [Inside the extension](#inside-the-extension)
- [API surface](#api-surface)
- [Running it](#running-it)
- [Deployment](#deployment)
- [Operations](#operations)
- [Privacy and data handling](#privacy-and-data-handling)
- [Known gaps](#known-gaps)

---

## What makes it different

Three things, and all three are structural rather than prompt-level.

**1. The hint cites your own work.** `domain/anchors.js` scores the problems you have actually
solved against the one in front of you and returns up to three, each with a `why`. So instead of
"think about dynamic programming", you get *"In Longest Palindromic Subsequence you decided what
one stored value stood for before writing any transition. What should one state mean here?"* —
where you really did solve Longest Palindromic Subsequence, on a date Recall can name.

**2. Depth is earned, not requested.** `decideRung` is a pure function of stored facts and never
reads your message. Rung 1 until you state a plan; rung 2 until you have submitted; rung 3 after
one submission or three turns; rung 4 — blanked pseudocode — only when you have submitted twice
and explicitly ask. A failed submission in the last 30 minutes raises the *floor* to diagnostic
depth on its own.

**3. The model is not trusted with the output.** Every reply passes a deterministic guard that
strips code below rung 4, drops citations of problems that were not offered, rejects technique
names at rung 1, deletes "that's the only bug"-style claims, and enforces a per-rung word cap.
A violation buys exactly one silent re-ask; a second failure falls back to a template.

The first of these is the product. The second and third are what stop it becoming a solution
vending machine.

---

## The three pieces

| Piece | Path | What it is |
|---|---|---|
| Extension | `extension-leetcode/` | Manifest V3, Chrome 116+, active only on `https://leetcode.com/problems/*`. 12 JS files + side panel + popup. |
| Backend | `backend/src/lc/` | A standalone Express app, 52 JS files, entrypoint `node src/lc/index.js`, default port 4100. |
| Schema | `db/012_lc_init.sql` | One additive migration: 11 `lc_`-prefixed tables in the database Friction already uses. |

Tests live in `backend/tests/lc/` — 23 suites, 684 tests, run with `npx jest tests/lc`.

---

## Architecture

```
  leetcode.com page (site origin)          chrome-extension:// origin
  ─────────────────────────────────        ──────────────────────────────────
  MAIN world                               background.js  (service worker)
    lc-main.js                               · message router
      · fetch + XHR interceptor              · per-tab ctx (storage.session)
      · Monaco / CodeMirror reader           · durable POST queue + 1/min alarm
          ▲                                  · /health cache · badge
          │ postMessage (nonce-guarded)                    │
          ▼                                                │
  ISOLATED world                           sidepanel.js    │  popup.js
    config.js                                · view state machine
    lc-queries.js   GraphQL documents        · sync driver
    lc-client.js    paced LeetCode client    · chat + motion
    lc-sync.js      first-run sync engine            │
    lc-content.js   bridge + handlers ──Port─────────┘
          │                                                │
          │ GraphQL + REST                                 │ fetchWithAuth
          ▼                                                ▼  (Bearer JWT)
    leetcode.com                              backend/src/lc  (:4100)
                                                       │
                                     ┌─────────────────┴─────────────────┐
                                     │ routes → services → domain (pure) │
                                     └─────────────────┬─────────────────┘
                                                       ▼
                                              MySQL (shared with Friction)
```

**The rule that shapes everything:** code running in a `leetcode.com` page never calls the
Recall backend, and extension pages never call `leetcode.com`. `recall-setup.js` — which holds
the token and `fetchWithAuth` — is loaded only by `background.js`, `popup.html` and
`sidepanel.html`, and is deliberately absent from the content-script list. The JWT therefore
never enters a page the site controls.

### The request path for one hint

```
POST /api/lc/chat
  → cors + rejectDisallowedOrigin      403 origin_not_allowed
  → requestLogger                      (JSON line; never prompts, replies, code or tokens)
  → express.json({limit:'256kb'})      413 payload_too_large
  → requireAuth        (Friction's)    401 missing_token / invalid_token
  → pilot allowlist                    403 pilot_closed
  → versionGate (X-Recall-Version)     426 update_required
  → chat limiter (20/min per user)      429 chat_rate_limited
  → chatService.handleChat
      · incrementHintsAtomic            429 daily_cap      (before the LLM call)
      · contextBuilder.buildChatContext 409 not_synced / problem_not_cached
                                        403 contest_mode
      · decideRung → contract
      · promptBuilder.buildPrompt
      · llm.generate  (15s, 1 retry)
      · guardReply    (accept | retry once | fallback)
      · persist message + contract + guard + usage
```

---

## Separation from Friction

Friction (`backend/src/app.js`, `extension/`, `web/`) is a different product in the same repo.
Recall reuses exactly four things from it, all by `require`, all unmodified:

| Friction module | Used for |
|---|---|
| `backend/src/db/pool.js` | `getDbPool()` / `waitForDb()` — the same MySQL pool and `DB_*` config |
| `backend/src/db/transaction.js` | `withTransaction(pool, fn)` for multi-statement writes |
| `backend/src/middleware/auth.js` | `requireAuth` → `req.auth.user_id` |
| `backend/package.json` | the version string in `/health` |

**Auth is Friction's, entirely.** `requireAuth` verifies the same JWT the Friction web app
already issues. Recall has no login, no user table, and no `/auth` surface of its own: the
student signs into the Friction web app, clicks its existing Connect button to copy the token,
and pastes it into the Recall popup. `req.auth.user_id` is the only identity Recall ever uses,
and every `lc_` table foreign-keys to `users(user_id) ON DELETE CASCADE`.

**What Recall refuses to call is `createApp()`**, and the reason is concrete:
`backend/src/app.js` calls `startDailySnapshotScheduler()`, which registers
`cron.schedule('30 23 * * *', …)` — a nightly job that sweeps `buffer_moments` and runs
Friction's snapshot pipeline for every user with pending rows. Booting Recall through Friction's
factory would mean every Recall instance also runs Friction's nightly batch. So `createLcApp()`
builds its own bare `express()` and `src/lc/index.js` is its own entrypoint.

The same discipline applies downward. Recall builds **fresh** rate limiters rather than importing
Friction's; it repeats the CORS origin rule so a rejected origin gets a clean `403` instead of
Friction's `500`; and it mounts `express.json` per route instead of globally, so each route
carries its own body cap.

The schema is additive only: eleven new `CREATE TABLE IF NOT EXISTS` statements, no `ALTER`, no
`DROP`, no writes to anything Friction owns.

---

## How a student's history becomes a hint

LeetCode has no export. So Recall reads the history from inside the student's own logged-in
browser session, one paced request at a time, ships it to the backend, and turns it into a small
model that is re-derived on every new verdict.

Three lanes own three different things, and the boundary is enforced by which globals each file
may touch:

| Lane | Files | May talk to | May not |
|---|---|---|---|
| MAIN world | `lc-main.js` | the page (`window.fetch`, `XMLHttpRequest`, Monaco) | any `chrome.*` API |
| ISOLATED world | `lc-queries.js`, `lc-client.js`, `lc-sync.js`, `lc-content.js` | leetcode.com GraphQL + REST, `chrome.runtime` | the Recall backend |
| Extension pages | `sidepanel.js`, `popup.js`, `background.js` | the Recall backend | leetcode.com |

### 1. First-run sync

The sync **engine** is `lc-sync.js`, in the page's ISOLATED world. The sync **driver** is the
side panel. They speak over a `chrome.runtime` Port named `recall-sync`: the engine fetches from
LeetCode and emits pages, the panel POSTs each page to `/api/lc/sync`, and only then sends back
an `ack`. **The durable cursor in `chrome.storage.local.syncState` advances only on ack**, so a
crash between fetch and store costs at most the unacked pages, never data.

Engine phases, by their exact names in `setPhase`:

| Phase | Calls | Shape |
|---|---|---|
| `whoami` | `globalData` | 1 request; aborts `lc_logged_out` if not signed in |
| `solved` | `problemsetQuestionListV2` (falls back to V1 on GraphQL error) | 100 rows/page, `skip` cap 20000 |
| `skills` | `skillStats` + `userProfileUserQuestionProgressV2` | 1 each; failure is a warning, not an error |
| `sweep` | `GET /api/submissions/?offset=&limit=20&lastkey=` | 20 rows/page, newest first |
| `details` | `submissionDetails` per failed id | 1 request per id, 20 per emitted page |
| `final` → `done` | — | emits `recentAc`, counts, `backlogCount` |

Everything is serialised through **one promise chain at one request per second**
(`LC_RATE_MS: 1000`), and by default each turn also waits for the tab to be visible before
firing (callers can opt out with `waitVisible: false`). 429s and 5xx back off exponentially from
2s, capped at 60s, honouring `Retry-After` up to 120s, for at most 6 consecutive attempts. An
HTML body where JSON was expected is treated as a bot challenge and pauses the sync.

Note that `lc-client.js` reaches **two** same-origin LeetCode endpoints through its single
`fetch`: `/graphql/` for the GraphQL documents, and `/api/submissions/` for the REST sweep.

Request count is predictable arithmetic over those page sizes. For an account with 600 solved,
2,500 submissions and more than 300 failures: `1 + 6 + 2 + 125 + 300 ≈ 434` requests ≈ 7¼
minutes at 1 req/s. **That is arithmetic, not a measurement** — no benchmark exists in the repo;
prefer a real `sync_done` client event if you have one. The details phase is the expensive half
and the only capped one (`DETAILS_CAP_DEFAULT: 300`): ids beyond the cap are recorded as a
`backlog` and never fetched.

Back-pressure: the engine may run at most `SYNC_LOOKAHEAD_PAGES: 20` pages ahead of the last
ack. The one exception is the header — the solved list must be stored before any submission
page, because the backend needs it first.

The panel translates engine phases into the backend's three, which are named differently
(`solved | submissions | finalize`), re-chunking to `CHUNK_SUBS: 200` rows per POST. Failed POSTs
retry on `[2s, 4s, 8s, 16s, 30s]`; a 429 waits 15s without burning a retry; 401/403/409/426/503
stop the sync with a specific message.

**Stored vs discarded.** Kept per submission: id, slug, status code and message, derived
`verdict_bucket`, lang, timestamp, and — only from `details` rows — `runtime_percentile`,
`last_testcase`, `expected_output`, `code_output`, `error_text`, `total_correct`,
`total_testcases`, each clamped to 8000 chars. Code is stored **only** if `consent_code` is set,
and the extension already stripped it at two earlier points when consent is off. Discarded:
`runtime`, `memory`, `memoryPercentile`, `notes`, `topicTags`. Writes are idempotent by
construction — `upsertMany` is a fill-if-null upsert, so re-sending changes nothing and arriving
details upgrade a placeholder bucket without ever downgrading one.

**Resume** works at three levels: within a run from `syncState.sweep.cursor` / `details.index`;
across tabs via a 10s owner heartbeat with a 30s staleness window, so a second tab refuses to
sync; and for incremental re-syncs the panel reads `counts.max_lc_submission_id` from
`GET /api/lc/me` and passes it as `since_id`, ending the sweep at the first old page.

### 2. Live verdict capture

Once synced, history stays current because Recall watches submissions as they happen.
`lc-main.js` wraps `window.fetch`, `XMLHttpRequest.prototype.open` and `.send` at
`document_start`.

`classify(method, url)` is the entire discriminator, and it is narrow on purpose:

- a **real submission** is `POST /problems/<slug>/submit/`. The response's `submission_id` opens
  a pending record holding slug, `question_id`, `lang` and `typed_code`, with a 90s timeout.
- the **verdict** is `GET /submissions/detail/<digits>/v2/check/` (or the v1 form). The path id
  must be numeric.
- **Run Code never matches either.** It is `POST /problems/<slug>/interpret_solution/` polled at
  `/submissions/detail/runcode_<id>/check/` — the POST fails the submit regex and the
  non-numeric `runcode_*` id fails `(\d+)`.

Only a check whose `state` is `SUCCESS` or `FAILURE` is emitted; `PENDING` polls are ignored. A
check with no matching pending record (page reloaded mid-judge) still emits, flagged
`orphan: true`, with the slug taken from the URL.

Dedupe is layered, because each layer can lose the one above it:

| Layer | Mechanism |
|---|---|
| page | an `emitted` Set of submission ids |
| page, across reloads | `localStorage.recall_pending_events`, cap 20, entry removed only on `ack` |
| content script | a `seenEvents` Set of `eventId` |
| backend | fill-if-null upsert; the response carries `already_known` |

**On contest pages nothing is captured at all** — `classify` returns `null` for `/contest/api/`
and for any contest page (`/contest/…` or `?envType=contest`), and the panel renders a
`CONTEST_LOCKED` view. Worth knowing: the backend's own contest lock is driven by
`body.is_contest`, and the panel always sends `false` — so the contest guarantee is enforced by
not capturing and not rendering, not by the server.

### 3. Recompute

`modelService.recomputeStudentModel` is the only thing that writes the student model, and it has
exactly two call sites: sync `finalize`, and every recorded attempt. Both run synchronously
inside the request — no cron, no queue, no background job. `now` is passed in explicitly so the
result is deterministic.

It reads everything and recomputes from scratch:

1. **Load** all submission metadata plus all `lc_solved` rows. Problem metadata resolves per
   field with precedence *sync's solved row > cached `lc_problems` > shipped catalog*.
2. **Code, almost never.** The only code the model reads is the `(TLE, first AC)` pairs less
   than 300s apart, used solely to set the `quick_after_tle` flag.
3. **Attempts** — collapse submissions into one record per problem.
4. **Pseudo-attempts** — a problem on the solved list with no stored AC still counts as solved
   and gets a synthetic record, so a capped or truncated sync never silently shrinks the map.
5. **Skill summary**, **habits** (see below).
6. **Write in one transaction**: `skill_summary` + `model_version`, the `lc_solved` computed
   columns, habit upserts that *preserve* a student's `confirmed`/`dismissed` state, a
   `markStaleExcept` to retire keys that no longer compute, and one `lc_skill_events` row.

`recordAttempt` does a little more around it: it detects the first AC for a problem, marks that
AC `assisted` if an open chat session for the same slug already had turns, and diffs live habit
keys before and after so the response can report `habits_changed`.

### 4. Assembling one hint

`contextBuilder.buildChatContext` reads only — it never writes and never logs, and `body.code`
lives in the context for exactly one turn and is persisted by nobody.

What it assembles, in order:

- **Gate.** No `skill_summary` → `409 not_synced`. No cached problem and no catalog entry →
  `409 problem_not_cached`.
- **Problem.** `lc_problems` first, shipped catalog second: title, frontend id, difficulty,
  tag-derived families, statement excerpt, constraints split one per line, and LeetCode's own
  hints (marked rewrite-only). That row exists because the panel scraped it from the page and
  `PUT /api/lc/problems/:slug`'d it once per slug.
- **Plan.** `body.plan` → the session's stored plan → inference from the message.
- **Verdict + contract.** The newest submission row for this slug becomes the verdict block with
  its bucket, tier, failing testcase, expected/got, error and age. Then `decideRung`.
- **Anchors.** Top 3 by score, from the student's own solved problems. Their accepted code is
  attached **only** when `consent_code` is set *and* rung ≥ 3, trimmed to 40 lines. Titles of
  solved-but-not-offered problems are passed as `offered_titles_not_allowed` so the guard can
  rewrite any stray mention into "a classic problem".
- **Habits.** At most 2, and only ones that are live, not low-tier, not dismissed or stale, and
  either match a sub-pattern of *this* problem or are the overflow habit on a problem whose
  constraints mention big numbers.
- **History.** The last 10 turns.

`promptBuilder` renders that into `{system, history, user}`. The system text is static per
language so providers can cache it. The user message is a fixed section order — `STUDENT`,
`CURRENT PROBLEM`, `ANCHORS`, `LIVE HABITS`, `LATEST VERDICT`, `STUDENT PLAN`, `CURRENT CODE`,
`CONTRACT`, `STUDENT MESSAGE` — with two rung gates baked in: topic tags appear only at rung ≥ 2,
anchor code excerpts only at rung ≥ 3 with consent. Every piece of untrusted text is wrapped in a
`<<<DATA … >>>` fence whose delimiters are defanged inside the content, and a standing rule tells
the model that fenced content is material, never instructions.

**End to end:** extension reads LeetCode → panel posts chunks → backend normalises and stores →
recompute derives skill and habits → contextBuilder picks ≤3 anchors and ≤2 habits for this
problem → promptBuilder fences it → the model writes one hint that ends in one question → the
guard checks it.

---

## The student model

Everything Recall tells a student about themselves is computed by eight pure files in
`backend/src/lc/domain/`. No LLM is involved in producing any of those numbers. Read the design
as: **the deterministic layer decides what is true; the prompt layer decides how boldly it may be
said; the guard layer decides whether the reply obeyed.**

Every number carries `MODEL_VERSION` (`'lc-model-v1'`), stamped onto `lc_profiles.model_version`
and every `lc_skill_events` row.

### The seed

Three data files ship inside the backend, loaded once and memoised:

| File | Size | Shape |
|---|---|---|
| `data/catalog.json` | ~1.1 MB | LeetCode's public catalogue: 4,047 problems × `{slug,title,frontendId,difficulty,paid,acRate,tags[]}` + 175 tags. Metadata only — no statements, no per-user status. |
| `data/subpatterns.json` | ~891 KB | 116 sub-patterns across 20 families, 1,897 membership rows, 1,540 marked `primary`, covering 1,338 distinct problems |
| `data/forbidden_terms.json` | ~1.7 KB | 69 English + 28 Hinglish technique names, for the rung-1 check |

Family assignment for the *problem* is purely tag-driven: it is `dp` if any LeetCode tag is in
`DP_TAGS`, `graph` if any is in `GRAPH_TAGS`, and it can be both. Sub-pattern families are a
separate, wider vocabulary — the original 16 `dp.*` and 14 `graph.*` plus 86 more across sliding
window, two pointers, binary search, prefix sums, stacks, heaps, greedy, backtracking, tries,
bit manipulation, math, trees, linked lists, matrices, design, hashing, range queries and
sorting.

The original 30 were verified live against leetcode.com. The 86 added later were drafted one
family per agent from the bundled catalogue and then re-read by an independent adversary
instructed to drop any membership whose solution does not actually use the stated mechanism —
it removed 102 of 1,178 (8.7%), including a `longest-common-prefix` filed under a prefix trie
("no trie is ever built") and a frequency-tally entry that was really set cardinality. So
`verified` on those rows means catalogue-consistent and adversary-reviewed, not live-checked.

A problem may be `primary` in two different families — `jump-game` is the main idea of both
`dp.1d_linear` and `greedy.reach_frontier` — but never twice within one family.

### Verdict buckets and precision tiers

`bucketOf(sub, det)` converts one submission into one bucket string, branching on status code
first and then on judge details. `10 → ac`, `14 → tle`, `12 → mle_state`, `20 → ce`. Runtime
errors (15) are resolved by regex over the error text — signed-overflow messages →
`re_overflow`, recursion/stack → `re_recursion`, index/range → `re_index`,
`KeyError`/`NoneType`/null-pointer → `re_null_memo`. Wrong answers (11) need details or stay
`wa_unknown`: an edge-shaped failing testcase → `wa_edge_empty`, an int32/1e9/int64 sentinel →
`wa_bounds_overflow`, a difference divisible by 1e9+7 → `wa_modulo`, else `wa_logic`.

A bucket is a claim about *where the bug is*, and that claim is only as good as its measured
precision. `BUCKET_TIERS` is the honesty mechanism:

| Tier | Buckets | What the tutor may say |
|---|---|---|
| high | `re_overflow`, `re_null_memo`, `tle` | may be stated as fact |
| medium | `wa_logic`, `wa_modulo`, `wa_edge_empty`, `re_index` | phrase as a question, or "it looks like" |
| low | `mle_state` | do not name this cause; at most a gentle question |

The tiers were assigned from precision measured on 86 double-rated real failures from one
account (provenance is recorded in a comment at `domain/constants.js:16`; the per-bucket numbers
live in a calibration report that is deliberately not in this repo). Every other bucket — `ac`,
`ce`, `ole`, `other`, `re_recursion`, `re_other`, `re_unknown`, `wa_unknown`, and notably
`wa_bounds_overflow` — has **no** tier, and an untiered verdict **defaults to `low`** when
rendered, so an unclassifiable failure is never spoken as fact.

> **Caveat worth knowing:** tier phrasing is *instructed* in the prompt, not mechanically
> enforced. `domain/guard.js` contains zero references to tiers. The guard enforces code-at-low-
> rung, forbidden terms, anchor citation, completion phrases and word caps — but whether the
> model obeyed "phrase as a question" is not checked.

### Attempts

`buildAttempts` folds raw submissions into the model's unit of analysis: **one record per
problem**, carrying `n_submissions`, `first_ac_ts`, `attempts_to_ac` (1-based index of the first
AC), `fails_before_ac`, `fail_buckets`, `time_to_ac_s`, `fragile_flags` and the full `sequence`.
Output is sorted by `first_ts` with a slug tie-break, so the array is stable under input
permutation.

`fragile_flags` is deliberately almost empty. Exactly one flag exists — `quick_after_tle` — and
it fires only when all four hold: the problem was solved after at least one failure; the
submission immediately before the AC was a TLE; the AC came under 300s later; and the two files
are more than 80% line-identical. It means "this AC probably wasn't a real fix".

The narrowness is a calibration result: an earlier design discounted ACs by runtime percentile,
and measurement found percentile to be noise — many low-percentile first-ACs were first-try
standard optimal code. Percentile is stored but never surfaced as a signal.

### Skill summary

Difficulty is weighted `easy 1 / medium 2 / hard 4`. `levelOf` maps a weighted count to `new`
(0 solved), `strong` (weight > 30 or ≥ 5 hard), `solid` (weight > 12 or ≥ 2 hard), else
`learning` — and grades every individual tag as well as both families.

The account **band** is coarser and counts problems, not weight: `beginner` below 30 solved;
`advanced` requires **both** ≥ 150 solved and ≥ 10 hard; everything else is `intermediate`.

`strengths` are the top 4 tags by weighted count with umbrella tags (`array`, `string`,
`dynamic-programming`, `graph`, …) excluded. `gaps` names `dp` or `graph` when that family is
`new` or `learning` — but **only for non-beginners**, because telling someone with 12 solves
they have a DP gap is noise, not a diagnosis.

`cold_start` is the model's admission of how much it knows: `'none'` at 0 solved, `'thin'` at
1–20, `'ok'` above 20. Check it before trusting any other field.

### Anchors

Eligibility runs in **three tiers, strongest first**. A candidate qualifies on the first one it
meets; unsolved problems, the target itself, and anything solved after `asOf` are excluded.

| Tier | Qualifies when | Reads as |
|---|---|---|
| `subpattern` | shares a verified seed sub-pattern | "same idea: interval DP" |
| `technique` | shares a technique tag | "shares LeetCode's monotonic-stack tag" |
| `topic` | shares two topic tags — or its only tag, for single-tag problems | "another array + hash-table problem you solved" |

The third tier exists so that **every** problem can be anchored. With only the first two, and
with the technique set holding nothing but DP and graph algorithm names, **84% of the catalogue
was structurally unanchorable**: a problem tagged `['array','hash-table']` could never match
anything, whatever the student had solved — and the panel then wrongly told them none of their
solved problems was related. `TECHNIQUE_TAGS` now spans every family (sliding window, binary
search, monotonic stack, prefix sum, trie, backtracking, segment tree, design, and the rest).

Then the score:

```
  3.0   shares at least one sub-pattern
+ 1.0   the shared sub-pattern is `primary` for BOTH problems
+ 2.0   shares at least one technique tag
+ 2.5   topic tier only, when neither of the above matched
+ 0.5   per shared non-umbrella tag
+ 0.5   solved within the last 180 days
+ 0.2   solved first try
- 0.5   difficulty gap of 2 (easy vs hard)
```

Sub-pattern and technique are **additive** — a candidate sharing both is strictly the better
analogy. **Tier outranks score in the ordering**, so a topic match can never displace a real
analogy by accumulating recency and tag overlap; score only orders within a tier. Top 3, ties
broken by recency then slug.

**Anything below `ANCHOR_MIN_SCORE = 3` is dropped**, so a topic anchor still has to earn its
last half point from recency or a shared specific tag. The response explains itself with
`omitted_reason` (`no_eligible` | `below_threshold`) rather than offering a weak anchor.

Measured on the real catalogue against a simulated history: **81% of all 4,047 problems anchor
for a student with 84 solved**, 91% at 300 solved. Because tier outranks score, raising or
lowering the topic base moves only the topic count — the sub-pattern and technique counts are
identical at every value tested.

**LeetCode's own `similarQuestions` never gates anchor selection.** It is stored but not used as
an eligibility signal, because calibration found its links cross sub-patterns often enough that
the resulting analogies mislead.

### Habits

`computeHabits` derives at most three shapes, all threshold-gated:

| Category | Fires when |
|---|---|
| `overflow` | ≥ 5 overflow-shaped failures **and** ≥ 8% of all failures |
| `gap:<subpattern>` | mean attempts-to-AC ≥ 1.5× the difficulty-matched baseline over ≥ 4 solves |
| `bucket:<subpattern>:<bucket>` | one failure bucket holds ≥ 60% of ≥ 5 failures |

The baseline is a **trailing window over the last `RECENT_N = 100` solved problems**, stratified
by difficulty — not a lifetime mean.

`live` is the same test restricted to the last `WINDOW_S = 180 days`. **A stale habit is never
injected into a prompt.** That window exists because calibration surfaced a real, threshold-
crossing weak spot that turned out to be 18 months old — true once, useless as a diagnosis now.

A student can mark a habit *confirmed* or *dismissed*, and recompute preserves that state.
`selectRelevantHabits` then caps the prompt at 2.

---

## The hint ladder, the guard, and the model

### The four rungs

| Rung | Allowed to say | Word cap | Code |
|---|---|---|---|
| 1 | The *shape* of the problem in everyday words, plus one leading question. No technique, algorithm or data-structure names. | 90 | none |
| 2 | Name the pattern family in plain words and map it onto **one** anchor — but only as far as the **state**: what `dp[i]` would stand for here. No transition, no recurrence. | 160 | none |
| 3 | Diagnostic. Using the real failing test, name the *class* of failing case or the place the reasoning breaks — never the fix. Any anchor must be phrased as a question about *this* problem. | 200 | none |
| 4 | One plain-text pseudocode block, ≤ 12 lines, with `___` where the student must fill in. | 260 | `blanked_pseudocode` |

Eleven standing rules sit above the ladder: one issue per reply, never the full solution, cite
only offered anchors and only by title, never quote LeetCode's own hints, never imply one change
finishes the problem, end with exactly one question, answer in JSON only.

### `decideRung`: the exact rules

A pure function of stored facts that **never reads the student's message text**. The ceiling
starts at 1 and only rises:

- `planStated` → `max = 2`, unlock reason `submit_once`
- `submissionsHere >= 1` **or** `turns >= 3` → `max = 3` (either alone suffices)
- `rung4Ready = submissionsHere >= 2 || turns >= 5` — readiness alone does **not** raise the
  ceiling. The student must also send `requestedRung === 4`. **Rung 4 is the one rung you have
  to ask for.**
- finally clamped by `LC_MAX_RUNG` (default 4)

The floor is the post-failure rule: if the newest submission for this slug failed less than
**1800 seconds** ago and has a bucket, then `floor = min(3, max)` and `diagnostic_focus` is set
to that bucket. A real failure drags the tutor to diagnostic depth on its own — but never above
what the ceiling already allows.

Resolution is two lines: `wanted = requestedRung || floor`, then
`rung = max(floor, min(wanted, max))`.

> **Because `wanted` falls back to `floor` and not to `max`, sending `requested_rung: null` pins
> every hint at rung 1 outside the 30-minute window.** The panel always sends a number and
> carries a comment saying so. Do not "simplify" it back to null.

`submissionsHere` counts **all** synced submissions for that slug, not just this session's.

### Plan inference

The panel used to have four plan chips. They are gone, so the student's own sentence is the plan
channel now. `inferPlan` accepts a message as a plan only when all of:

1. whitespace-collapsed length ≥ 20 characters,
2. ≥ 4 **distinct** words (it builds a Set, so "next next next next" fails),
3. it is not on a stoplist.

Precedence is `body.plan` → the session's stored `plan_text` → inference, and inference runs only
when the first two are absent. An inferred plan is persisted once, so a later thin message
("and then?") cannot re-lock rung 2 mid-conversation. Whether a plan came from the body, the
session or inference is logged as `plan_source` — the only way to tell if inference is being
gamed.

Three stoplists guard it. Two are anchored regexes over English and Hinglish ("help", "hint",
"stuck", "idk", "kuch samajh nahi aa raha"). The third, `PLAN_STOP_EXACT`, is the sharp one: it
holds **the literal sentences the panel's own affordance buttons send on the student's behalf**
— so a tap can never buy a free rung.

### The guard

`guardReply` is deterministic and pure: no clock, no randomness, no I/O beyond a static term
list. Rules run **in order** on an evolving copy of the reply, and each violation carries its own
action — `fix` (rewrite silently), `retry` (re-ask once), or `flag`.

1. **schema** — failure short-circuits everything; retry on pass 1, `fallback` on pass 2. This is
   the only route to fallback.
2. **rung mismatch** — the model's `rung` is overwritten with the contract's.
3. **anchors** — unoffered slugs dropped; solved-but-not-offered titles rewritten to "a classic
   problem".
4. **habits** — intersected with the offered keys.
5. **rung ≤ 3: no code** — fenced blocks, stray fences and inline spans stripped. A single
   backticked identifier survives; anything over one line or 40 chars also raises a retry.
6. **rung 4: one fence only** — ≤ 12 lines and must contain at least one `___`.
7. **rung 1: forbidden technique names** — word-boundary scan against `forbidden_terms.json`.
8. **verbatim LeetCode hint** — an 8-word sliding window over each official hint.
9. **rung 2 transition leak** — `dp[...] =`, `= min(`, "relax", "recurrence is", "heap lagao".
10. **rung 3 anchor-as-statement** — a sentence with both an anchor title and a directive
    ("so here", "do the same").
11. **completion phrases** — "that's the only bug" deleted and replaced with a re-run line.
12. **ends with exactly one question.**
13. **question already answered** — the closing question's rarest lemma must not already appear
    in the body.
14. **word cap** — counted on the final rewritten text.

On pass 1 any retry-class violation produces `retry_instructions`, a single line listing the
broken rules. On pass 2 retry-class violations are downgraded to `flag` and the fixed-so-far
reply is accepted. Outcomes are labelled `accept`, `accept_flagged` or `fallback`, and the
violation list is persisted on the message row — so the guard's own hit rate is measurable.

### Providers

One factory, two providers, chosen by `LC_LLM_PROVIDER`. A missing key throws at construction
rather than at request time. Both share the reply schema, the JSON parser, a 15s timeout, and a
single retry on timeout / 429 / 5xx / unparseable output. Exactly one JSON line is logged per
call — `{evt:'lc.llm', provider, model, latency_ms, usage}` — and never the prompt or the reply.

**Gemini** (default), `gemini-2.5-flash` via `@google/generative-ai`. `responseMimeType:
'application/json'`, an OpenAPI-subset `responseSchema` (no `additionalProperties`, which Gemini
rejects), `temperature: 0.3`, `maxOutputTokens: 1500`, and the non-obvious one:
**`thinkingConfig: { thinkingBudget: 0 }`**. That field is untyped in SDK 0.24.1 but passes
through; without it the model thinks by default and blows the latency budget.

**Anthropic**, `claude-opus-5`, over raw `fetch` — no SDK. `anthropic-version: 2023-06-01`,
`max_tokens: 4000`, and structured output via
`output_config: { effort: 'low', format: { type: 'json_schema', … } }`. The forbidden part: the
body **never** sends `temperature`, `top_p`, `top_k` or `thinking` — those 400 on Opus 5 and
Sonnet 5. If the API 400s specifically on `output_config`, the call is re-sent once without it
and with a JSON-only system instruction.

Parsing is shared: `JSON.parse` the whole text, and on failure fall back to the first *balanced*
`{…}` found by a brace-depth scan that honours strings and escapes — which is what survives a
fenced block or stray chatter. The route taken is reported as `parse_via`.

### When the model fails, refuses, or is off

`templatedReply` writes a schema-valid, question-ending, rung-appropriate reply with no model
involved, in English or Hinglish. Rung 1 asks for the plan; rung 2 names the family and asks what
one state would mean; rung 3 states the verdict in plain words (as fact for a high tier, "it
looks like" otherwise) and asks the student to trace the failing case by hand; rung 4 asks for
twelve lines of pseudocode with the least-certain line left as `___`.

Six situations reach for it, each recorded as `guard.reason`: `kill_switch`, `no_llm`,
`llm_<code>` (timeout / http / parse / refusal / config), `llm_unexpected`, `guard` (schema
failure on pass 2), and `empty_reply`. Every one returns `provider: 'template'`, `model: null`
and **`degraded: true`**, which is persisted, returned to the panel, and logged. The panel shows
a "fallback mode (templated, no AI)" banner and marks each affected bubble. A guarded model reply
— including an `accept_flagged` one — is never marked degraded.

Two things worth knowing: the daily hint counter is incremented **before** the LLM call, so a
templated fallback still costs a hint; and the panel aborts at 60s regardless of the server's 15s
per-call budget, emitting a `hint_timeout` client event.

---

## Database

One additive migration, `db/012_lc_init.sql`, creating eleven `lc_`-prefixed tables in the
**same MySQL database Friction already uses**. No second database, no second pool.

| Table | Purpose | Primary key |
|---|---|---|
| `lc_schema_migrations` | migration ledger, one row per applied migration | `name` |
| `lc_profiles` | per-user settings, consent, sync state, cached skill model, hint budget | `user_id` |
| `lc_consents` | append-only record of which consent version was accepted | `(user_id, version)` |
| `lc_problems` | **shared**, user-agnostic problem cache | `slug` |
| `lc_solved` | per-user solved set, merged from sync and live attempts | `(user_id, slug)` |
| `lc_submissions` | per-user submission history — the raw material for every analysis | `(user_id, lc_submission_id)` |
| `lc_skill_events` | append-only audit trail of model changes | `id` |
| `lc_habits` | detected patterns plus the student's reaction | `id` (unique on `user_id, habit_key`) |
| `lc_chat_sessions` | one tutoring session per user per problem | `id` |
| `lc_chat_messages` | every turn, with the contract, guard and usage that produced it | `id` |
| `lc_client_events` | extension-side telemetry | `id` |

Two shapes are worth calling out. `lc_problems` is the only table with **no `user_id`** — it is a
shared cache that must outlive any individual user, and writes are first-writer-wins per column.
And `lc_chat_messages.session_id` carries **no foreign key**; the only FK is `user_id`, which is
why `purgeUser` deletes messages explicitly rather than relying on a session cascade.

Nine of eleven tables declare exactly one foreign key — `user_id → users(user_id) ON DELETE
CASCADE` — and that is the *entire* coupling to Friction's schema. The cascade runs one way:
deleting a Friction `users` row removes every Recall row automatically, while
`DELETE /api/lc/me` leaves the `users` row untouched.

### The collation preflight — read this before running the migration

Line 2 of the SQL file is a pragma in a comment:

```
-- lc:expect-users-collation utf8mb4_0900_ai_ci
```

`migrate.js` greps that value out of the **up** file (even when you pass `--down`, so it governs
rollback too), then asks `information_schema.COLUMNS` for the actual collation of
`users.user_id`. `information_schema` rather than `SHOW CREATE TABLE`, because the latter prints
no collation when a column inherits the table default.

This matters because MySQL refuses a foreign key whose child and parent columns have different
collations, with **errno 3780**. Friction's `users` table was created with `DEFAULT CHARSET=utf8mb4`
and **no explicit `COLLATE`**, so its real collation is whatever the server defaulted to. On a
server defaulting to `utf8mb4_general_ci`, all eleven `CREATE TABLE`s — which hard-code
`utf8mb4_0900_ai_ci` — would fail partway through on their FK constraints. The preflight turns
that into a clean abort with exit code 2 and an explicit instruction, before executing a single
statement.

### Running the migration

From `backend/` (that is where `.env` lives, and `dotenv.config()` resolves against the cwd):

```bash
node src/lc/db/migrate.js --dry-run   # preflight + list the statements, change nothing
node src/lc/db/migrate.js             # apply
```

Applying is idempotent and checksum-guarded — the script sha256s the **raw file text, comments
included**, so editing even a comment after applying trips the guard. That is deliberate: it
pushes you toward a new migration rather than mutating an applied one.

| Situation | Exit |
|---|---|
| not yet applied | 0 (applies, records ledger row) |
| applied, same checksum | 0 (nothing to do) |
| applied, **different** checksum | 4 (`write a new migration instead`) |
| collation mismatch | 2 |
| `--down` without the confirm token | 3 |

Rollback is `node src/lc/db/migrate.js --down --confirm DROP_LC_TABLES`. It drops all eleven
tables child-before-parent and is labelled pre-pilot use only — it destroys data, it does not
reverse it.

### Consented code, and deletion

Source code lives in `lc_submissions.code` (`MEDIUMTEXT NULL`) with a `code_hash`, gated on
`lc_profiles.consent_code` (**off by default**) at the point of *ingestion*, not at read time,
and capped at 200,000 chars. The upsert uses `code = COALESCE(code, VALUES(code))`, so a later
no-consent sync can never erase code already stored.

**Revoking consent** runs a blanket `UPDATE lc_submissions SET code = NULL WHERE user_id = ?` in
the same transaction as the profile update, and reports `code_rows_nulled`. Note `code_hash` is
not cleared by this path.

**Full deletion** is `purgeUser`, one `DELETE … WHERE user_id = ?` per table in child-first
order, returning per-table `affectedRows`. It deliberately does not touch the Friction `users`
row or the shared `lc_problems` cache. Two entry points: `DELETE /api/lc/me`, and the operator
script `scripts/purge_user.js` (requires `--confirm PURGE`, exits 5 if any rows remain, and warns
if its table list drifts from what `purgeUser` reports).

---

## Inside the extension

Four runtime surfaces: one service worker, two extension pages, and **two content scripts that
run in different JavaScript worlds on the same tab**.

### Two worlds, one page

The split is forced by what each world can reach. `window.fetch`, `XMLHttpRequest.prototype` and
`window.monaco` are the **page's** objects; an ISOLATED content script sees its own clean copies
and cannot intercept them. Conversely `chrome.runtime` and `chrome.storage` do not exist in MAIN.
So the interceptor and editor reader must live in MAIN, and everything that talks to the worker
must live in ISOLATED.

### The nonce-guarded bridge

The worlds share only `window.postMessage`. Every message is
`{ __recall: true, from: 'main'|'iso', nonce, type, reqId, payload }`, posted with
`targetOrigin = location.origin`.

ISOLATED mints `crypto.randomUUID()` at load and publishes it on `<html data-recall-nonce>`.
MAIN never caches it — it re-reads the attribute on every send and receive, because at
`document_start` MAIN may evaluate before ISOLATED has written it. Both receivers check
`event.source === window`, `event.origin === location.origin`, `__recall === true`, that `from`
is the *other* side, and that the nonce matches.

The nonce lives in a DOM attribute, so page scripts can read it. It disambiguates Recall's
traffic from other `postMessage` senders and from a stale pre-handshake state — **it is not a
secret**.

The handshake is a retry loop, not a single shot: MAIN fires an unsolicited `ready` the moment it
installs, but ISOLATED does not attach its listener until consent is read from storage, so that
first `ready` is normally lost. ISOLATED then posts `hello` every 500 ms up to 20 tries; if no
`ready` arrives it reports `capture: 'off'` with reason `no_main`.

### What makes the interceptor safe

1. **It never consumes a body.** Responses are read via `res.clone().json()`; the page's own copy
   is untouched.
2. **It never throws into the page.** The classification runs inside `try/catch`, the original
   `fetch` is returned regardless, and the observation is attached to the returned promise and
   terminated with `.catch(() => {})`.
3. **It self-disables after 5 errors.** `MAX_WRAPPER_ERRORS = 5`; on the fifth, it restores the
   originals, clears timers, and posts `capture_disabled` — which surfaces in the popup as
   `off (wrapper_errors)`.
4. **Errors are recorded, not silently swallowed** — a count plus the last 5 messages in page
   `localStorage`.

### Reading the editor

`readEditor()` tries three sources in order: **Monaco** by DOM containment
(`monaco.editor.getEditors()`, then the editor whose `getDomNode()` is inside `#editor`), then a
**CodeMirror 6** fallback (`.cm-content` → `cmView.view.state.doc.toString()`), then nothing.
Language resolves separately: LeetCode's `localStorage.global_lang`, then the visible language
button, then the last observed submit's lang, then Monaco's model language.

Consent is enforced at four layers — MAIN refuses first and returns
`{code: null, reason: 'no_consent'}` without touching the editor; then ISOLATED, then the worker,
then the server.

### The side panel

**There are no rung buttons.** The redesign deleted them: the panel computes `requested_rung`
itself as a step function — `min(lastRung + 1, allowed)`, jumping straight to `allowed` after a
failure, and never rising when the message came from a tap. Only the written-diagnosis gate sends
a flat `4`, and the server logs that path as `rung4_path: 'gate_form'`.

**The loading state narrates instead of streaming.** `POST /api/lc/chat` returns one complete
JSON reply, so there is no token stream and a character-by-character reveal would misrepresent
the system. Instead the wait names the inputs the hint is being built from — thread length,
attached code and its line count, the last verdict, which anchors — all of which are resolved on
the client *before* the request is issued. The bubble is built at full height with every line at
opacity 0, so it never reflows mid-wait; the stagger is CSS `transition-delay`, not timers. Past
8s the pulse decelerates and the last line swaps in place; past 9s with a failed health probe it
becomes a cold-start narration with a live elapsed counter. `prefers-reduced-motion` zeroes the
durations but keeps the delays.

`extension-leetcode/dev/motion-preview.html` renders these states in isolation against the real
stylesheets.

**Security posture:** no `innerHTML` anywhere in the shipped files — model text is rendered
through `markdown.js` into a `DocumentFragment` with `createElement`/`textContent` only.

**Storage keys.** `chrome.storage.local`: `authToken`, `theme`, `consentCode`, `language`,
`detailsCap`, `profileSummary`, `syncState`, `problemsSent`, `postQueue`, `captureStats`.
`chrome.storage.session`: `tab:<tabId>`, `serverHealth`. Page `localStorage`:
`recall_pending_events`, `recall_capture_errors`.

---

## API surface

All under `/api/lc`, all behind `requireAuth` + pilot allowlist + version gate. Errors are
`{error: "<code>"}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | DB-free liveness + version + provider + kill switches + `min_extension_version` |
| GET | `/health/ready` | `SELECT 1`; 500 `db_unavailable` on failure |
| GET | `/me` | profile, counts (incl. `max_lc_submission_id`), skill summary, live habits, hints today/cap |
| GET/PUT | `/profile` | `language`, `consent_code`, `leetcode_username`; revoking consent nulls stored code |
| POST | `/consent` | record acceptance of a consent version (required before sync) |
| DELETE | `/me` | purge every `lc_` row for the user; the Friction account survives |
| POST | `/sync` | phases `solved` → `submissions` → `finalize` |
| PUT | `/problems/:slug` | problem metadata + statement excerpt; first-writer-wins |
| GET | `/anchors/:slug` | family, sub-patterns, ≤3 scored anchors, `omitted_reason` |
| POST | `/attempts` | record a verdict → bucket, tier, `is_first_ac`, `habits_changed` |
| POST | `/chat` | one hint → reply, rung, anchors, habits shown, `allowed_rung_next`, `degraded` |
| GET | `/chat/:slug/history` | the session transcript |
| POST | `/chat/messages/:id/feedback` | thumb + reason + note |
| POST | `/habits/:id/feedback` | confirmed / dismissed |
| POST | `/client-events` | extension telemetry |

---

## Running it

### Prerequisites

MySQL reachable through the `DB_*` env, a `JWT_SECRET` matching whatever signs the Friction web
app's tokens, and Node (the dev harness targets Node 24, built-ins only). Chrome 116+ for the
extension.

### Local development

```bash
cd backend
cp .env.example .env                  # fill DB_*, JWT_SECRET, GEMINI_API_KEY
node src/lc/db/migrate.js --dry-run
node src/lc/db/migrate.js
node src/lc/index.js                  # Recall on :4100
```

> **Do not use `npm start` or `npm run dev`** — both are `node src/index.js`, which boots
> *Friction* on port 4000, not Recall.

Boot is deliberately forgiving: `waitForDb()` is fired *after* `listen()` and retries 10× at 3s
before continuing anyway, so the process stays up with a dead database. A missing `JWT_SECRET`
logs `lc.boot.warn` and then 401s every authenticated request. A missing LLM key logs
`lc.llm.unavailable`, sets the client to null, and every hint becomes a templated fallback with
`degraded: true`.

### Tests

```bash
cd backend && npx jest tests/lc      # 23 suites, 684 tests — Recall only
```

`npm test` runs those *plus* Friction's suites.

### Offline extension harness

No dependencies, three terminals:

| Command | Port | Fakes |
|---|---|---|
| `node extension-leetcode/dev/serve-fixture.js` | 4173 | leetcode.com: problem pages, `/graphql/` by `operationName`, `/api/submissions/` paging, submit → `v2/check` polling (2× PENDING then SUCCESS), Run-Code noise |
| `node extension-leetcode/dev/mock-backend.js` | 4100 | the whole `/api/lc/*` surface, in memory, keyed per Bearer token |
| `node extension-leetcode/dev/build-dev.js` | — | copies the extension to `dev/build/`, adds localhost to the matches, rewrites `ENV` to `'local'` |

Then load `extension-leetcode/dev/build/` unpacked and open `http://localhost:4173/`. The
fixture's fault switches are cookies set by on-page buttons — `fake_logged_out`, `fake_429`,
`fake_cf` (Cloudflare-style HTML challenge), `fake_drift` (GraphQL schema drift) — and are the
only way to exercise the sync engine's error paths offline. The mock's knobs are env vars:
`MOCK_COLD_START_MS`, `MOCK_CHAT_DELAY_MS`, `MOCK_FAIL_EVERY`, `MOCK_KILL_LLM`,
`MOCK_DAILY_CAP`, `MOCK_MIN_EXT_VERSION`, and more.

`dev/CHECKLIST.md` is the manual pass against real leetcode.com.

### Configuration

Everything Recall reads itself is in `backend/src/lc/config.js`, frozen at boot. `bool()` treats
`1|true|yes|on` as true.

| Variable | Effect | Default | Required |
|---|---|---|---|
| `PORT` | listen port | `4100` | no |
| `NODE_ENV` | stored as `config.nodeEnv` | `development` | no — nothing in `src/lc/` reads it |
| `LC_LLM_PROVIDER` | `gemini` or `anthropic` | `gemini` | no |
| `GEMINI_API_KEY` / `LC_GEMINI_API_KEY` | Gemini credential | `''` | yes when provider is `gemini` |
| `LC_GEMINI_MODEL` | Gemini model id | `gemini-2.5-flash` | no |
| `ANTHROPIC_API_KEY` | Anthropic credential | `''` | yes when provider is `anthropic` |
| `LC_ANTHROPIC_MODEL` | Anthropic model id | `claude-opus-5` | no |
| `LC_LLM_TIMEOUT_MS` | per-call LLM timeout | `15000` | no |
| `LC_DAILY_HINT_CAP` | hints per user per UTC day | `60` | no |
| `LC_KILL_LLM` | serve templated hints only | `false` | no |
| `LC_KILL_SYNC` | `POST /sync` → 503 | `false` | no |
| `LC_MIN_EXTENSION_VERSION` | version gate floor, advertised on `/health` | `1.0.0` | no |
| `LC_PILOT_USER_IDS` | comma-separated allowlist | `''` (**empty = open to everyone**) | no |
| `LC_MAX_RUNG` | global ceiling for `decideRung` | `4` | no |
| `LC_DETAILS_CAP` | parsed into `config.detailsCap` | `300` | no — **not consumed anywhere**; the live cap is the extension's own |
| `LC_CONSENT_VERSION` | consent version required by sync | `'1'` | no |
| `CORS_ORIGINS` | extra allowed origins | `''` | no |
| `WEB_APP_URL` | its origin is added to the CORS allowlist | `''` | no |
| `RAILWAY_GIT_COMMIT_SHA` / `GIT_SHA` | first 7 chars become the `/health` version suffix | `dev` | no |

Inherited from the Friction modules Recall imports:

| Variable | Effect | Required |
|---|---|---|
| `JWT_SECRET` | verifies the Bearer token | **yes** — without it every request 401s |
| `JWT_ISSUER`, `JWT_AUDIENCE` | passed to `jwt.verify`; must match the signer | effectively yes |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL pool | **yes** |
| `DB_PORT` | MySQL port | no (`3306`) |
| `DB_SSL` / `DB_SSL_MODE`, `DB_SSL_REJECT_UNAUTHORIZED`, `DB_SSL_CA` | TLS to MySQL | no |
| `DB_CONNECT_TIMEOUT_MS`, `DB_KEEPALIVE_MS` | pool timeouts | no |

On the client side, `extension-leetcode/config.js` is a **checked-in constant, not an env file**:
`ENV` selects between `local` (`http://localhost:4100`) and `production`. Both hosts are in
`host_permissions`, so switching needs no manifest edit. The other client constants —
`LC_RATE_MS: 1000`, `DETAILS_CAP_DEFAULT: 300`, `CHUNK_SUBS: 200`, `CHAT_TIMEOUT_MS: 60000`,
`SYNC_LOOKAHEAD_PAGES: 20` — live in the same object. Flipping `ENV` before packaging is a manual
step; there is no build script.

---

## Deployment

The backend runs on Railway, separate from Friction. `backend/railway.json` declares
`builder: RAILPACK`, `startCommand: "node src/lc/index.js"`, `healthcheckPath: "/health"`,
`restartPolicyType: ON_FAILURE` and `drainingSeconds`.

> **Gotcha that cost real time:** `railway up` does **not** read `backend/railway.json`. Left to
> itself it ran `npm start` — which boots *Friction*, including its nightly cron. The start
> command had to be set on the service instance itself via the Railway GraphQL API
> (`serviceInstanceUpdate` with `startCommand`, `healthcheckPath`, `sleepApplication`).
> On the free plan `sleepApplication: true` is required, so cold starts are real — which is why
> the panel has a waking-server banner and a cold-start narration.

Two further Railway behaviours worth knowing: **env vars are baked into a deployment**, so
`railway redeploy` and `deploymentRestart` reuse the old snapshot and only a fresh `railway up`
picks up new variables; and the free tier rejects deploys to `us-west2` between 08:00 and 20:00
America/Los_Angeles.

Set secrets without putting them in shell history or a file:

```bash
read -rs "k?SECRET: " && printf '%s' "$k" | railway variable set MY_KEY --stdin --service anchor --skip-deploys && unset k
```

---

## Operations

### Kill switches and gates

Four independent brakes, all per request:

- **`LC_KILL_LLM`** — short-circuits *before* the provider call and returns the templated reply
  with `degraded: true`. Chat keeps working; it stops costing money.
- **`LC_KILL_SYNC`** — every sync phase throws `503 sync_paused`.
- **`LC_PILOT_USER_IDS`** — empty is open; otherwise an unlisted `user_id` gets
  `403 pilot_closed` on all of `/api/lc/*`. `/health` is unaffected.
- **`LC_MIN_EXTENSION_VERSION`** — an `X-Recall-Version` below the floor gets
  `426 update_required`. A missing or unparseable header passes through by design; the
  client-side gate on `/health` is the backstop.

Both kill flags are mirrored in `/health.kill` and in `GET /api/lc/me`, so the extension can show
a banner without a separate endpoint.

### Rate limits

All 60-second windows, keyed by `u:<user_id>` when authenticated, else `ip:<ip>`.

| Limiter | Routes | Limit/min |
|---|---|---|
| `general` | `/me`, `/profile`, `/consent`, `/anchors/:slug`, history, feedback | 120 |
| `chat` | `POST /chat` | 20 |
| `sync` | `POST /sync` | 120 |
| `attempts` | `POST /attempts` | 60 |
| `events` | `POST /client-events` | 30 |
| `problems` | `PUT /problems/:slug` | 60 |

The sync limit is sized against the client's 1 req/s sweep (~60/min). *(Note: the comment at
`routes/sync.js:6` still says "30/min" — that is stale; `limiters.js` is authoritative.)*
No store is configured, so counters live in process memory and do not aggregate across replicas.

Body caps are per route: 2 MB for `/sync`, `/problems/:slug` and `/attempts`; 256 kB for `/chat`,
`/profile`, `/habits/*` and `/client-events`; 16 kB for message feedback. Oversize becomes
`413 payload_too_large` — worth knowing, because ~150 C++ submissions with code exceeds 2 MB, so
a sync driver must halve its chunk on 413.

The daily hint cap is enforced atomically in the database **before** the LLM call.

### Health

`GET /health` never touches the database synchronously — it kicks off a probe cached for 30s and
returns the *previous* result, so the first call reports `"db": "unknown"`:

```json
{"status":"ok","service":"anchor","version":"0.1.0+dev","uptime_s":12,
 "provider":"gemini","kill":{"llm":false,"sync":false},
 "min_extension_version":"1.0.0","db":"unknown","migration":"012_lc_init"}
```

`GET /health/ready` runs `SELECT 1` and returns 500 `db_unavailable` on failure. Use `/health`
for liveness and `/health/ready` for readiness.

### Pilot report

`node src/lc/scripts/pilot_report.js --user <id|email> --days 14 --last 20` reports hints per day
and rung, feedback by thumb and reason, anchors offered vs cited, habits shown vs reactions,
verdicts captured vs manual vs sweep, provider latency percentiles and tokens, guard rejections,
sync runs and errors, and the last N transcripts with their contract.

The number to watch is the **drift ratio**, `verdict_seen / submit_seen` from
`lc_client_events`. Below 0.8 over 24h with ≥5 submits means the interceptor is missing verdicts
— usually because LeetCode changed a URL shape.

---

## Privacy and data handling

- **Consent is off by default** and is enforced at four layers (MAIN, ISOLATED, worker, server).
  With it off, no source code is stored anywhere.
- **LeetCode credentials never leave the browser.** Content scripts talk only to leetcode.com
  using the session cookie the browser already has; the Recall backend never sees a LeetCode
  cookie or password. Conversely the Recall JWT never enters a leetcode.com page.
- **A consent row is required before any sync** (`POST /api/lc/consent`).
- **Revoking consent** nulls all stored code immediately and reports the row count.
- **`DELETE /api/lc/me`** is transactional, returns per-table counts, and leaves the Friction
  account intact.
- **Logs never contain** prompts, replies, code, tokens, or query strings — the request logger is
  ten lines and deliberately narrow.
- **Raw account exports stay out of the repo.** `lc-research/.gitignore` excludes `exports/`,
  `lc-export-*/`, `demo/`, `demo_*.json` and `*.zip`. Test fixtures are synthetic:
  `lc-research/make_fixture.js` is a generator that reads nothing real, and
  `backend/tests/lc/fixtures/snippets.js` is hand-written C++.

---

## Known gaps

Honest list, as of this writing:

- **Gemini's free tier allows 20 requests per day per project**, shared across all users, while
  `LC_DAILY_HINT_CAP` defaults to 60 per user. A pilot needs either billing on the Google
  project or `LC_LLM_PROVIDER=anthropic`. The failure is visible, not silent — the panel shows a
  fallback banner — but the product is not useful past the cap.
- **The Anthropic provider has never made a live call.** It is built and unit-tested against a
  fake `fetch`; the request shape is asserted, the real API is unverified.
- **The extension panel has no unit tests.** Adding them needs jsdom, and Recall deliberately
  does not modify `backend/package.json`. `buildProgressLines()` carries the same hard invariant
  as the memory block — never name a problem absent from `anchors[]` — currently guaranteed by
  construction rather than by a test.
- **Tier phrasing is instructed, not enforced.** See the caveat under
  [Verdict buckets](#verdict-buckets-and-precision-tiers).
- **Buckets are C++-tuned.** The runtime-error regexes match UBSan/ASan messages; Python and
  Java failure shapes are not covered.
- **Calibration is one account.** The bucket tiers come from 86 double-rated failures on a
  single C++ solver's history. They are the best evidence available, not a population statistic.
- **`LC_PILOT_USER_IDS` unset means open to every Friction user.**
- **`LC_DETAILS_CAP` is read into config but never consumed.**
- **The stale comment at `routes/sync.js:6`** says 30/min; the real limit is 120/min.
