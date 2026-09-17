# Chrome Web Store submission — Recall for LeetCode

Everything the Developer Dashboard asks for, written out and ready to paste.
Each block below maps to one field. Fields are in dashboard order.

**Before you start:** read [Blockers](#blockers-fix-these-before-submitting) first — two
items must be done outside this repo or the submission will be rejected.

- [Blockers](#blockers-fix-these-before-submitting)
- [Package the zip](#package-the-zip)
- [Store listing](#store-listing)
- [Graphic assets](#graphic-assets)
- [Privacy practices](#privacy-practices)
- [Privacy policy (host this)](#privacy-policy-host-this)
- [Notes for the reviewer](#notes-for-the-reviewer)
- [Rejection risks, honestly](#rejection-risks-honestly)
- [Final checklist](#final-checklist)

---

## Blockers: fix these before submitting

| # | Blocker | Status |
|---|---|---|
| 1 | Privacy policy hosted at a public URL | **DONE** — live at `https://nofriction.netlify.app/privacy/` (source: `web/public/privacy/index.html`). Paste that URL into the dashboard's Privacy policy URL field. |
| 2 | **Take 1–5 screenshots** at 1280×800. See [Graphic assets](#graphic-assets). | **Outstanding.** The store requires at least one. The listing cannot be submitted without it, and none exist in the repo yet. |
| 3 | **Create a reviewer test account** and put real credentials in [Notes for the reviewer](#notes-for-the-reviewer). | **Outstanding.** Recall is unusable without a pasted token *and* a signed-in LeetCode account with solved problems. A reviewer who cannot get past the popup will reject it as broken. This is the single most likely rejection cause. |

Already handled in this repo: `http://localhost:4100/*` has been removed from
`host_permissions` (it was a dev artifact; `dev/build-dev.js` adds it back for local work),
there is no remote code, no `eval`, and no `innerHTML`.

---

## Package the zip

```bash
cd /Users/gaurav/Friction/extension-leetcode && rm -f ../recall-extension-v1.0.0.zip && zip -rq ../recall-extension-v1.0.0.zip . -x 'dev/*' -x '*.DS_Store' -x 'STORE_SUBMISSION.md' && cd .. && unzip -l recall-extension-v1.0.0.zip | grep -c 'manifest.json' && shasum -a 256 recall-extension-v1.0.0.zip
```

Upload `recall-extension-v1.0.0.zip`.

**Zip from inside `extension-leetcode/`, not from the repo root.** The Chrome Web Store needs
`manifest.json` at the top level of the archive. Zipping the folder itself nests everything one
level down and the upload is rejected with "Manifest file is missing or unreadable." The
`grep -c` above prints `1` when the manifest is where it needs to be.

`dev/` is excluded deliberately — it contains a fake LeetCode server and a mock backend that
would confuse review.

---

## Store listing

### Extension name
*(field limit 75 characters — this is 19)*

```
Recall for LeetCode
```

### Summary
*(field limit 132 characters — this is 125)*

```
Hints anchored to the LeetCode problems you already solved. Builds a skill map from your submissions. Never gives the answer.
```

### Detailed description
*(field limit 16,000 characters)*

```
Recall is a tutor for LeetCode that refuses to give you the answer.

Most AI help on a hard problem hands you a solution you did not earn, or a generic nudge like "think about dynamic programming" that you had already thought about. Recall does something different. It reads your own LeetCode submission history once, works out what you actually know from it, and then anchors every hint to a problem YOU already solved.

So instead of "consider a DP over intervals", you get:

  "In Longest Palindromic Subsequence you decided what one stored value stood for
   before writing any transition. What should one state mean here?"

— where you really did solve Longest Palindromic Subsequence, and Recall can tell you when.


HOW IT WORKS

1. Sync once. Recall reads your solved list and submission history from inside your own logged-in browser session, one request per second so LeetCode is never hammered.

2. It builds a skill map. Which patterns you are strong in, which you are still learning, how many attempts you typically need, and which kinds of mistakes actually recur for you.

3. Open any problem. The side panel shows the problems in your own history that share the underlying idea, and why each one is related.

4. Ask when you are stuck. The hint is written against your history, your latest failed test case, and the code in your editor.


DEPTH YOU EARN, NOT DEPTH YOU ASK FOR

There are four levels of help, and you cannot skip to the bottom:

  Level 1 — the shape of the problem in plain words. No technique names at all.
  Level 2 — names the pattern and maps it onto one problem you solved, as far as the state.
  Level 3 — a diagnosis of your actual failing test case. Never the fix.
  Level 4 — a short pseudocode skeleton with the key lines left blank.

Level 2 unlocks when you say what you are thinking. Level 3 unlocks after you have actually submitted something. Level 4 you have to ask for. And if you submit and fail, Recall jumps straight to diagnosing that failure — you should not have to ask twice.

Hints never contain working code below level 4, and level 4 is a skeleton with blanks, never a solution.


WHAT MAKES THE HINTS HONEST

Every number Recall shows you is computed from your stored submissions by ordinary code, not invented by a language model. The model only puts the sentence together, and what it writes is then checked automatically: citations you were not offered are removed, code below level 4 is stripped, "that's the only bug" claims are deleted, and every reply has to end with a question.

Recall also knows how confident it is allowed to be. A verdict class it can identify reliably is stated plainly; one it is less sure about is phrased as a question. It will not tell you a cause it cannot stand behind.


YOUR DATA

- Sharing your source code is OFF by default. Recall works without it.
- Your LeetCode password and cookies never leave your browser. Recall never sees them.
- One click deletes everything Recall has stored about you.
- Hints are generated through a paid API. Your data is not used to train models.

Full detail in the privacy policy.


REQUIREMENTS

- A free account at nofriction.netlify.app, to connect the extension.
- A LeetCode account you are signed into, with some solved problems.
- Desktop Chrome 116 or newer.


HONEST LIMITATIONS

- Anchors are strongest for dynamic programming and graph problems. Other topics work, but with fewer useful connections.
- Mistake diagnosis is tuned for C++ runtime errors. Python and Java verdicts are recognised but less specific.
- Recall turns itself off during contests.
- There is a daily limit on hints.
- The first sync takes a few minutes for a large account. You can leave and come back; it resumes.


Recall is an independent project and is not affiliated with, endorsed by, or sponsored by LeetCode.
```

### Category

```
Education
```

*(Second choice if Education is rejected as a poor fit: `Developer Tools`.)*

### Language

```
English
```

---

## Graphic assets

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG | **Have it** — `icons/icon128.png` |
| Screenshots | 1280×800 or 640×400, PNG or JPEG, 1–5 required | **Need to make** |
| Small promo tile | 440×280 PNG | **Need to make** (optional, but listings without it look unfinished) |
| Marquee promo tile | 1400×560 PNG | Optional — only used if featured |

### Screenshots to take (in this order)

1. **The side panel next to a DP problem**, showing the "You have solved this shape before"
   block with two real anchor problems. This is the whole product in one image — make it
   screenshot #1.
2. **A level-2 hint** in the transcript, the one that names a problem the student solved.
3. **The depth meter after a failed submission**, showing it jumped to diagnosis on its own.
4. **The consent screen in the popup**, with the code toggle off. Shows the privacy posture
   before anyone has to ask.
5. **The sync screen mid-run**, with progress and counts.

Use a real account with real solved problems — a screenshot full of placeholder text reads as
a mock and invites reviewer suspicion. Crop to the panel plus enough of the LeetCode page for
context. Do not include your token, your email, or the browser profile name.

---

## Privacy practices

### Single purpose description

```
Recall is a tutoring tool for a single site, leetcode.com. It reads the signed-in user's own LeetCode submission history, builds a model of which problem-solving patterns they already know, and uses that model to give hints on the problem currently open — hints anchored to problems the same user has already solved. Everything the extension does serves that one purpose.
```

### Permission justifications

Paste each into the matching box.

**`storage`**

```
Stores the user's sign-in token for this extension's own backend, their language and consent preferences, and the resumable cursor for the initial history sync so it can continue after a browser restart instead of starting over. Also caches the current tab's problem context so the side panel can redraw without re-fetching. No browsing data is stored.
```

**`tabs`**

```
The side panel must know which tab it is advising and whether that tab is a LeetCode problem page. The extension uses chrome.tabs.query and the onActivated/onUpdated/onRemoved events to track that, chrome.tabs.sendMessage and chrome.tabs.connect to talk to its own content script on that tab, chrome.tabs.create to open a problem the user clicks in the panel, and chrome.tabs.reload for the "reload this tab" recovery prompt. The extension never reads tab URLs other than to check whether the active tab is a leetcode.com problem page.
```

**`sidePanel`**

```
The entire tutoring interface is a side panel: the skill summary, the related problems from the user's own history, and the hint conversation. It is shown alongside the LeetCode problem so the user does not lose the editor. chrome.sidePanel.open and setPanelBehavior are used to open it from the toolbar icon.
```

**`alarms`**

```
A verdict captured while the network is down is queued locally and retried. A one-minute alarm drains that queue. An alarm is required because a Manifest V3 service worker is terminated when idle and a setTimeout would not survive. The alarm does no work other than retrying the extension's own failed uploads.
```

**Host permission — `https://leetcode.com/*`**

```
This is the site the extension tutors. Content scripts run only on https://leetcode.com/problems/* to read the problem being solved, read the user's own code from the editor when they have turned that on, and detect when the user submits so the resulting verdict can be recorded. The extension also calls LeetCode's own GraphQL and submissions endpoints, in the user's existing signed-in session, to read that user's own solved list and submission history during the one-time sync.
```

**Host permission — `https://anchor-production-1dea.up.railway.app/*`**

```
This is the extension's own backend. It stores the user's skill model and serves the hints. It is the only server the extension contacts. The extension sends it the user's LeetCode submission metadata, the problem currently open, and the message the user typed; it returns one hint. No third-party server is contacted from the extension.
```

### Remote code

Select: **No, I am not using remote code.**

```
All logic ships inside the package. The extension does not load or execute any script from a remote source, and uses no eval or new Function.
```

### Data usage — tick these

| Category | Tick? | Because |
|---|---|---|
| Personally identifiable information | **Yes** | the user's LeetCode username is stored |
| Authentication information | **Yes** | the sign-in token for the extension's own backend is stored locally and sent to it |
| Website content | **Yes** | problem text, the user's submission history, and — only with consent — their source code |
| User activity | **Yes** | which problems were submitted and when, and the hint conversation |
| Health information | No | |
| Financial and payment information | No | |
| Personal communications | No | |
| Location | No | |
| Web history | No | the extension never reads browsing history |

### Certifications — tick all three

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

All three are true of Recall as built.

---

## Privacy policy (host this)

**Already hosted.** Paste this into the dashboard's Privacy policy URL field:

```
https://nofriction.netlify.app/privacy/
```

The page lives at `web/public/privacy/index.html` and deploys with the rest of the site. The
contact address on it is `gauravgives@gmail.com` — change it there if you would rather publish
a role address. The source text is kept below so the policy can be reviewed and edited in one
place.

```markdown
# Privacy Policy — Recall for LeetCode

Last updated: [DATE]

Recall is a tutoring extension for leetcode.com. This policy explains exactly what it reads,
what it stores, and what it never touches.

## What Recall reads

Only from leetcode.com, and only for the account you are signed into:

- Your public LeetCode username.
- Your list of solved problems, with difficulty and topic tags.
- Your submission history: the verdict (Accepted, Wrong Answer, Time Limit Exceeded and so
  on), the timestamp, the language, and for failed submissions the failing test case and
  error message.
- The text of the problem currently open, so hints can refer to it.
- **Only if you turn on the code sharing setting**, which is off by default: the source code
  of your failed and first-accepted submissions, and the code in your editor at the moment
  you ask for a hint.
- The messages you type into the tutor.

## What Recall never reads

- Your LeetCode password. It is never seen, never stored, never transmitted.
- Your LeetCode session cookies. They stay in your browser. Recall calls LeetCode from inside
  your own browser session and the extension's server never receives them.
- Any other website. Content scripts run only on `https://leetcode.com/problems/*`.
- Your browsing history, bookmarks, downloads, or anything outside LeetCode.

## Where it is stored

On a private server operated by the developer, in a database only the developer can access.
Your rows are keyed to your account and are never combined with another user's.

Your sign-in token, your preferences and the sync progress are stored locally in your browser
and are not readable by any website.

## How hints are generated

When you ask for a hint, the relevant context — the problem, the related problems from your
own history, your latest verdict, and your message — is sent to a large language model API
(Google Gemini, or Anthropic) under a paid commercial agreement. Under those agreements your
data is not used to train models. No other third party receives any of your data.

## What is never done

- Your data is never sold.
- Your data is never transferred to a third party, except the language model API above, which
  is required to produce a hint.
- Your data is never used to assess creditworthiness or for lending.
- Your data is never used for advertising.
- Your data is never used for any purpose other than tutoring you.

## Your control

- **Code sharing is off by default.** Recall works without it. Turning it off later erases
  every piece of source code already stored, immediately.
- **Delete everything.** "Delete my data" in the extension popup removes every record Recall
  holds about you — history, skill model, and hint conversations — in one action. It cannot
  be undone.
- **Stop at any time.** Uninstalling the extension stops all collection. Use the delete
  button first if you also want the stored data gone.

## Children

Recall is not directed at children under 13 and is not knowingly used by them.

## Changes

Material changes to this policy will be published at this URL with an updated date.

## Contact

[YOUR CONTACT EMAIL]
```

---

## Notes for the reviewer

Paste into the private "Notes to reviewer" field. **Replace the bracketed values with a real
working account before submitting** — this is blocker #2.

```
Thank you for reviewing. Recall needs two sign-ins to be testable, so here is a working setup.

WHY A SIGN-IN IS NEEDED
Recall tutors a specific user based on that user's own LeetCode submission history. With no
account and no history there is nothing for it to anchor a hint to, so the interface will
correctly report that it has nothing to work from.

TEST ACCOUNT FOR THE EXTENSION
  1. Go to https://nofriction.netlify.app
  2. Sign in with: [TEST EMAIL] / [TEST PASSWORD]
  3. Click the "Connect to ext" button. It copies a token to the clipboard.
  4. Open the Recall popup and paste the token into the token field, then Save.

LEETCODE ACCOUNT
  Sign in to https://leetcode.com with: [TEST LEETCODE USER] / [TEST LEETCODE PASSWORD]
  This account already has solved problems, so the sync has real data to read.

STEPS TO SEE IT WORK
  1. With both signed in, open any LeetCode problem, for example
     https://leetcode.com/problems/coin-change/
  2. Open the Recall side panel from the toolbar icon.
  3. Click "Sync my history" and wait. It reads the account's history at one request per
     second. For this test account it takes about [N] minutes. It is resumable — closing the
     panel and reopening it continues where it left off.
  4. When the sync finishes, the panel shows related problems from that account's own history.
  5. Type a sentence about your approach and send it. The first hint comes back at level 1;
     stating a plan raises it to level 2, which cites a problem the account already solved.

NOTES
  - Code sharing is OFF by default. The extension works without it. You can turn it on in the
    popup to see the consent flow.
  - "Delete my data" in the popup wipes the account's stored data. Please feel free to use it.
  - The extension contacts exactly two hosts: leetcode.com (in your own session) and its own
    backend at anchor-production-1dea.up.railway.app. The backend hostname still carries the
    project's former name, "anchor"; the extension was renamed to Recall and the server was
    left in place so existing installs keep working.
  - Hints are produced by a language model through a paid API. No third party other than that
    API provider receives any data.
  - There is no remote code: every script is in the package, and there is no eval.
```

---

## Rejection risks, honestly

Ranked by how likely they are to actually bite.

**1. Reviewer cannot test it.** Highest risk by far. Two sign-ins and a multi-minute sync
stand between the reviewer and any visible functionality. Without working credentials this
gets rejected as non-functional. Mitigation: blocker #2, and make sure the test LeetCode
account has enough solved DP problems that anchors actually appear.

**2. "LeetCode" in the extension name.** The "X for Y" form is normally accepted, and the
listing states plainly that Recall is unaffiliated. There is still some chance a reviewer
asks you to rename. If that happens, `Recall — Tutor for Coding Practice` keeps the brand and
drops the trademark. Note LeetCode itself could also object independently of Google.

**3. Broad host permission on leetcode.com.** `https://leetcode.com/*` is wider than the
content scripts, which only match `/problems/*`. It is genuinely needed, because the sync
calls `/graphql/` and `/api/submissions/`, and the justification says so. A reviewer may
still query it.

**4. Data disclosure mismatch.** If the ticked categories do not match what the privacy
policy says, that is an automatic rejection. The table above and the policy were written
together and agree — keep them in sync if you edit either.

**5. The backend hostname still says "anchor".** Harmless but it looks inconsistent with a
listing called Recall. The reviewer note explains it. If you would rather it match, rename
the Railway service — but that changes the URL, so the manifest and `config.js` must be
updated and the extension re-packaged and re-submitted.

---

## Final checklist

- [x] Privacy policy hosted — `https://nofriction.netlify.app/privacy/`
- [ ] Privacy policy URL pasted into the dashboard
- [ ] Reviewer test accounts created and real credentials in the notes
- [ ] Test LeetCode account has solved DP problems, so anchors actually show
- [ ] 1–5 screenshots at 1280×800, no token or email visible
- [ ] Zip built with the command above, `dev/` excluded
- [ ] `config.js` has `ENV = 'production'`
- [ ] `manifest.json` version matches the zip you are uploading
- [ ] Backend is awake and `/health` returns ok — a cold or sleeping server during review
      looks like a broken extension
- [ ] `LC_MIN_EXTENSION_VERSION` on the server is not above the version you are submitting,
      or every reviewer request gets a 426 and the extension appears broken
- [ ] Decide on `LC_PILOT_USER_IDS`: it is currently unset, which means open to every user.
      If you set it to lock down the pilot, the reviewer's account must be on the list
