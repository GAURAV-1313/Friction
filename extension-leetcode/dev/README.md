# Recall extension: local dev harness

Everything the extension touches, faked on localhost so every verdict type and every fault switch is
reproducible offline. No npm install: the three scripts use only Node built-ins (Node 24).

| script | port | role |
|---|---|---|
| `serve-fixture.js` | 4173 | fake leetcode.com: problem pages, `/graphql/` by operationName, `/api/submissions/` paging, submit → `v2/check`, Run-Code noise, cookie fault switches |
| `mock-backend.js` | 4100 | in-memory Recall backend: every `/api/lc/*` route with the real response shapes, `/health`, `?slow=` cold start, env knobs |
| `build-dev.js` | – | copies the extension to `dev/build/` with `localhost:4173` added to the content-script matches and host permissions, `config.js` ENV set to `local` |

## Run it

```sh
# terminal 1
node extension-leetcode/dev/serve-fixture.js

# terminal 2
node extension-leetcode/dev/mock-backend.js

# once, and again after every change to the extension sources
node extension-leetcode/dev/build-dev.js
```

Then in Chrome:

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick `extension-leetcode/dev/build/`
   (the build is named "Recall for LeetCode (dev)"; `dev/build/` is git-ignored).
2. Open `http://localhost:4173/` (it redirects to a target problem).
3. Popup → paste any token (e.g. `dev-token-1`) → Save. The mock accepts any Bearer token and keeps a
   separate in-memory user per token. The literal tokens `expired` and `bad` answer 401.
4. Open the panel and follow `CHECKLIST.md` section A.

After editing the extension: re-run `build-dev.js`, click **Reload** on `chrome://extensions`, reload the
fixture tab.

To point the dev build at the real local backend instead of the mock, run `cd backend && node src/lc/index.js`
(it also listens on 4100) and stop the mock; the build needs no change.

## The fixture page

`fixture/index.html` + `page.js` + `fake-monaco.js` mimic the parts of a LeetCode problem page the extension reads:

- `#editor` holds a textarea-backed Monaco stub: `window.monaco.editor.getEditors()[0].getDomNode()` is inside
  `#editor`, `getModel().getValue()` returns the code. **Focus mode** replaces it with a `.cm-content` element whose
  `cmView.view.state.doc.toString()` returns the code (`getEditors()` is then empty).
- Language button (`C++`), a select that also writes `localStorage.global_lang` (as a JSON string, like the site),
  and a checkbox to stop writing it so the button-text fallback can be tested.
- **Submit** does `POST /problems/:slug/submit/` and polls `GET /submissions/detail/:id/v2/check/` (fetch, or
  XMLHttpRequest with the transport toggle). The verdict picker writes a `// verdict: WA|AC|TLE|RE|CE|MLE|RESTRICT`
  marker into the code; the fixture judge obeys it (default AC). **Run** does `interpret_solution` + `runcode_*`
  polling (noise the extension must ignore). "Poll last id again" tests dedupe; "Orphan check" polls an id this
  page never submitted.
- **Next problem →** navigates with `history.pushState` through every fixture slug and re-creates the editor
  (a cached model would read stale code); the starter code carries a `// slug: <slug>` probe line.
  **Contest mode** appends `?envType=contest`. **Problem set** goes to a non-problem page.
- Fault switch buttons set cookies read by the server: `fake_logged_out`, `fake_429`, `fake_cf`, `fake_drift`.
- Two log panes: the page's own actions, and the `window.postMessage` bridge traffic (`from -> type`, ids,
  `typed_code:yes|no`; never code contents), plus the count of `localStorage.recall_pending_events`.

## Fixture data (`fixture/data/`, synthetic)

Generated from the verified seed so slugs, titles, ids and tags are real; the history and every `code` field are
fabricated (`// fixture code … not real student code`).

| file | content |
|---|---|
| `solved.json` | 12 solved problems: 3 each from `dp.interval`, `dp.knapsack_01`, `graph.dijkstra`, `graph.topological_sort` (rows in `problemsetQuestionListV2` shape) |
| `submissions.json` | 30 submissions in the REST dump shape (`id, title_slug, status, status_display, lang, timestamp, code, is_pending …`) plus `details` keyed by id (`submissionDetails` shape). Planted: two interval-DP tiny-input WAs, two UBSan int-overflow REs, a TLE followed by a quick AC, an MLE, a CE, two WAs on an unsolved target |
| `problems.json` | 17 problems keyed by slug (`questionDetail` shape: content HTML, hints, similarQuestions, topicTags). Targets (unsolved): `minimum-score-triangulation-of-polygon`, `ones-and-zeroes`, `path-with-maximum-probability`, `course-schedule-iv`, `two-sum` (no anchors) |
| `skills.json` | `tagProblemCounts` (fundamental / intermediate / advanced) and `progress` (accepted 12: 8 medium, 4 hard) |

## serve-fixture.js behaviour

- `GET /problems/:slug/*`, `/problemset/*`, `/contest/*` → `fixture/index.html`; static `/page.js`, `/fake-monaco.js`, `/data/*`.
- `POST /graphql/` by `operationName`: `globalData` (from the `fake_logged_out` cookie), `problemsetQuestionListV2`
  (5 rows per page, `totalLength`, `hasMore`; whole set as `TO_DO` when logged out), `problemsetQuestionList` (V1
  fallback), `skillStats`, `userProfileUserQuestionProgressV2`, `submissionList` (latest submission for a slug,
  including ones made on the page), `submissionDetails`, `questionDetail`.
- `GET /api/submissions/?offset&limit&lastkey` → 8 rows per page, newest first, `has_next` / `last_key`; 401 when
  logged out. Submissions made on the page are prepended.
- `POST /problems/:slug/submit/` → `{submission_id}` (incrementing from 1900000001).
  `GET /submissions/detail/:id/v2/check/` → `{state:'PENDING'}` twice, then the full `SUCCESS` payload
  (`status_code` 10/11/12/14/15/20/50, judge fields, UBSan overflow text for RE) and keeps answering `SUCCESS`
  on later polls (dedupe test). Unknown ids answer `SUCCESS` AC at once (orphan test).
- Fault switches: `fake_429` makes every 7th sync request (graphql or REST dump) a 429 with `Retry-After: 3`;
  `fake_cf` answers sync requests with a 200 HTML challenge; `fake_drift` rejects `questionDetail` with
  `Cannot query field "acRate"` while the query still names that field.
- Every request is logged: `[fixture] HH:MM:SS.mmm METHOD path -> status op=… faults=…`.

## mock-backend.js behaviour

- CORS: any `chrome-extension://` origin and `localhost`; anything else 403.
- `?slow=25000` on any URL delays that response (cold start). Env knobs (set before starting):
  `MOCK_COLD_START_MS`, `MOCK_CHAT_DELAY_MS`, `MOCK_FAIL_EVERY`, `MOCK_KILL_LLM`, `MOCK_DAILY_CAP`,
  `MOCK_MIN_EXT_VERSION`, `MOCK_SKIP_CONSENT_GATE`, `MOCK_SKIP_SYNC_GATE` (see the header of the file).
- Sync needs `POST /api/lc/consent` first (403 `consent_required` otherwise) and a matching `sync_id` for the
  `submissions` / `finalize` phases (409 `sync_id_mismatch`). `finalize` computes a skill summary from the synced
  solved rows and installs two live canned habits (interval-DP tiny-input WA, int overflow) and one stale one.
- Anchors are canned by target family (interval / knapsack / dijkstra / topological), 2 each with `why`;
  `two-sum` returns none; slugs starting `unknown-` are 404.
- Chat: the reply rung follows the same policy as the backend (plan → 2, one submission here → 3, two → 4 on
  request); replies are canned per rung and language, cite the first anchor from rung 2, the verdict from rung 3,
  and include one fenced `___` block only at rung 4. `409 not_synced` before finalize, `403 contest_mode`,
  `429 daily_cap`.
- `GET /__mock/state` dumps the in-memory state (counts, attempts, feedback, habits; never tokens or code);
  `POST /__mock/reset` clears it.
- Every request is logged: `[mock] HH:MM:SS.mmm METHOD path -> status ms user=… note`. Tokens, bodies, code and
  replies are never logged.

## Sanity commands

```sh
curl -s localhost:4100/health | jq .
curl -s -H 'Authorization: Bearer dev-token-1' localhost:4100/api/lc/me | jq .counts
curl -s -X POST localhost:4173/graphql/ -H 'content-type: application/json' \
  -d '{"operationName":"globalData","query":"query globalData { userStatus { isSignedIn username } }"}'
curl -s 'localhost:4173/api/submissions/?offset=0&limit=20' | jq '.submissions_dump | length'
```
