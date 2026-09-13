# Anchor for LeetCode (Chrome extension)

Anchor is a tutor for leetcode.com. It builds a skill map from your own submission
history, shows you the problems you already solved that are related to the one you
are on, and gives hints anchored to them. Hints never contain code.

The extension is Manifest V3, desktop Chrome 116+, active only on
`https://leetcode.com/problems/*`. It talks to the Anchor backend
(`backend/src/lc/` in this repo) and to nothing else.

## Files

| file | role |
|---|---|
| `manifest.json` | MV3 manifest: side panel, background worker, two content-script groups (MAIN + ISOLATED) |
| `config.js` | `ENV` switch → `globalThis.ANCHOR_CONFIG` (API base, web app URL, rate/chunk/timeout constants) |
| `anchor-setup.js` | `globalThis.AnchorExt`: token / theme / consent / language storage + `fetchWithAuth` |
| `api.js` | ES module, one function per `/api/lc/*` endpoint → `{ ok, status, data, error }` |
| `markdown.js` | `renderModelText(text, { allowFence })` → DocumentFragment (bold, inline code, one fence at rung 4) |
| `background.js` | service worker: message router, per-tab context, durable retry queue, badge, `/health` cache |
| `popup.html/.js/.css` | 280 px popup: token paste, consent, language, open panel, settings rows, delete, report an issue |
| `theme.css` | colour tokens, theme classes and base controls shared by popup and side panel |
| `sidepanel.html/.js/.css` | the tutor panel (state machine, sync driver, chat) |
| `lc-main.js` | MAIN-world interceptor: submit + `v2/check` verdicts, editor code reader |
| `lc-queries.js`, `lc-client.js`, `lc-sync.js`, `lc-content.js` | ISOLATED-world content scripts: GraphQL queries, paced client, first-run sync engine, bridge + message handlers |
| `dev/` | offline fixture server, mock backend, dev build, manual checklist |

## Load unpacked

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick this `extension-leetcode/` folder (or `dev/build/` for the
   offline fixture setup).
3. Pin the Anchor icon.

Updates: replace the folder contents (or unzip the new build over it), then click
**Reload** on `chrome://extensions`. When the backend raises
`LC_MIN_EXTENSION_VERSION`, the popup and panel ask for an update.

## Environment switch

`config.js` starts with `const ENV = 'local'`:

| ENV | API_BASE | WEB_APP_URL |
|---|---|---|
| `local` | `http://localhost:4100` | `http://localhost:3000` |
| `production` | `https://anchor-production.up.railway.app` | `https://nofriction.netlify.app` |

The packaging step flips it to `'production'` before zipping. Both API hosts are
listed in `host_permissions`, so no manifest change is needed to switch.
`ANCHOR_CONFIG.EXT_VERSION` is read from the manifest and is sent with every
client event.

Local backend: `cd backend && node src/lc/index.js` (or `node extension-leetcode/dev/mock-backend.js`).

## Signing in (paste a token)

Anchor reuses the Friction login. No password is ever typed into the extension.

1. Sign in at the web app (`WEB_APP_URL`).
2. Click the **Connect** (link) button: it copies your token to the clipboard.
3. Open the Anchor popup, paste the token into the field, click **Save**.
4. The dot in the popup header turns green and the subtitle shows
   `<username> · <n> solved` once your history is synced.

The token expires every 7 days; the popup then says "Token expired, paste a new
one" and shows the field again. The token is stored only in
`chrome.storage.local` and sent only as `Authorization: Bearer …` to the Anchor
API. Treat it like a password. **Forget token** removes it from this browser.

## First sync

Open any problem on leetcode.com while signed in to LeetCode, open the panel
(**Open Anchor panel** in the popup, or the side-panel icon), and click **Sync my
history**. Read the consent screen first. A ~1,300-submission account takes 6–8
minutes; keep the tab open and visible. The cursor is durable: if you close the
panel or reload the tab, re-open and click **Resume**.

## Code consent

The popup toggle **Let Anchor read my LeetCode code** is **off by default**.

- Off: Anchor stores only metadata (verdicts, timestamps, tags, judge output).
  Hints still work; anchors cannot show your own past code.
- On: the code of your failed and first-accepted attempts is stored so anchors can
  point at your own solutions, and the editor's current code is sent with a hint
  request. Consent is checked in four places (page, content script, background,
  server) so nothing leaks when it is off.
- Turning it off again deletes every stored code row on the server immediately.

## Hint language

**English** by default; **Hinglish** available from the popup and the panel. Saved
to your profile, so it follows you across devices.

## Delete my data

Popup → **Delete my data** → click again within 6 seconds to confirm. This calls
`DELETE /api/lc/me`, which wipes every Anchor table for your user (profile,
consent, solved list, submissions, habits, chats, client events) and then clears
the local caches (`profileSummary`, `syncState`, `problemsSent`, `postQueue`,
`captureStats`) and resets the consent toggle. Your token and theme stay so you
can sync again. Your Friction account is untouched.

## Report an issue

Popup → textarea → **Send**. It records a `client-event` of type `issue_report`
with your text, the current leetcode.com URL (if any), your settings and browser
version. Your code is never included. If the server is unreachable the report is
queued and sent later.

## Storage keys

`chrome.storage.local`: `authToken`, `theme`, `consentCode`, `language`,
`detailsCap`, `profileSummary`, `syncState`, `problemsSent`, `postQueue`,
`captureStats`.
`chrome.storage.session`: `tab:<tabId>` (`{ slug, page, isContest, url, updatedAt,
capture, judging, lastAttempt, needsReload }`), `serverHealth`.
Page `localStorage` (leetcode.com): `anchor_pending_events`, `anchor_capture_errors`.

## Background message protocol

Content script → background (`chrome.runtime.sendMessage`, reply `{ ok, ... }`):
`route:changed { slug, page, isContest, url }`, `capture:state { state, reason? }`,
`attempt:judging { title_slug, submission_id }`,
`attempt:captured { title_slug, captured_via, submission_id, verdict, code?, lang? }`
(code is dropped unless consent is on; queued as `POST /api/lc/attempts`),
`problem:meta { slug, meta }` (queued as `PUT /api/lc/problems/:slug`, once per slug),
`client:event { event, detail }`, `content:invalidated`.

Background → pages: `attempt:recorded { tabId, submission_id, title_slug, result }`
after the attempt is stored; the action badge shows the verdict for 3 seconds.

Pages → background helpers: `health:check { force?, maxAgeMs? }`, `ctx:get { tabId }`,
`queue:flush`, `queue:status`.

Queue policy (`chrome.storage.local.postQueue`): tried immediately and by a
1-minute alarm; 20 s per try; backoff `min(1 h, 60 s · 2^(attempts−1))`;
`Retry-After` honoured on 429; other 4xx are dropped with a `queue_drop` client
event; 401 pauses the queue until a token is saved again; 20 attempts drop the item.

## Known limitations (v1 pilot)

- Verdict buckets are tuned for **C++** (UBSan messages). Python/Java patterns come later.
- English default, Hinglish toggle; no other languages.
- Habits come from verdicts and timing only; no code mining yet.
- Off during contests (`/contest/…` submissions are ignored; the panel locks).
- Anchors only for DP and graph families.
- 60 hints per day; hints never contain code.
- Desktop Chrome only (side panel + MAIN-world content scripts need Chrome 116+).
- Live capture needs the tab to stay open; after an extension reload, the page
  shows a "reload this tab" banner until you reload it.
- Runtime percentile is not used as a signal; it is noise on this account size.

## Privacy

Nothing from leetcode.com other than your public profile, submission list, judge
output and (with consent) your code is sent anywhere, and it goes only to the
Anchor API with your Bearer token. No LeetCode cookies or passwords leave the
browser. Hints are generated by Gemini or Anthropic under paid API terms. The
Network tab of any extension page shows exactly one destination: `API_BASE`.
Model text is rendered with `markdown.js` through `createElement` / `textContent`
only; no file in this folder assigns a markup string to the DOM, so the
DOM-injection grep in `dev/CHECKLIST.md` prints nothing.

## Development notes

- Classic scripts (`config.js`, `anchor-setup.js`) share one global lexical scope
  in every page and in the ISOLATED content-script world: do not redeclare
  `ENV` / `CONFIG_BY_ENV` in `lc-*.js` or `background.js`.
- `api.js` and `markdown.js` are ES modules; `popup.js` / `sidepanel.js` import them.
- Syntax checks: `node --check background.js anchor-setup.js config.js`; for the
  modules copy to `.mjs` first (`cp api.js /tmp/api.mjs && node --check /tmp/api.mjs`).
- Offline testing: `node dev/serve-fixture.js` (fake leetcode on :4173) and
  `node dev/mock-backend.js` (:4100), load `dev/build/` unpacked. Real-site checks
  are in `dev/CHECKLIST.md`.
