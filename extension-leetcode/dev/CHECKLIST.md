# Recall extension: manual checklist

Two passes. **A** runs offline against `dev/serve-fixture.js` + `dev/mock-backend.js` with `dev/build/` loaded
unpacked (see `dev/README.md`). **B** runs on real leetcode.com with the production or local backend. Tick a row
only when the observed behaviour matches the pass criterion; write the date next to it.

Observation points used below:

- **Page log / Bridge traffic**: the two panes at the bottom of the fixture page (`from -> type`, submission ids, `typed_code:yes|no`).
- **Fixture terminal**: `[fixture] … METHOD path -> status …` lines from `serve-fixture.js`.
- **Mock terminal**: `[mock] … METHOD path -> status …` lines from `mock-backend.js`; `curl -s localhost:4100/__mock/state | jq` dumps its memory.
- **Service worker console**: `chrome://extensions` → Recall (dev) → *service worker*; `[Recall BG]` lines, queue drops.
- **Panel**: the Recall side panel; **Popup**: the toolbar popup.

---

## A. Offline fixture (`dev/build/`, `http://localhost:4173`, mock on `:4100`)

### A1. Boot and token

| # | step | pass when |
|---|---|---|
| 1 | Load `dev/build/` unpacked; open `http://localhost:4173/` (redirects to a target problem) | Header reads `extension: MAIN yes · ISOLATED yes` (green). Bridge traffic shows `iso -> hello` then `main -> ready capture=on` |
| 2 | Popup → paste any token (e.g. `dev-token-1`) → Save | Popup dot turns green; mock terminal shows `GET /api/lc/me -> 200` |
| 3 | Popup → paste the literal token `expired` | Popup shows the expired-token message and the paste field again; mock logs `401 auth=rejected` |
| 4 | Restart the mock with `MOCK_COLD_START_MS=25000`, open the panel | Panel shows the "waking server" banner after ~2 s, resolves within 90 s; no error state |
| 5 | Restart the mock with `MOCK_MIN_EXT_VERSION=9.9.9`, open the panel | UPDATE_REQUIRED view names the required version; popup also asks for an update |

### A2. First sync (panel → Sync my history)

| # | step | pass when |
|---|---|---|
| 6 | Fresh token, no switches: Sync | Consent screen first; `POST /consent 200`, then `sync phase=solved upserted=12`, several `phase=submissions` chunks totalling 30 rows, `phase=finalize`. Panel shows 12 solved, map summary, 2 live habits |
| 7 | Fixture terminal during 6 | `problemsetQuestionListV2` paged 3× (`skip=0,5,10`), `/api/submissions/` paged 4× (`offset=0,8,16,24`), `submissionDetails` only for the 16 failed ids, never for an Accepted one |
| 8 | Re-run Sync on the same token | Every upsert count is a no-op equivalent (`total_submissions_known` stays 30); no duplicate ids in `/__mock/state` |
| 9 | Popup consent **off**, delete data, re-sync | `/__mock/state` shows `submissions_with_code: 0`. Then consent **on**, delete, re-sync → `submissions_with_code: 30` |
| 10 | Sync with `fake_logged_out: ON` | Panel says sign in to LeetCode first; fixture shows exactly one `globalData` and **zero** `/api/submissions/` requests |
| 11 | Turn `fake_logged_out: ON` mid-sweep | Sync pauses with the logged-out reason; switch off → Resume continues from the last acked cursor (no `offset=0` again) |
| 12 | `fake_429: ON` for a whole sync | Every 7th sync request is 429; panel shows the backoff countdown honouring `Retry-After: 3`; sync completes; no request is ever abandoned |
| 13 | `fake_cf: ON` mid-sweep | Sync pauses with the "pass the check in this tab, then Resume" banner; switch off → Resume completes |
| 14 | Close the panel at ~40 % of the sweep, reopen | Resume offered; the sweep continues from the stored cursor; final counts still 12 / 30 |
| 15 | Reload the fixture tab mid-sweep, reopen the panel | Same as 14 (durable cursor survives a page reload) |
| 16 | Open a second fixture tab and start Sync there while the first runs | Second tab refused (`sync_owned_elsewhere`); first tab unaffected |
| 17 | Switch to another Chrome tab mid-sweep for 20 s | Fixture requests stop while hidden (`waiting_visible`), resume when the tab is visible again |
| 18 | `fake_drift: ON`, open a problem the panel has not sent yet | Fixture logs one `questionDetail … drift: acRate rejected` then a successful retry; a `client-events` POST records the drift; the problem still gets its `PUT /problems/:slug` |

### A3. Verdict capture (Submit button on the fixture page)

| # | step | pass when |
|---|---|---|
| 19 | Verdict picker → each of AC, WA, TLE, RE, CE, MLE, RESTRICT → Submit (7 submits) | Bridge traffic shows exactly one `main -> submission` per id; mock shows exactly one `POST /api/lc/attempts` per id with `bucket=` ac / wa_edge_empty / tle / re_overflow / ce / mle_state / restricted; badge flashes the verdict |
| 20 | After each submit, "Poll last id again" | No second `submission` event, no second attempts POST (dedupe by id) |
| 21 | "Run" | Fixture logs `runcode noise`; bridge traffic shows nothing; no attempts POST |
| 22 | Transport: XHR, repeat one WA submit | Same single capture through the XHR wrapper |
| 23 | Consent off: submit WA | Bridge `submission … typed_code:no`; mock attempts log `code=no`. Consent on → `typed_code:yes`, `code=yes` |
| 24 | "Orphan check" | One `submission` event with `orphan` and the current page slug; attempts POST succeeds |
| 25 | Stop the mock, submit AC, start the mock again | Attempt sits in the queue (service worker console), is delivered by the 1-minute alarm or on token change; `already_known=false` once |
| 26 | Reload the extension on `chrome://extensions` right after a submit whose `ack` did not arrive | On the next page load the buffered event (`recall_pending_events` count on the page) is delivered once and the count returns to 0 |
| 27 | Contest mode: ON, submit | No capture (bridge silent), panel shows CONTEST_LOCKED; chat is refused with `contest_mode` |

### A4. Editor and navigation

| # | step | pass when |
|---|---|---|
| 28 | Panel → ask for a hint with consent on | `iso -> get_code` / `main -> code code:Nch lang=cpp src=monaco`; the code carries the `// slug:` line of the current page |
| 29 | Focus mode: ON, ask again | `src=cm6`, still the current code |
| 30 | Language select → python3 (global_lang written) | `lang=python3`. Untick "write localStorage.global_lang" → language comes from the button text |
| 31 | "Next problem →" three times, then ask for a hint | Panel follows every pushState (title/anchors change); the code read carries the **new** slug (no cached model) |
| 32 | "Problem set" link | Panel shows the non-problem view; back to a problem restores PROBLEM |

### A5. Chat, gating, feedback

| # | step | pass when |
|---|---|---|
| 33 | Open `minimum-score-triangulation-of-polygon` (no attempts yet) | `GET /anchors` → 2 anchors (Burst Balloons, Minimum Cost to Cut a Stick) with `why`; `allowed_rung` 1; rung buttons above 1 disabled with the unlock caption |
| 34 | Send with the plan chip "Have a plan, it fails" | Rung 2 allowed next; reply mentions the anchor title; ends with one question |
| 35 | Submit WA on the page, then ask | Rung 3 reply cites the verdict and the failing input; `allowed_rung_next` 3 |
| 36 | Submit a second WA, request rung 4 | Rung 4 reply renders exactly one fenced block with `___` gaps; rung ≤3 replies never contain code |
| 37 | Thumbs down → "too much"; thumbs up | `POST /chat/messages/:id/feedback` twice with the right `thumb`/`reason`; `/__mock/state` lists them |
| 38 | Habit card "Not really" | `POST /habits/1/feedback reaction=dismissed`; card disappears; `/me` no longer lists it |
| 39 | EN → Hinglish toggle, ask again | `PUT /profile language=hinglish`; the reply is the Hinglish variant |
| 40 | `MOCK_DAILY_CAP=2`, three hints | Third → 429 `daily_cap`, panel shows the cap message |
| 41 | `MOCK_KILL_LLM=1` | Reply is the templated one, `degraded:true`, panel shows the degraded banner |
| 42 | `MOCK_CHAT_DELAY_MS=70000`, ask | Panel times out at 60 s with a retry option; no duplicate POST on retry |
| 43 | Open `two-sum` | Anchors empty with `omitted_reason`; panel shows the no-anchors copy |
| 44 | Reload history: ask twice, close and reopen the panel | `GET /chat/:slug/history` restores both turns with rung tags and feedback state |

### A6. Delete and hygiene

| # | step | pass when |
|---|---|---|
| 45 | Popup → Delete my data (two clicks) | `DELETE /me 200` with per-table counts; `chrome.storage.local` empty except theme; panel returns to NO_PROFILE |
| 46 | `grep -rn "innerHTML" extension-leetcode --include=*.js -l \| grep -v '^extension-leetcode/dev/'` | Empty |
| 47 | `MOCK_FAIL_EVERY=7`, submit 3 verdicts and send 3 hints | Every 503 is retried by the queue (attempts) or surfaced with retry (chat); nothing is lost |

---

## B. Real leetcode.com (production backend unless noted)

The plan's ten real-site checks. Use the dev account. Never paste real student code into this file.

| # | check | pass when |
|---|---|---|
| R1 | Token → panel | Copy the token from the web app's Connect button, paste in the popup; `/api/lc/me` 200; panel shows the profile state |
| R2 | Full sync with pause / resume / tab-switch / reload | The whole history syncs (≈373 requests for the pilot-sized account, ≤400); Pause then Resume continues from the cursor; switching tabs pauses requests; reloading the tab and reopening the panel resumes; re-running is a no-op |
| R3 | AC + WA captured exactly once with details, code only with consent | One AC and one WA (a deliberate C++ `int` overflow) each create exactly one `lc_submissions` row (`captured_via='interceptor'`) within 5 s, with judge details; the `code` column is NULL with consent off and filled with consent on |
| R4 | Run Code produces nothing | Clicking Run on the site emits no `submission` event and no attempts POST |
| R5 | Editor read in standard and Focus layouts | A probe comment typed in the editor appears in the code the panel sends, in both layouts; language matches the language button after switching it |
| R6 | Rung gating and feedback POSTs | Rung buttons above `allowed_rung` are disabled; each thumbs/chip and habit reaction produces its POST (Network tab) |
| R7 | Contest lock | On a contest problem (`/contest/...` or `?envType=contest`) the panel is locked and nothing is captured |
| R8 | Logout banner | Log out of LeetCode in another tab; the panel shows the logged-out banner and sync refuses to start |
| R9 | Extension reload with buffered delivery | Submit, reload the extension before the ack, reload the page: the buffered verdict is delivered once |
| R10 | Delete flow | Popup → Delete my data → `DELETE /api/lc/me`; every `lc_` table has 0 rows for the user; `chrome.storage.local` cleared |

Also on the real site: the Network tab shows only `Authorization: Bearer <JWT>` going to the Recall API and nothing from leetcode.com cookies leaving the browser; `grep innerHTML` (A46) is empty.
