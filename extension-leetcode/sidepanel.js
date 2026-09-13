// Anchor side panel (ES module). Requires config.js and anchor-setup.js (classic
// scripts) to have run first.
//
// Owns: the view state machine (NO_TOKEN -> SERVER_WAKING -> UPDATE_REQUIRED ->
// NO_PROFILE -> SYNCING -> NOT_LC_TAB / NON_PROBLEM_PAGE / CONTEST_LOCKED ->
// PROBLEM -> TUTOR_UNAVAILABLE), the first-run sync driver over the 'anchor-sync'
// Port, and the chat UI. Every backend call goes through api.js from this page;
// the leetcode.com origin never talks to the API.
//
// Every string that reaches the DOM goes through textContent or markdown.js.
// No file in this folder assigns a markup string to the DOM.
import * as api from './api.js';
import { renderModelText, renderInline } from './markdown.js';

function fatal(message) {
  document.body.textContent = '';
  const p = document.createElement('p');
  p.className = 'error';
  p.textContent = message;
  document.body.appendChild(p);
  throw new Error(message);
}

if (!globalThis.AnchorExt) fatal('Extension failed to load. Reload it from chrome://extensions.');
if (!globalThis.ANCHOR_CONFIG?.API_BASE) fatal('Config not available.');

const Ext = globalThis.AnchorExt;
const CFG = globalThis.ANCHOR_CONFIG;

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------
const LC_ORIGIN = 'https://leetcode.com/';
const PROBLEM_URL_RE = /^https:\/\/leetcode\.com\/problems\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[/?#]|$)/;
const CONTEST_URL_RE = /^https:\/\/leetcode\.com\/contest\//;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const STATUS_MS = 2500;
const RECOMPUTE_TICK_MS = 60000;
const HEALTH_FRESH_MS = 60000;
const WAKE_POLL_MS = 5000;
const WAKE_MAX_MS = 90000;
const ME_FRESH_MS = 30000;
const ANCHORS_TTL_MS = 10 * 60 * 1000;
const WHOAMI_TTL_MS = 5 * 60 * 1000;
const CHAT_TIMEOUT_MS = Number(CFG.CHAT_TIMEOUT_MS) > 0 ? Number(CFG.CHAT_TIMEOUT_MS) : 60000;
const GET_CODE_TIMEOUT_MS = 1500;
const PING_TIMEOUT_MS = 1000;
const WHOAMI_TIMEOUT_MS = 8000;
const FETCH_PROBLEM_TIMEOUT_MS = 20000;
const MANUAL_CAPTURE_TIMEOUT_MS = 30000;
const SYNC_BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];
const SYNC_CHUNK_ROWS = Number(CFG.CHUNK_SUBS) > 0 ? Number(CFG.CHUNK_SUBS) : 200;
const SYNC_MAX_SOLVED = 1000;
const SYNC_REQUEST_MS = Number(CFG.LC_RATE_MS) > 0 ? Number(CFG.LC_RATE_MS) : 1000;
const SYNC_REST_PAGE = 20;
const SYNC_LIST_PAGE = 100;
const CONSENT_VERSION = '1';
const MAX_HABITS_SHOWN = 4;
const ISSUE_TEXT_MAX = 1000; // the server caps the whole client-event payload at 4096 UTF-8 bytes

// The panel never offers a depth control. It shows the depth the SERVER returned,
// as dots plus a word, so the meaning is never in shape or colour alone.
const DEPTH_DOTS = { 1: '●○○', 2: '●●○', 3: '●●●', 4: '●●●' };
const DEPTH_WORD = {
  english: { 1: 'nudge', 2: 'from your history', 3: 'pinpoint', 4: 'the shape' },
  hinglish: { 1: 'ishaara', 2: 'tumhari history se', 3: 'theek jagah', 4: 'shape' }
};
// Dev-only label, restored on every bubble when CFG.ENV !== 'production'.
const DEV_DEPTH_LABEL = { 1: 'Nudge', 2: 'Anchor', 3: 'Pinpoint', 4: 'Show' };
// data.family is only ever 'dp' or 'graph' (domain/seed.js familiesOf). The anchor
// `why` string is NEVER rendered here: it names the state formulation, which is the
// answer to the rung-2 question. Coarse family line only.
const FAMILY_LINE = {
  english: { dp: 'Both are DP problems.', graph: 'Both are graph problems.' },
  hinglish: { dp: 'Dono DP problems hain.', graph: 'Dono graph problems hain.' }
};
const STALL_MS = 75000;
const GATE_MIN_CHARS = 25;
const SILENCE_MS = 10 * 60 * 1000;
const RECENT_FAIL_MS = 30 * 60 * 1000;
const HINT_TO_AC_MS = 10 * 60 * 1000;
const HINTS_LEFT_NOTE_AT = 5;
const REPEAT_SIMILARITY = 0.8;

// ---- motion -----------------------------------------------------------------
// The JS mirror of the CSS custom properties in sidepanel.css. WAAPI needs
// numbers, not var(); this pairing is the one duplication in the system and
// must be kept in sync by hand.
const MOTION = {
  d1: 120,
  d2: 180,
  d3: 260,
  d4: 420,
  rise: 4,
  riseLg: 6,
  easeOut: "cubic-bezier(0.22,0.61,0.36,1)",
  easeIn: "cubic-bezier(0.55,0.06,0.68,0.19)",
  easeSoft: "cubic-bezier(0.4,0,0.2,1)"
};
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const canMove = () => !reduceMotion.matches && document.visibilityState === "visible";
const PROGRESS_MAX_LINES = 5;
const LONG_WAIT_MS = 8000;   // p95 is 5.1s: past 8s "longer than usual" is true
const PROBE_AT_MS = 6000;
const COLD_DECIDE_MS = 9000;
const SETTLE_MIN_MS = 600;   // below this an exit animation IS most of the wait
const LANG_NAME = {
  cpp: "C++", java: "Java", python3: "Python", python: "Python",
  javascript: "JavaScript", typescript: "TypeScript", golang: "Go",
  rust: "Rust", c: "C", csharp: "C#", kotlin: "Kotlin", swift: "Swift"
};
// A typed ask for the most explicit help. Matching opens the gate form; it never
// sends requested_rung 4 by itself. Hinglish arms included.
const RUNG4_INTENT = [
  /\b(show|give|tell)\s+(me\s+)?(the\s+)?(answer|solution|code|skeleton|structure|pseudo(code)?)\b/i,
  /\b(skeleton|pseudocode|blank(ed)? (lines|code)|lay it out)\b/i,
  /\b(bata|dikha|de)\s*do\b/i,
  /\bseedha\b/i
];
// Near-miss logging while the server's own rung4Ready holds, and the trigger for
// the one-line refusal under a reply.
const BEG_RE = /\b(answer|solution|give\s*up)\b/i;
// The exact strings the affordance slot ever sends on the student's behalf. They
// are in the backend plan stoplist, so a tap can never set a plan.
const STALL_STRINGS = {
  stuck: 'I am still stuck.',
  failed: 'That run failed — what broke?'
};
const ORDINAL_WORD = {
  english: { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh', 8: 'eighth', 9: 'ninth', 10: 'tenth' },
  hinglish: { 1: 'pehla', 2: 'doosra', 3: 'teesra', 4: 'chautha', 5: 'paanchva', 6: 'chhatha', 7: 'saatva', 8: 'aathva', 9: 'nauva', 10: 'dasva' }
};
const COUNT_WORD = {
  english: { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten' },
  hinglish: { 1: 'ek', 2: 'do', 3: 'teen', 4: 'chaar', 5: 'paanch', 6: 'chhe', 7: 'saat', 8: 'aath', 9: 'nau', 10: 'das' }
};
const VERDICT_LABEL = {
  10: 'Accepted',
  11: 'Wrong Answer',
  12: 'Memory Limit',
  13: 'Output Limit',
  14: 'Time Limit',
  15: 'Runtime Error',
  16: 'Internal Error',
  20: 'Compile Error',
  21: 'Unknown Error',
  50: 'Not counted'
};
const PHASE_LABEL = {
  whoami: 'Checking your LeetCode login',
  solved: 'Reading your solved list',
  skills: 'Reading tag statistics',
  sweep: 'Sweeping your submissions',
  details: 'Fetching judge details for failed attempts',
  final: 'Wrapping up',
  finalize: 'Building your map on the server',
  done: 'Done'
};
const PAUSE_COPY = {
  lc_logged_out: 'LeetCode signed you out. Sign in on the LeetCode tab, then click Resume.',
  challenge: 'LeetCode is showing a verification page. Pass the check in that tab, then click Resume.',
  rate_limited: 'LeetCode is rate-limiting requests. Wait a minute, then click Resume.',
  hidden: 'The sync waits while the LeetCode tab is hidden. Switch back to that tab.',
  backend: "Anchor's server could not take the last chunk. Click Resume to retry.",
  user: 'Sync paused. Click Resume to continue.',
  disconnected: 'Lost the connection to the LeetCode tab. Reload that tab (or open a problem page), then click Resume.',
  stopped: 'Sync cancelled.'
};
const SYNC_ERROR_COPY = {
  sync_busy: 'A sync is already running in this tab.',
  sync_owned_elsewhere: 'Another LeetCode tab is already syncing. Use that tab, or wait 30 seconds and retry here.',
  storage_unavailable: 'The LeetCode tab lost its extension context. Reload that tab and click Resume.',
  list_unusable: 'LeetCode ignored the solved filter. Sign in again on the LeetCode tab, then Resume.'
};

// ---------------------------------------------------------------------------
// DOM helpers (createElement / textContent only)
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---- motion helpers ---------------------------------------------------------

// A one-shot enter. fill:"backwards" is what makes this safe: the resting state
// in CSS is never touched, so an animation that is cancelled or never runs at
// all still leaves correct UI. Returns the Animation so callers can cancel it.
function enter(node, o = {}) {
  if (!node || !canMove() || typeof node.animate !== 'function') return null;
  const y = o.y === undefined ? MOTION.rise : o.y;
  const anim = node.animate(
    [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }],
    { duration: o.dur === undefined ? MOTION.d3 : o.dur, delay: o.delay || 0, easing: MOTION.easeOut, fill: 'backwards' }
  );
  if (problem && Array.isArray(problem.anims)) problem.anims.push(anim);
  return anim;
}

// Run fn once, on whichever of transitionend or the timeout fires first.
// Never rely on transitionend alone: under reduced motion the duration is 0
// and the event may never fire at all.
function exitThen(node, ms, fn) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    node.removeEventListener('transitionend', finish);
    fn();
  };
  node.addEventListener('transitionend', finish);
  setTimeout(finish, ms + 60);
}

// The style flush for class-driven staggers. Deliberately not rAF: rAF does
// not fire while the panel is hidden, and an element whose visibility depends
// on a rAF callback is a permanent-invisibility bug.
function flush(node) {
  void node.offsetHeight;
}

function atBottom() {
  if (!els.view) return true;
  return els.view.scrollHeight - els.view.scrollTop - els.view.clientHeight < 24;
}

// Content inserted ABOVE the reading position is compensated so the eye stays
// still; content appended at the bottom follows only if we were already there.
function preserveScroll(mutate) {
  if (!els.view) {
    mutate();
    return;
  }
  const pinned = atBottom();
  const before = els.view.scrollHeight;
  mutate();
  if (pinned) scrollTranscript();
  else els.view.scrollTop += els.view.scrollHeight - before;
}

// Content that arrives unprompted while the student is reading further up is
// OFFERED, never scrolled to. Yanking the viewport mid-sentence to show a
// verdict they did not ask to see is the rudest thing the panel could do.
function showNewBelow(text) {
  if (!problem.refs || !els.view) return;
  hideNewBelow();
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'new-below';
  node.textContent = text;
  node.addEventListener('click', () => {
    els.view.scrollTo({ top: els.view.scrollHeight, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    hideNewBelow();
  });
  els.view.appendChild(node);
  problem.newBelowNode = node;
  enter(node, { y: MOTION.riseLg, dur: 220 });
  if (!problem.newBelowWatch) {
    problem.newBelowWatch = () => {
      if (problem.newBelowNode && atBottom()) hideNewBelow();
    };
    els.view.addEventListener('scroll', problem.newBelowWatch, { passive: true });
  }
}

function hideNewBelow() {
  if (problem.newBelowNode) {
    problem.newBelowNode.remove();
    problem.newBelowNode = null;
  }
  if (problem.newBelowWatch && els.view) {
    els.view.removeEventListener('scroll', problem.newBelowWatch);
    problem.newBelowWatch = null;
  }
}

function tpl(id) {
  const template = $(id);
  if (!template || !template.content || !template.content.firstElementChild) fatal(`Template ${id} missing.`);
  return template.content.firstElementChild.cloneNode(true);
}

function refsOf(root) {
  const out = {};
  root.querySelectorAll('[data-role]').forEach((node) => {
    if (!out[node.dataset.role]) out[node.dataset.role] = node;
  });
  return out;
}

function show(node, visible) {
  if (node) node.classList.toggle('hidden', !visible);
}

function button(className, label, onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// An inline <a> inside prose: a real href so middle-click works, and a click
// handler so the panel opens the tab itself.
function anchorLink(text, url, title) {
  const a = el('a', null, text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  if (title) a.title = title;
  a.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    chrome.tabs.create({ url });
  });
  return a;
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(label) {
  const err = new Error(`${label} timed out`);
  err.code = 'timeout';
  return err;
}

function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(label)), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

// Semver-ish: numeric segments compared left to right, missing segments are 0.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((s) => parseInt(s.replace(/\D.*$/, ''), 10) || 0);
  const pb = String(b || '').split('.').map((s) => parseInt(s.replace(/\D.*$/, ''), 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isLcUrl(url) {
  return typeof url === 'string' && url.startsWith(LC_ORIGIN);
}

function slugFromUrl(url) {
  const match = typeof url === 'string' ? PROBLEM_URL_RE.exec(url) : null;
  return match ? match[1] : null;
}

function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRelative(value, now) {
  const ts = parseTime(value);
  if (ts === null) return 'never';
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatCount(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString() : '0';
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'almost done';
  if (seconds < 60) return 'under a minute left';
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} min left`;
}

function verdictLabel(statusCode, statusMsg) {
  const code = Number(statusCode);
  return VERDICT_LABEL[code] || statusMsg || (Number.isFinite(code) ? `status ${code}` : 'unknown');
}

// "14 Mar 2025". Forced locale so two students never read different dates.
function formatDay(value) {
  const ts = parseTime(value);
  if (ts === null) return '';
  try {
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function ordinalWord(n, language) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return '';
  const table = ORDINAL_WORD[language] || ORDINAL_WORD.english;
  return table[v] || `${v}th`;
}

function countWord(n, language) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return '';
  const table = COUNT_WORD[language] || COUNT_WORD.english;
  return table[v] || String(v);
}

function bucketText(bucket) {
  return bucket ? String(bucket).replace(/_/g, ' ') : '';
}

// Cheap token overlap; the proxy for "the student just said that again".
function similarity(a, b) {
  const tokens = (s) => new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

function capitalize(text) {
  const s = String(text || '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function chunksOf(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Mirrors domain/policy.js decideRung().allowed_rung_next for facts the panel knows.
function estimateAllowedRung({ planStated, submissionsHere, turns }) {
  let max = 1;
  if (planStated) max = 2;
  if (submissionsHere >= 1 || turns >= 3) max = Math.max(max, 3);
  const rung4Ready = submissionsHere >= 2 || turns >= 5;
  return rung4Ready ? 4 : max;
}

function estimateUnlockReason({ planStated, submissionsHere, turns }) {
  let unlock = 'state_a_plan';
  if (planStated) unlock = 'submit_once';
  if (submissionsHere >= 1 || turns >= 3) unlock = 'ask_for_rung_4';
  if (submissionsHere >= 2 || turns >= 5) unlock = 'ask_for_rung_4';
  return unlock;
}

// Remaining LeetCode requests, estimated from what the sync has seen so far.
function estimateSyncRemaining(phase, counts, detailsCap) {
  const solved = Number(counts && counts.solved) || 0;
  const subs = Number(counts && counts.subs) || 0;
  const details = Number(counts && counts.details) || 0;
  const planned = Number(counts && counts.detailsPlanned) || 0;
  const subsEstimate = Math.max(subs, Math.round(solved * 2.8), 40);
  const solvedPages = Math.ceil(Math.max(solved, SYNC_LIST_PAGE) / SYNC_LIST_PAGE);
  const sweepRemaining = Math.max(0, Math.ceil((subsEstimate - subs) / SYNC_REST_PAGE));
  const detailsEstimate = Math.min(detailsCap || 300, Math.round(subsEstimate * 0.35));
  switch (phase) {
    case 'whoami':
    case null:
    case undefined:
      return 1 + solvedPages + 2 + sweepRemaining + detailsEstimate + 1;
    case 'solved':
      return solvedPages + 2 + sweepRemaining + detailsEstimate + 1;
    case 'skills':
      return 2 + sweepRemaining + detailsEstimate + 1;
    case 'sweep':
      return sweepRemaining + detailsEstimate + 1;
    case 'details':
      return Math.max(0, (planned || detailsEstimate) - details) + 1;
    case 'final':
    case 'finalize':
      return 1;
    default:
      return 0;
  }
}

function syncFraction(phase, counts) {
  const solved = Number(counts && counts.solved) || 0;
  const subs = Number(counts && counts.subs) || 0;
  const details = Number(counts && counts.details) || 0;
  const planned = Number(counts && counts.detailsPlanned) || 0;
  const subsEstimate = Math.max(subs, Math.round(solved * 2.8), 40);
  switch (phase) {
    case 'whoami': return 0.02;
    case 'solved': return 0.05;
    case 'skills': return 0.09;
    case 'sweep': return 0.1 + 0.5 * Math.min(1, subs / subsEstimate);
    case 'details': return 0.6 + 0.37 * (planned > 0 ? Math.min(1, details / planned) : 1);
    case 'final': return 0.97;
    case 'finalize': return 0.98;
    case 'done': return 1;
    default: return 0;
  }
}

function countsFromStored(stored) {
  if (!stored) return null;
  const header = stored.header || {};
  const sweep = stored.sweep || {};
  const details = stored.details || {};
  const planned = Array.isArray(details.planned) ? details.planned.length : 0;
  return {
    solved: Number(header.solvedCount) || 0,
    subs: Number(sweep.count) || 0,
    details: Number(details.done) || 0,
    detailsPlanned: Math.min(planned, Number(stored.detailsCap) || planned),
    backlog: Array.isArray(stored.backlog) ? stored.backlog.length : 0
  };
}

// lc-sync.js state that still needs driving: anything not finalized by this panel,
// not cancelled, and not in the initial idle state.
function syncInProgress(stored, cancelledId) {
  if (!stored || stored.version !== 1 || !stored.sync_id) return false;
  if (stored.finalized === true) return false;
  if (cancelledId && stored.sync_id === cancelledId) return false;
  if (stored.state === 'paused' && stored.reason === 'stopped') return false;
  return true;
}

function captureStateOf(ctx) {
  if (!ctx) return { state: 'unknown', reason: null };
  if (ctx.needsReload) return { state: 'off', reason: 'reload' };
  const capture = ctx.capture;
  if (!capture) return { state: ctx.slug ? 'waiting' : 'unknown', reason: null };
  const raw = typeof capture === 'string'
    ? capture
    : capture.state || capture.capture || (capture.active === true ? 'active' : capture.active === false ? 'disabled' : '');
  if (raw === 'active' || raw === 'ready' || raw === 'on') return { state: 'on', reason: null };
  if (raw === 'disabled' || raw === 'off' || raw === 'error') {
    return { state: 'off', reason: typeof capture === 'object' && capture.reason ? String(capture.reason) : null };
  }
  return { state: 'waiting', reason: null };
}

// Content-script replies may be {ok, key} / {ok, data:{key}} / {ok, payload:{key}}.
function unwrap(reply, key) {
  if (!reply || typeof reply !== 'object') return null;
  if (reply[key] !== undefined) return reply[key];
  if (reply.data && typeof reply.data === 'object' && reply.data[key] !== undefined) return reply.data[key];
  if (reply.payload && typeof reply.payload === 'object' && reply.payload[key] !== undefined) return reply.payload[key];
  if (reply.result && typeof reply.result === 'object' && reply.result[key] !== undefined) return reply.result[key];
  return null;
}

function lcErrorCode(reply) {
  if (!reply || typeof reply !== 'object' || reply.ok !== false) return null;
  const err = reply.error;
  if (!err) return 'unknown';
  if (typeof err === 'string') return err;
  return err.code || 'unknown';
}

function mapSolvedRow(row) {
  return {
    slug: row.slug,
    title: row.title || null,
    frontend_id: row.frontendId === undefined ? row.frontend_id : row.frontendId,
    difficulty: row.difficulty || null,
    tags: Array.isArray(row.tags) ? row.tags : [],
    paid: row.paidOnly === true || row.paid === true
  };
}

function mapSubmissionRow(item) {
  return {
    id: item.id,
    slug: item.slug,
    status_code: item.status_code,
    status_msg: item.status_msg,
    lang: item.lang,
    timestamp: item.timestamp,
    code: typeof item.code === 'string' ? item.code : undefined
  };
}

function mapDetailRow(d) {
  const { code, ...details } = d;
  return {
    id: d.submission_id,
    slug: d.slug,
    status_code: d.status_code,
    status_msg: d.status_msg === undefined ? null : d.status_msg,
    lang: d.lang,
    timestamp: d.timestamp,
    details,
    code: typeof code === 'string' ? code : undefined
  };
}

function buildManualAttempt(slug, submission, details, consent, nowSeconds) {
  const d = details && typeof details === 'object' ? details : {};
  const body = {
    ...d,
    submission_id: Number(submission.id),
    title_slug: slug,
    captured_via: 'manual',
    status_code: submission.status_code !== undefined && submission.status_code !== null ? submission.status_code : d.status_code,
    status_msg: submission.status_msg || null,
    lang: submission.lang || d.lang || null,
    timestamp: submission.timestamp || d.timestamp || nowSeconds
  };
  delete body.slug;
  delete body.code;
  const code = typeof d.code === 'string' && d.code ? d.code : typeof submission.code === 'string' ? submission.code : null;
  if (consent && code) body.code = code;
  return body;
}

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------
async function getLocal(key) {
  try {
    const stored = await chrome.storage.local.get([key]);
    return stored[key];
  } catch (_) {
    return undefined;
  }
}

async function setLocal(patch) {
  try {
    await chrome.storage.local.set(patch);
  } catch (_) {
    // storage unavailable: nothing to do
  }
}

async function removeLocal(key) {
  try {
    await chrome.storage.local.remove([key]);
  } catch (_) {
    // ignore
  }
}

function ctxKey(tabId) {
  return `tab:${tabId}`;
}

async function getCtx(tabId) {
  if (tabId === null || tabId === undefined) return null;
  try {
    const key = ctxKey(tabId);
    const stored = await chrome.storage.session.get([key]);
    return stored[key] || null;
  } catch (_) {
    return null;
  }
}

async function mergeCtx(tabId, patch) {
  if (tabId === null || tabId === undefined) return;
  try {
    const key = ctxKey(tabId);
    const current = (await chrome.storage.session.get([key]))[key] || {};
    await chrome.storage.session.set({ [key]: { ...current, ...patch } });
  } catch (_) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// tabs + content-script messaging
// ---------------------------------------------------------------------------
async function activeTab() {
  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab || null;
  } catch (_) {
    return null;
  }
}

function tabCall(tabId, type, payload, timeoutMs) {
  const message = { type, ...(payload || {}) };
  const send = chrome.tabs.sendMessage(tabId, message).catch((err) => {
    const wrapped = new Error((err && err.message) || 'no receiver');
    wrapped.code = 'no_receiver';
    throw wrapped;
  });
  return withTimeout(send, timeoutMs, type);
}

// ---------------------------------------------------------------------------
// page state
// ---------------------------------------------------------------------------
const els = {
  subtitle: $('subtitle'),
  captureDot: $('captureDot'),
  captureLabel: $('captureLabel'),
  banners: $('banners'),
  view: $('view'),
  status: $('status'),
  issueForm: $('issueForm'),
  issueText: $('issueText'),
  issueCancel: $('issueCancel'),
  issueSend: $('issueSend'),
  footVersion: $('footVersion'),
  footSync: $('footSync'),
  reportIssue: $('reportIssue')
};

const state = {
  tokenExpired: false,
  consentChecked: false,
  view: null,          // rendered view name
  viewKey: null,       // rendered view identity (e.g. PROBLEM:<tabId>:<slug>)
  viewRefs: null,
  lastNext: null,
  language: 'english'  // mirrored from chrome.storage.local so render paths stay sync
};

// The hint language (set once in the popup; this panel only reads it).
function lang() {
  return state.language === 'hinglish' ? 'hinglish' : 'english';
}

// Hinglish where the spec lists a string, English for everything it does not.
function pick(english, hinglish) {
  return lang() === 'hinglish' && hinglish ? hinglish : english;
}

const health = { data: null, okAt: 0, wakingSince: 0, pollTimer: null };
let meCache = { result: null, at: 0 };

const banners = {
  waking: false,
  lc_logged_out: false,
  rate_limited: false,
  challenge: false,
  reload_tab: false,
  capture_off: null,   // null | reason string
  degraded: false,
  sync: null           // { text } while SYNCING is paused / errored
};

let statusTimer = null;
let computeTimer = null;
let computing = false;
let computeAgain = false;

// ---------------------------------------------------------------------------
// status, theme, language, header
// ---------------------------------------------------------------------------
function setStatus(message, tone = 'info') {
  els.status.textContent = message || '';
  els.status.dataset.tone = tone;
  if (message) {
    els.status.classList.remove("is-in");
    void els.status.offsetWidth;
    els.status.classList.add("is-in");
  }
  clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      els.status.textContent = '';
      els.status.dataset.tone = '';
    }, tone === 'error' ? STATUS_MS * 2 : STATUS_MS);
  }
}

function applyTheme(theme) {
  document.body.classList.remove('theme-light', 'theme-dark');
  if (theme === 'light') document.body.classList.add('theme-light');
  if (theme === 'dark') document.body.classList.add('theme-dark');
}

function setSubtitle(text) {
  const next = text || 'for LeetCode';
  if (els.subtitle.textContent === next) return;
  if (!canMove()) {
    els.subtitle.textContent = next;
    return;
  }
  els.subtitle.classList.add("is-swapping");
  exitThen(els.subtitle, MOTION.d1, () => {
    els.subtitle.textContent = next;
    els.subtitle.classList.remove("is-swapping");
  });
}

function renderCaptureDot(ctx) {
  const capture = captureStateOf(ctx);
  let cls = 'conn-dot';
  let title = 'Live capture: no problem open';
  if (capture.state === 'on') {
    cls += ' connected';
    title = 'Live capture on: verdicts are recorded automatically';
  } else if (capture.state === 'off') {
    cls += ' invalid';
    title = capture.reason === 'reload'
      ? 'Live capture off: reload the LeetCode tab'
      : `Live capture off${capture.reason ? ` (${capture.reason})` : ''}: use "Check my last run"`;
  } else if (capture.state === 'waiting') {
    cls += ' waking';
    title = 'Live capture: waiting for the page';
  }
  els.captureDot.className = cls;
  els.captureDot.title = title;
  // The state is never colour-only: the dot carries the same words as text.
  els.captureDot.setAttribute('aria-label', title);
  if (els.captureLabel) els.captureLabel.textContent = title;
}

// ---------------------------------------------------------------------------
// banners
// ---------------------------------------------------------------------------
function makeBanner(tone, text, action) {
  const node = el('div', `banner ${tone}`);
  node.appendChild(el('span', 'banner-text', text));
  if (action) node.appendChild(button('btn tiny', action.label, action.onClick));
  return node;
}

// Banner kinds currently on screen; a hidden -> visible transition posts one banner_shown client event.
const bannersVisible = new Set();

function renderBanners() {
  clear(els.banners);
  const list = [];
  const kinds = [];
  const push = (kind, node) => { kinds.push(kind); list.push(node); };
  if (banners.sync) push('sync', makeBanner('warn', banners.sync.text, banners.sync.action || null));
  if (banners.waking) push('waking', makeBanner('info', 'Waking the server. Hints may take a moment.'));
  if (banners.lc_logged_out) {
    push('lc_logged_out', makeBanner('warn', 'You are signed out of LeetCode. Sign in on the LeetCode tab.', {
      label: 'Check again',
      onClick: () => {
        if (problem.tabId !== null) checkWhoami(problem.tabId, problem.gen, true);
      }
    }));
  }
  if (banners.challenge) push('challenge', makeBanner('warn', 'LeetCode is showing a verification page. Pass the check in that tab.'));
  if (banners.rate_limited) push('rate_limited', makeBanner('warn', 'LeetCode is rate-limiting requests. Wait a minute before syncing or capturing.'));
  if (banners.reload_tab) {
    push('reload_tab', makeBanner('warn', 'Reload the LeetCode tab so Anchor can connect to it.', {
      label: 'Reload',
      onClick: () => {
        if (problem.tabId !== null) chrome.tabs.reload(problem.tabId).catch(() => {});
      }
    }));
  }
  if (banners.capture_off !== null && !banners.reload_tab) {
    const reason = banners.capture_off ? ` (${banners.capture_off})` : '';
    push('capture_off', makeBanner('info', `Live capture is off in this tab${reason}. Use "Check my last run" after each submit.`));
  }
  if (banners.degraded) push('degraded', makeBanner('info', 'Hints are in fallback mode right now (templated, no AI).'));
  for (const node of list) els.banners.appendChild(node);
  show(els.banners, list.length > 0);
  for (const kind of kinds) {
    if (bannersVisible.has(kind)) continue;
    const detail = { banner: kind };
    if (kind === 'capture_off' && banners.capture_off) detail.reason = banners.capture_off;
    if (kind === 'sync' && sync.reason) detail.reason = sync.reason;
    api.clientEvent('banner_shown', detail).catch(() => {});
  }
  bannersVisible.clear();
  for (const kind of kinds) bannersVisible.add(kind);
}

function resetProblemBanners() {
  banners.lc_logged_out = false;
  banners.rate_limited = false;
  banners.challenge = false;
  banners.reload_tab = false;
  banners.capture_off = null;
  banners.degraded = false;
}

function applyLcErrorCode(code) {
  if (code === 'lc_logged_out') banners.lc_logged_out = true;
  else if (code === 'rate_limited') banners.rate_limited = true;
  else if (code === 'challenge') banners.challenge = true;
  renderBanners();
}

// ---------------------------------------------------------------------------
// health + /me caches
// ---------------------------------------------------------------------------
async function checkHealth(force) {
  const now = Date.now();
  if (!force && health.data && now - health.okAt < HEALTH_FRESH_MS) return { ok: true, data: health.data };
  const result = await api.health();
  if (result.ok && result.data) {
    health.data = result.data;
    health.okAt = Date.now();
    return { ok: true, data: result.data };
  }
  return { ok: false, status: result.status, error: result.error };
}

function armWakePoll() {
  clearTimeout(health.pollTimer);
  health.pollTimer = setTimeout(() => scheduleCompute(0), WAKE_POLL_MS);
}

function invalidateMe() {
  meCache = { result: null, at: 0 };
}

async function mirrorProfile(data) {
  const profile = data && data.profile;
  if (!profile) return;
  const patch = {};
  const stored = await chrome.storage.local.get(['consentCode', 'language']);
  if (typeof profile.consent_code === 'boolean' && stored.consentCode !== profile.consent_code) patch.consentCode = profile.consent_code;
  if ((profile.language === 'english' || profile.language === 'hinglish') && stored.language !== profile.language) patch.language = profile.language;
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function getMe(force) {
  if (!force && meCache.result && Date.now() - meCache.at < ME_FRESH_MS) return meCache.result;
  const result = await api.me();
  if (result.ok) {
    meCache = { result, at: Date.now() };
    mirrorProfile(result.data).catch(() => {});
  } else {
    invalidateMe();
  }
  return result;
}

// ---------------------------------------------------------------------------
// view computation (the state machine)
// ---------------------------------------------------------------------------
function wakingOrUnavailable(reason) {
  const now = Date.now();
  if (!health.wakingSince) health.wakingSince = now;
  if (now - health.wakingSince > WAKE_MAX_MS) return { view: 'TUTOR_UNAVAILABLE', reason };
  armWakePoll();
  return { view: 'SERVER_WAKING', since: health.wakingSince };
}

async function computeView() {
  const token = await Ext.getAuthToken();
  if (!token) return { view: 'NO_TOKEN', expired: state.tokenExpired };

  const h = await checkHealth(Boolean(health.wakingSince));
  if (!h.ok) return wakingOrUnavailable(h.error || `http_${h.status}`);
  const minVersion = h.data && h.data.min_extension_version;
  if (minVersion && compareVersions(CFG.EXT_VERSION, minVersion) < 0) return { view: 'UPDATE_REQUIRED', min: minVersion };

  const me = await getMe(Boolean(health.wakingSince));
  if (!me.ok) {
    if (me.status === 401 || me.error === 'missing_token') {
      if (me.status === 401 && !state.tokenExpired) {
        // Queued in the background: it drains once a new token is pasted.
        chrome.runtime.sendMessage({ type: 'client:event', event: 'token_expired', detail: { view: state.view } }).catch(() => {});
      }
      state.tokenExpired = true;
      return { view: 'NO_TOKEN', expired: true };
    }
    if (me.status === 426) return { view: 'UPDATE_REQUIRED', min: (me.data && me.data.min_extension_version) || minVersion };
    if (me.status === 403) return { view: 'TUTOR_UNAVAILABLE', reason: me.error === 'pilot_closed' ? 'pilot_closed' : 'forbidden' };
    if (me.status === 0 || me.status >= 500) return wakingOrUnavailable(me.error || `http_${me.status}`);
    return { view: 'TUTOR_UNAVAILABLE', reason: me.error || `http_${me.status}` };
  }
  state.tokenExpired = false;
  health.wakingSince = 0;
  clearTimeout(health.pollTimer);
  const meData = me.data || {};

  const stored = await getLocal('syncState');
  if (stored && ((stored.state === 'paused' && stored.reason === 'stopped') || (sync.cancelledId && stored.sync_id === sync.cancelledId))) {
    removeLocal('syncState');
  }
  const tab = await activeTab();
  if (sync.active || syncInProgress(stored, sync.cancelledId)) return { view: 'SYNCING', stored, tab, me: meData };

  if (!meData.skill_summary) return { view: 'NO_PROFILE', tab, me: meData };

  if (!tab || !isLcUrl(tab.url)) return { view: 'NOT_LC_TAB' };
  const ctx = await getCtx(tab.id);
  if ((ctx && ctx.isContest) || CONTEST_URL_RE.test(tab.url)) return { view: 'CONTEST_LOCKED' };
  // The content script's route:changed is the authority on the slug. A ctx without
  // route keys (only capture/judging/anchors written before any route report) says
  // nothing about the page, so fall back to the tab URL.
  const hasRoute = Boolean(ctx && (Object.prototype.hasOwnProperty.call(ctx, 'slug') || Object.prototype.hasOwnProperty.call(ctx, 'page')));
  const slug = hasRoute ? ctx.slug || null : slugFromUrl(tab.url);
  if (!slug) return { view: 'NON_PROBLEM_PAGE' };
  return { view: 'PROBLEM', tab, ctx, slug, me: meData };
}

function scheduleCompute(delay = 30) {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(runCompute, delay);
}

async function runCompute() {
  if (computing) {
    computeAgain = true;
    return;
  }
  computing = true;
  try {
    const next = await computeView();
    await render(next);
  } catch (err) {
    console.error('[Anchor panel] compute failed', err);
    setStatus('Something went wrong. Close and reopen the panel.', 'error');
  } finally {
    computing = false;
    if (computeAgain) {
      computeAgain = false;
      scheduleCompute(10);
    }
  }
}

// ---------------------------------------------------------------------------
// rendering dispatch
// ---------------------------------------------------------------------------
function viewKeyOf(next) {
  if (next.view === 'PROBLEM') return `PROBLEM:${next.tab.id}:${next.slug}`;
  return next.view;
}

function mount(root) {
  clear(els.view);
  root.classList.add("view-swap");
  els.view.appendChild(root);
  state.viewRefs = refsOf(root);
  return state.viewRefs;
}

async function render(next) {
  const key = viewKeyOf(next);
  const same = state.viewKey === key;
  state.lastNext = next;
  if (next.view !== 'PROBLEM' && state.view === 'PROBLEM') leaveProblem();
  if (next.view !== 'PROBLEM') {
    resetProblemBanners();
    renderCaptureDot(null);
  }
  if (next.view !== 'SYNCING') banners.sync = null;

  switch (next.view) {
    case 'NO_TOKEN':
      if (!same) renderNoToken(next);
      else show(state.viewRefs.expired, next.expired);
      setSubtitle('for LeetCode');
      break;
    case 'SERVER_WAKING':
      if (!same) renderWaking(next);
      updateWaking(next);
      setSubtitle('connecting');
      break;
    case 'UPDATE_REQUIRED':
      if (!same) renderUpdate(next);
      setSubtitle('update required');
      break;
    case 'TUTOR_UNAVAILABLE':
      if (!same) renderUnavailable(next);
      setSubtitle('unavailable');
      break;
    case 'NO_PROFILE':
      if (!same) renderNoProfile(next);
      else updateNoProfile(next);
      setSubtitle(usernameOf(next.me) ? `${usernameOf(next.me)} · not synced yet` : 'not synced yet');
      break;
    case 'SYNCING':
      if (!same) renderSyncing(next);
      await updateSyncing(next);
      setSubtitle(sync.username || usernameOf(next.me) || 'syncing');
      break;
    case 'NOT_LC_TAB':
      if (!same) renderSimple('Open LeetCode', 'Anchor works on leetcode.com problem pages. Switch to a LeetCode tab, or open one.', { label: 'Open leetcode.com', onClick: () => chrome.tabs.create({ url: `${LC_ORIGIN}problemset/` }) });
      setSubtitle(profileSubtitle(next));
      break;
    case 'NON_PROBLEM_PAGE':
      if (!same) renderSimple('Open a problem', 'Anchor wakes up on a problem page (leetcode.com/problems/...). Pick one and come back here.');
      setSubtitle(profileSubtitle(next));
      break;
    case 'CONTEST_LOCKED':
      if (!same) renderSimple('Locked during contests', 'Anchor stays quiet while you are in a contest. It will be back on regular problem pages.');
      setSubtitle('contest mode');
      break;
    case 'PROBLEM':
      if (!same) buildProblem(next);
      else updateProblem(next);
      break;
    default:
      renderSimple('Anchor', 'Unknown state.');
  }
  state.view = next.view;
  state.viewKey = key;
  renderBanners();
  refreshFooter();
}

function usernameOf(me) {
  const profile = me && me.profile;
  return (profile && profile.leetcode_username) || null;
}

function profileSubtitle() {
  const summary = state.profileSummary || {};
  const username = summary.username || null;
  const solved = summary.solved_count !== undefined && summary.solved_count !== null ? summary.solved_count : summary.solved;
  if (username && solved !== null && solved !== undefined) return `${username} · ${formatCount(solved)} solved`;
  if (username) return username;
  return 'for LeetCode';
}

// ---------------------------------------------------------------------------
// simple views
// ---------------------------------------------------------------------------
function renderNoToken(next) {
  const refs = mount(tpl('tpl-no-token'));
  show(refs.expired, next.expired);
  const input = $('token');
  const save = $('saveToken');
  const submit = async () => {
    const token = input.value.trim();
    if (!token) {
      setStatus('Token required.', 'error');
      return;
    }
    if (!JWT_RE.test(token)) {
      setStatus('That does not look like a token.', 'error');
      return;
    }
    await Ext.saveAuthToken(token);
    input.value = '';
    state.tokenExpired = false;
    invalidateMe();
    setStatus('Token saved.', 'success');
    scheduleCompute(0);
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  refs.openWeb.addEventListener('click', () => chrome.tabs.create({ url: CFG.WEB_APP_URL, active: true }));
  input.focus();
}

function renderWaking() {
  mount(tpl('tpl-waking'));
}

function updateWaking(next) {
  const refs = state.viewRefs;
  if (!refs || !refs.elapsed) return;
  const seconds = Math.max(0, Math.round((Date.now() - (next.since || Date.now())) / 1000));
  refs.elapsed.textContent = seconds < 5 ? 'Checking…' : `Still waiting (${seconds} s). Giving up after ${Math.round(WAKE_MAX_MS / 1000)} s.`;
}

function renderUpdate(next) {
  const refs = mount(tpl('tpl-update'));
  refs.versions.textContent = `This extension is version ${CFG.EXT_VERSION}; the server needs ${next.min || 'a newer version'} or later.`;
}

function unavailableCopy(reason) {
  if (reason === 'pilot_closed') return 'This account is not in the pilot. Ask the developer to add you.';
  if (reason === 'forbidden') return 'Access denied. Check that you are signed in with the right account.';
  if (reason === 'timeout' || reason === 'network') return "Anchor's server did not answer within 90 seconds. Check your connection and try again.";
  return `Anchor's server answered with an error (${reason}). Try again in a minute.`;
}

function renderUnavailable(next) {
  const refs = mount(tpl('tpl-unavailable'));
  refs.reason.textContent = unavailableCopy(next.reason);
  refs.retry.addEventListener('click', () => {
    health.wakingSince = 0;
    health.okAt = 0;
    invalidateMe();
    scheduleCompute(0);
  });
}

function renderSimple(title, text, action) {
  const refs = mount(tpl('tpl-simple'));
  refs.title.textContent = title;
  refs.text.textContent = text;
  if (action) {
    refs.action.textContent = action.label;
    refs.action.addEventListener('click', action.onClick);
    show(refs.action, true);
  }
}

// ---------------------------------------------------------------------------
// NO_PROFILE: consent + "Sync once"
// ---------------------------------------------------------------------------
function syncTabProblem(tab, me) {
  if (me && me.kill && me.kill.sync) return 'Syncing is paused by the developer right now. Try again later.';
  if (!tab || !isLcUrl(tab.url)) return 'Open a leetcode.com problem tab first: the sync runs inside it.';
  if (!slugFromUrl(tab.url)) return 'Open any problem page on leetcode.com first: the sync runs inside it.';
  return null;
}

function renderNoProfile(next) {
  const refs = mount(tpl('tpl-no-profile'));
  refs.consent.checked = state.consentChecked;
  refs.consent.addEventListener('change', () => {
    state.consentChecked = refs.consent.checked;
    updateNoProfile(state.lastNext);
  });
  refs.sync.addEventListener('click', () => startFirstSync(state.lastNext));
  updateNoProfile(next);
}

function updateNoProfile(next) {
  const refs = state.viewRefs;
  if (!refs || !refs.sync) return;
  const blocker = syncTabProblem(next.tab, next.me);
  refs.hint.textContent = blocker || (state.consentChecked ? 'Keep the LeetCode tab open and visible for 6 to 8 minutes.' : 'Tick the box to enable the button.');
  refs.sync.disabled = Boolean(blocker) || !state.consentChecked;
}

async function ensureConsent(me) {
  const profile = me && me.profile;
  const required = (me && me.consent_version) || CONSENT_VERSION;
  if (profile && profile.consent_version_accepted === required) return { ok: true };
  const result = await api.postConsent(required);
  if (!result.ok) return { ok: false, error: result.error, status: result.status };
  invalidateMe();
  return { ok: true };
}

async function startFirstSync(next) {
  const refs = state.viewRefs;
  const tab = next.tab;
  const blocker = syncTabProblem(tab, next.me);
  if (blocker || !state.consentChecked) {
    setStatus(blocker || 'Tick the consent box first.', 'error');
    return;
  }
  if (refs && refs.sync) refs.sync.disabled = true;
  setStatus('Recording your consent…');
  const consent = await ensureConsent(next.me);
  if (!consent.ok) {
    if (refs && refs.sync) refs.sync.disabled = false;
    setStatus(consent.status === 401 ? 'Token expired. Paste a new one.' : `Could not record consent (${consent.error}).`, 'error');
    if (consent.status === 401) scheduleCompute(0);
    return;
  }
  await startSync({ tabId: tab.id, resume: false, sinceId: null });
}

async function startIncrementalSync() {
  const next = state.lastNext;
  const tab = next && next.tab;
  const me = next && next.me;
  const blocker = syncTabProblem(tab, me);
  if (blocker) {
    setStatus(blocker, 'error');
    return;
  }
  setStatus('Starting sync…');
  const consent = await ensureConsent(me);
  if (!consent.ok) {
    setStatus(`Could not record consent (${consent.error}).`, 'error');
    return;
  }
  const sinceId = me && me.counts ? me.counts.max_lc_submission_id : null;
  await startSync({ tabId: tab.id, resume: false, sinceId: sinceId === undefined ? null : sinceId });
}

// ---------------------------------------------------------------------------
// SYNCING: driver over the 'anchor-sync' Port
// ---------------------------------------------------------------------------
const sync = {
  gen: 0,
  active: false,
  port: null,
  tabId: null,
  syncId: null,
  resume: false,
  phase: null,
  state: 'idle',       // idle | running | paused | error | finalizing | done
  liveState: null,     // last status.state from the content script
  reason: null,
  message: null,
  username: null,
  counts: null,
  until: null,
  waiting: null,
  chunk: null,         // { label, attempt }
  requestsDone: 0,
  startedAt: 0,
  chain: Promise.resolve(),
  cancelledId: null,
  detailsCap: null
};

function stopPort() {
  if (sync.port) {
    try {
      sync.port.disconnect();
    } catch (_) {
      // already gone
    }
  }
  sync.port = null;
}

async function startSync({ tabId, resume, sinceId }) {
  stopPort();
  sync.gen += 1;
  const gen = sync.gen;
  const stored = await getLocal('syncState');
  const useStored = resume && stored && stored.version === 1 && stored.sync_id;
  sync.active = true;
  sync.tabId = tabId;
  sync.syncId = useStored ? stored.sync_id : crypto.randomUUID();
  sync.resume = Boolean(useStored);
  sync.phase = useStored ? stored.phase : 'whoami';
  sync.state = 'running';
  sync.liveState = null;
  sync.reason = null;
  sync.message = null;
  sync.username = useStored ? stored.username : null;
  sync.counts = useStored ? countsFromStored(stored) : null;
  sync.until = null;
  sync.waiting = null;
  sync.chunk = null;
  sync.startedAt = Date.now();
  sync.chain = Promise.resolve();
  sync.cancelledId = null;
  banners.sync = null;

  const consent = await Ext.getConsent();
  const storedCap = Number(await getLocal('detailsCap'));
  sync.detailsCap = storedCap > 0 ? storedCap : Number(CFG.DETAILS_CAP_DEFAULT) || 300;

  let port;
  try {
    port = chrome.tabs.connect(tabId, { name: 'anchor-sync' });
  } catch (err) {
    pauseLocally('disconnected', null);
    scheduleCompute(0);
    return;
  }
  sync.port = port;
  port.onMessage.addListener((msg) => {
    if (sync.gen !== gen) return;
    onSyncMessage(msg, gen);
  });
  port.onDisconnect.addListener(() => {
    if (sync.gen !== gen) return;
    sync.port = null;
    // 'finalizing' no longer needs the port; every other live state is now paused.
    if (sync.state === 'running') {
      pauseLocally('disconnected', null);
      renderSyncNow();
    }
  });
  port.postMessage({
    type: 'start',
    sync_id: sync.syncId,
    resume: sync.resume,
    consent_code: consent,
    detailsCap: sync.detailsCap,
    since_id: sinceId === undefined ? null : sinceId
  });
  api.clientEvent('sync_start', { sync_id: sync.syncId, resume: sync.resume, since_id: sinceId === undefined ? null : sinceId }).catch(() => {});
  scheduleCompute(0);
}

function pauseLocally(reason, message) {
  sync.state = 'paused';
  sync.reason = reason;
  sync.message = message || null;
  sync.chunk = null;
  api.clientEvent('sync_paused', { sync_id: sync.syncId, reason, phase: sync.phase }).catch(() => {});
}

function renderSyncNow() {
  if (state.view === 'SYNCING' && state.lastNext) updateSyncing(state.lastNext).catch(() => {});
  else scheduleCompute(0);
}

function enqueueSyncWork(gen, fn) {
  sync.chain = sync.chain
    .then(() => (sync.gen === gen && sync.state === 'running' ? fn() : undefined))
    .catch((err) => onChunkFailure(err, gen));
}

function onSyncMessage(msg, gen) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'status':
      if (msg.phase) sync.phase = msg.phase;
      if (msg.username) sync.username = msg.username;
      if (msg.counts) sync.counts = { ...(sync.counts || {}), ...msg.counts };
      sync.liveState = msg.state || null;
      sync.until = msg.until || null;
      sync.waiting = msg.waiting || null;
      if (msg.state === 'stopped') {
        sync.state = 'idle';
      }
      renderSyncNow();
      break;
    case 'header':
      enqueueSyncWork(gen, () => handleSyncHeader(msg, gen));
      break;
    case 'page':
      enqueueSyncWork(gen, () => handleSyncPage(msg, gen));
      break;
    case 'paused':
      if (sync.state === 'running') {
        pauseLocally(msg.reason || 'user', msg.message || null);
      }
      renderSyncNow();
      break;
    case 'error':
      sync.state = 'error';
      sync.reason = msg.code || 'sync_failed';
      sync.message = SYNC_ERROR_COPY[msg.code] || msg.message || null;
      sync.chunk = null;
      api.clientEvent('sync_error', { sync_id: sync.syncId, source: 'content', code: sync.reason, phase: sync.phase }).catch(() => {});
      renderSyncNow();
      break;
    case 'done':
      enqueueSyncWork(gen, () => handleSyncDone(msg, gen));
      break;
    default:
      break;
  }
}

async function postChunk(body, label, gen) {
  const last = SYNC_BACKOFF_MS.length - 1;
  for (let attempt = 0; attempt <= last; attempt += 1) {
    if (sync.gen !== gen || (sync.state !== 'running' && sync.state !== 'finalizing')) {
      const err = new Error('cancelled');
      err.code = 'cancelled';
      throw err;
    }
    sync.chunk = { label, attempt: attempt + 1 };
    renderSyncNow();
    const result = await api.syncChunk(body);
    if (result.ok) {
      sync.chunk = null;
      sync.requestsDone += 1;
      return result;
    }
    if (result.status === 429) {
      // Sync limiter window (per minute): wait it out instead of burning the retry budget.
      await sleep(Math.max(SYNC_BACKOFF_MS[attempt], 15000));
      continue;
    }
    const err = new Error(result.error || `http_${result.status}`);
    err.status = result.status;
    err.error = result.error;
    if (result.status === 401 || result.error === 'missing_token') {
      err.code = 'auth';
      throw err;
    }
    if (result.status === 403) {
      err.code = result.error === 'consent_required' ? 'consent' : 'forbidden';
      throw err;
    }
    if (result.status === 409) {
      err.code = 'mismatch';
      throw err;
    }
    if (result.status === 400) {
      err.code = 'rejected';
      throw err;
    }
    if (result.status === 426) {
      err.code = 'update';
      throw err;
    }
    if (result.status === 503 && result.error === 'sync_paused') {
      err.code = 'kill';
      throw err;
    }
    if (attempt === last) {
      err.code = 'exhausted';
      throw err;
    }
    await sleep(SYNC_BACKOFF_MS[attempt]);
  }
  throw Object.assign(new Error('unreachable'), { code: 'exhausted' });
}

function chunkFailureCopy(err) {
  switch (err && err.code) {
    case 'auth': return 'Your token expired. Paste a new one in the popup, then click Resume.';
    case 'consent': return 'Consent is missing on the server. Cancel and start the sync again.';
    case 'forbidden': return 'Access denied (pilot closed). Ask the developer.';
    case 'mismatch': return 'The server is tracking a different sync. Cancel and start again.';
    case 'rejected': return `The server rejected a chunk (${err.error || 'bad request'}). Cancel and start again.`;
    case 'update': return 'Update the extension to keep syncing.';
    case 'kill': return 'Syncing is paused by the developer right now. Try again later.';
    case 'exhausted': return "Anchor's server did not respond after 5 tries. Click Resume to retry.";
    default: return `Sync stopped (${(err && err.message) || 'unknown error'}). Click Resume to retry.`;
  }
}

function onChunkFailure(err, gen) {
  if (sync.gen !== gen || (err && err.code === 'cancelled')) return;
  console.error('[Anchor panel] sync chunk failed', err && err.code, err && err.message);
  api.clientEvent('sync_error', { sync_id: sync.syncId, source: 'backend', code: err && err.code, error: err && err.error, status: err && err.status, phase: sync.phase }).catch(() => {});
  pauseLocally('backend', chunkFailureCopy(err));
  if (sync.port) {
    try {
      sync.port.postMessage({ type: 'pause' });
    } catch (_) {
      // port gone
    }
  }
  if (err && err.code === 'auth') invalidateMe();
  renderSyncNow();
  if (err && (err.code === 'auth' || err.code === 'update')) scheduleCompute(0);
}

function ack(msg) {
  if (!sync.port) return;
  try {
    sync.port.postMessage({ type: 'ack', phase: msg.phase, seq: msg.seq, cursor: msg.cursor === undefined ? null : msg.cursor });
  } catch (_) {
    // port gone; the durable cursor stays where it was
  }
}

async function handleSyncHeader(msg, gen) {
  const rows = Array.isArray(msg.solved) ? msg.solved : [];
  const solved = rows.slice(0, SYNC_MAX_SOLVED).map(mapSolvedRow).filter((r) => r.slug);
  if (rows.length > SYNC_MAX_SOLVED) console.warn('[Anchor panel] solved list truncated to', SYNC_MAX_SOLVED, 'of', rows.length);
  await postChunk({
    sync_id: sync.syncId,
    phase: 'solved',
    leetcode_username: msg.username || sync.username || null,
    solved,
    tag_counts: msg.tagCounts && typeof msg.tagCounts === 'object' ? msg.tagCounts : {},
    recent_ac: [],
    ext_version: CFG.EXT_VERSION
  }, 'solved list', gen);
  if (msg.username) sync.username = msg.username;
  ack({ phase: 'header', seq: msg.seq, cursor: null });
}

async function handleSyncPage(msg, gen) {
  const items = Array.isArray(msg.items) ? msg.items : [];
  const mapped = msg.phase === 'details' ? items.map(mapDetailRow) : items.map(mapSubmissionRow);
  const label = msg.phase === 'details' ? 'judge details' : 'submissions';
  for (const part of chunksOf(mapped, SYNC_CHUNK_ROWS)) {
    await postChunk({ sync_id: sync.syncId, phase: 'submissions', submissions: part, ext_version: CFG.EXT_VERSION }, label, gen);
  }
  ack(msg);
}

async function handleSyncDone(msg, gen) {
  sync.state = 'finalizing';
  sync.phase = 'finalize';
  if (msg.counts) sync.counts = { ...(sync.counts || {}), ...msg.counts };
  if (msg.username) sync.username = msg.username;
  renderSyncNow();
  await postChunk({
    sync_id: sync.syncId,
    phase: 'finalize',
    recent_ac: Array.isArray(msg.recentAc) ? msg.recentAc : [],
    ext_version: CFG.EXT_VERSION
  }, 'finalize', gen);
  if (sync.gen !== gen) return;
  api.clientEvent('sync_done', { sync_id: sync.syncId, resume: sync.resume, counts: sync.counts || null, requests: sync.requestsDone, ms: Date.now() - (sync.startedAt || Date.now()) }).catch(() => {});

  invalidateMe();
  const me = await getMe(true);
  const data = me.ok && me.data ? me.data : {};
  const existing = (await getLocal('profileSummary')) || {};
  const stored = (await getLocal('syncState')) || {};
  const solvedCount = msg.solvedCount !== undefined && msg.solvedCount !== null
    ? msg.solvedCount
    : data.counts && data.counts.solved !== undefined ? data.counts.solved : null;
  const syncedAt = new Date().toISOString();
  await setLocal({
    profileSummary: {
      ...existing,
      username: sync.username || usernameOf(data) || existing.username || null,
      solved: solvedCount,
      solved_count: solvedCount,
      skill_summary: data.skill_summary || null,
      habits: Array.isArray(data.habits) ? data.habits : [],
      synced_at: syncedAt,
      sync_status: 'complete',
      checkedAt: Date.now()
    },
    syncState: { ...stored, sync_id: sync.syncId, phase: 'done', state: 'done', finalized: true, finished_at: Date.now() }
  });
  stopPort();
  sync.active = false;
  sync.state = 'done';
  sync.chunk = null;
  banners.sync = null;
  setStatus('Sync complete.', 'success');
  scheduleCompute(0);
}

function pauseSync() {
  if (sync.state !== 'running') return;
  pauseLocally('user', null);
  if (sync.port) {
    try {
      sync.port.postMessage({ type: 'pause' });
    } catch (_) {
      // port gone
    }
  }
  renderSyncNow();
}

async function resumeSync() {
  const tab = await activeTab();
  const blocker = syncTabProblem(tab, state.lastNext && state.lastNext.me);
  if (blocker) {
    setStatus(blocker, 'error');
    return;
  }
  setStatus('Resuming…');
  await startSync({ tabId: tab.id, resume: true, sinceId: null });
}

async function cancelSync() {
  const syncId = sync.syncId || ((await getLocal('syncState')) || {}).sync_id || null;
  sync.gen += 1;
  if (sync.port) {
    try {
      sync.port.postMessage({ type: 'stop' });
    } catch (_) {
      // port gone
    }
  }
  await sleep(400);
  stopPort();
  sync.active = false;
  sync.state = 'idle';
  sync.chunk = null;
  sync.cancelledId = syncId;
  banners.sync = null;
  await removeLocal('syncState');
  setStatus('Sync cancelled.', 'success');
  scheduleCompute(0);
}

function renderSyncing() {
  const refs = mount(tpl('tpl-syncing'));
  refs.pause.addEventListener('click', pauseSync);
  refs.resume.addEventListener('click', resumeSync);
  refs.cancel.addEventListener('click', cancelSync);
}

async function updateSyncing(next) {
  const refs = state.viewRefs;
  if (!refs || !refs.fill) return;
  const driving = sync.active;
  const stored = driving ? null : next.stored || (await getLocal('syncState')) || null;
  const phase = driving ? sync.phase : stored ? stored.phase : null;
  const counts = driving ? sync.counts || countsFromStored(stored) : countsFromStored(stored);
  const detailsCap = driving ? sync.detailsCap : stored ? stored.detailsCap : null;
  let uiState = driving ? sync.state : stored && stored.state === 'done' ? 'paused' : stored ? stored.state : 'paused';
  let reason = driving ? sync.reason : stored ? stored.reason : null;
  if (!driving && stored && stored.state === 'done') reason = 'finalize_pending';
  if (!driving && uiState === 'running') {
    uiState = 'paused';
    reason = 'disconnected';
  }

  const fraction = syncFraction(phase, counts);
  refs.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
  refs.bar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  refs.phase.textContent = PHASE_LABEL[phase] || (phase ? capitalize(phase) : 'Starting');

  const running = uiState === 'running' || uiState === 'finalizing';
  refs.fill.classList.toggle("is-running", running);
  refs.fill.classList.toggle("is-paused", !running);
  const remaining = estimateSyncRemaining(phase, counts, detailsCap);
  refs.eta.textContent = running ? formatEta((remaining * SYNC_REQUEST_MS) / 1000) : '';

  const parts = [];
  if (counts) {
    if (counts.solved) parts.push(`${formatCount(counts.solved)} solved`);
    if (counts.subs) parts.push(`${formatCount(counts.subs)} submissions`);
    if (phase === 'details' || counts.details) parts.push(`${formatCount(counts.details)}${counts.detailsPlanned ? ` / ${formatCount(counts.detailsPlanned)}` : ''} details`);
  }
  if (sync.username && driving) parts.unshift(sync.username);
  refs.counts.textContent = parts.join(' · ');

  let chunkText = '';
  if (driving && sync.chunk) chunkText = sync.chunk.attempt > 1 ? `Sending ${sync.chunk.label} (retry ${sync.chunk.attempt} of ${SYNC_BACKOFF_MS.length})…` : `Sending ${sync.chunk.label}…`;
  else if (driving && sync.liveState === 'backoff' && sync.until) chunkText = `LeetCode asked us to slow down. Retrying in ${Math.max(1, Math.round((sync.until - Date.now()) / 1000))} s.`;
  else if (driving && sync.liveState === 'waiting_visible') chunkText = 'Waiting for the LeetCode tab to be visible.';
  else if (driving && sync.waiting === 'ack') chunkText = 'Uploading pages to Anchor…';
  refs.chunk.textContent = chunkText;

  let pill = 'running';
  if (uiState === 'paused') pill = 'paused';
  else if (uiState === 'error') pill = 'error';
  else if (uiState === 'finalizing') pill = 'finishing';
  else if (uiState === 'idle') pill = 'stopped';
  refs.state.textContent = pill;
  refs.state.className = `pill ${pill}`;

  let message = null;
  if (uiState === 'paused' || uiState === 'error' || uiState === 'idle') {
    if (driving && sync.message) message = sync.message;
    else if (reason === 'finalize_pending') message = 'LeetCode is fully read. Click Resume to build your map on the server.';
    else if (reason && PAUSE_COPY[reason]) message = PAUSE_COPY[reason];
    else if (reason && SYNC_ERROR_COPY[reason]) message = SYNC_ERROR_COPY[reason];
    else if (uiState === 'error') message = `Sync stopped (${reason || 'error'}). Click Resume to retry.`;
    else message = PAUSE_COPY.user;
  }
  // Paused / error reasons live in the banner stack (the card keeps only progress).
  show(refs.message, false);
  banners.sync = message ? { text: message } : null;

  const tabBlocker = syncTabProblem(next.tab, next.me);
  refs.tabHint.textContent = tabBlocker && !running
    ? `${tabBlocker} Then click Resume.`
    : 'Keep the LeetCode tab open and visible. You can close this panel; the sync resumes where it stopped.';

  show(refs.pause, uiState === 'running');
  show(refs.resume, !running);
  refs.resume.disabled = Boolean(tabBlocker);
  refs.resume.textContent = reason === 'finalize_pending' ? 'Finish' : 'Resume';
  refs.cancel.disabled = uiState === 'finalizing';
  renderBanners();
}

// ---------------------------------------------------------------------------
// PROBLEM view
// ---------------------------------------------------------------------------
// A cold Render dyno must not open the anchor-first promise with a spinner, so the
// payload is also mirrored per slug in chrome.storage.local (the session cache dies
// with the browser session).
const ANCHORS_LOCAL_TTL_MS = 24 * 60 * 60 * 1000;

const problem = {
  gen: 0,
  slug: null,
  tabId: null,
  me: null,
  ctx: null,
  refs: null,
  title: null,
  difficulty: null,
  anchors: null,
  anchorsError: null,
  anchorsLoading: false,
  history: null,
  historyError: null,
  allowedRung: 1,
  unlockReason: 'state_a_plan',
  lastRung: 0,              // same value, 0 when no hint has landed yet
  allowed: 1,               // min(3, allowed_rung_next): the ceiling this path may request
  failedSince: false,       // a non-AC verdict arrived after the last hint rendered
  typedTurns: 0,
  previousTurnTyped: true,  // never two taps in a row
  lastHint: null,           // { message_id, rung, slug, at, attempts_at_hint, done }
  stallTimer: null,
  stallDue: null,           // message_id the stall affordance is showing for
  stallShownFor: null,      // message_id it has already been shown for
  silenceTimer: null,
  gateOpen: false,
  gateSent: false,
  gateDraft: '',
  gateDismissed: false,
  slot: null,               // null | 'gate' | 'stall' | 'capture'
  belowGate: false,         // they asked for the shape below the gate
  capHit: false,
  lastUserText: null,
  judgingNode: null,
  newestBubble: null,
  verdictsSeen: null,
  sending: false,
  controller: null,
  pasteVisible: false,
  pingOk: null,
  whoami: { at: 0, signedIn: null },
  lastVerdict: null,
  // ---- motion / wait state ----
  sendStartedAt: 0,
  waitPhase: "normal",              // normal | long | cold
  waitTimers: { long: null, probe: null, decide: null, elapsed: null },
  probeResult: null,                // null | warm | cold
  pendingNode: null,
  lastRungShown: 0,
  pendingReveal: null,
  newBelowNode: null,
  anims: [],
  anchorsMemo: new Map()   // `${tabId}:${slug}` -> { syncedAt, fetchedAt, data }
};

function leaveProblem() {
  problem.gen += 1;
  if (problem.controller) {
    try {
      problem.controller.abort();
    } catch (_) {
      // ignore
    }
  }
  problem.controller = null;
  problem.sending = false;
  clearStall();
  clearWaitTimers();
  hideNewBelow();
  for (const a of problem.anims) {
    try {
      a.cancel();
    } catch (_) {
      // already finished
    }
  }
  problem.anims.length = 0;
  problem.pendingNode = null;
  problem.pendingReveal = null;
  problem.waitPhase = "normal";
  problem.probeResult = null;
  clearTimeout(problem.silenceTimer);
  problem.silenceTimer = null;
  problem.refs = null;
  problem.newestBubble = null;
  problem.judgingNode = null;
}

function buildProblem(next) {
  leaveProblem();
  const gen = problem.gen;
  problem.slug = next.slug;
  problem.tabId = next.tab.id;
  problem.me = next.me;
  problem.ctx = next.ctx;
  problem.title = null;
  problem.difficulty = null;
  problem.anchors = null;
  problem.anchorsError = null;
  problem.anchorsLoading = true;
  problem.history = null;
  problem.historyError = null;
  problem.allowedRung = 1;
  problem.unlockReason = 'state_a_plan';
  problem.lastRung = 0;
  problem.allowed = 1;
  problem.failedSince = false;
  problem.typedTurns = 0;
  problem.previousTurnTyped = true;
  problem.lastHint = null;
  problem.stallDue = null;
  problem.stallShownFor = null;
  problem.gateOpen = false;
  problem.gateSent = false;
  problem.gateDraft = '';
  problem.gateDismissed = false;
  problem.slot = null;
  problem.belowGate = false;
  problem.capHit = false;
  problem.lastUserText = null;
  problem.verdictsSeen = new Set();
  problem.pasteVisible = false;
  problem.pingOk = null;
  problem.whoami = { at: 0, signedIn: null };
  problem.lastVerdict = null;
  resetProblemBanners();

  const refs = mount(tpl('tpl-problem'));
  problem.refs = refs;
  refs.send.addEventListener('click', () => sendMessage());
  refs.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  refs.input.addEventListener('input', () => {
    onComposerKeystroke();
    growInput();
    // renderSlot() defers while the composer holds a draft; once it empties
    // the deferred render has to actually arrive.
    if (!refs.input.value.trim() && problem.slotDeferred) renderSlot();
  });
  refs.input.addEventListener('blur', () => {
    if (problem.slotDeferred) renderSlot();
  });

  renderSubtitle();
  renderMemoryBlock();
  renderTranscript();
  renderStance();
  renderSlot();
  renderComposer();
  renderCodeNote();
  applyCtx(next.ctx);
  loadProblemData(gen).catch((err) => console.error('[Anchor panel] problem load failed', err));
}

function updateProblem(next) {
  problem.me = next.me;
  problem.tabId = next.tab.id;
  applyCtx(next.ctx);
  renderCodeNote();
  renderComposer();
}

function applyCtx(ctx) {
  problem.ctx = ctx;
  renderCaptureDot(ctx);
  const capture = captureStateOf(ctx);
  banners.capture_off = capture.state === 'off' && capture.reason !== 'reload' ? capture.reason || '' : null;
  if (ctx && ctx.needsReload) banners.reload_tab = true;
  syncJudgingDivider(ctx);
  renderSlot();
  renderStance();
  renderBanners();
}

function renderSubtitle() {
  const title = problem.title || problem.slug.replace(/-/g, ' ');
  const difficulty = problem.difficulty ? ` · ${capitalize(problem.difficulty)}` : '';
  setSubtitle(`${title}${difficulty}`);
}

function skillSummary() {
  const summary = state.profileSummary && state.profileSummary.skill_summary;
  return summary || (problem.me && problem.me.skill_summary) || null;
}

// The real solved count, so a null state still proves the tutor read their history.
function solvedCount() {
  const summary = skillSummary() || {};
  const stored = state.profileSummary || {};
  const counts = (problem.me && problem.me.counts) || {};
  for (const candidate of [summary.solved, stored.solved_count, stored.solved, counts.solved]) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ---- memory block (the first node of the thread) ----
function omittedCopy(reason, solved) {
  const hinglish = lang() === 'hinglish';
  const many = solved === null
    ? (hinglish ? 'Tumhare solve kiye problems' : 'your solved problems')
    : (hinglish ? `Tumhare ${formatCount(solved)} solve kiye problems` : `your ${formatCount(solved)} solved problems`);
  switch (reason) {
    case 'no_eligible': // backend domain/anchors.js
    case 'no_candidates':
    case 'none':
      return hinglish
        ? `${many} me se koi is se sub-pattern ya tag share nahi karta.`
        : `None of ${many} shares a sub-pattern or tag with this one.`;
    case 'no_dp_or_graph_family':
    case 'no_family':
      return hinglish
        ? 'Anchors sirf DP aur graph problems cover karte hain; ye dono nahi hai.'
        : 'Anchors cover DP and graph problems; this one is neither.';
    case 'below_threshold': // backend domain/anchors.js
    case 'below_min_score':
    default:
      return hinglish
        ? `${many} me se koi itna paas nahi hai.`
        : `None of ${many} is close enough to lean on.`;
  }
}

function anchorLineText(anchor, language) {
  const parts = [];
  const day = formatDay(anchor.solved_on);
  const attempts = Number(anchor.attempts_to_ac);
  if (language === 'hinglish') {
    if (day) parts.push(`${day} ko solve kiya`);
    if (Number.isFinite(attempts) && attempts > 0) parts.push(`${attempts} attempt${attempts === 1 ? '' : 's'}`);
    if (anchor.has_code) parts.push('tumhara code abhi bhi hai');
  } else {
    if (day) parts.push(`solved ${day}`);
    if (Number.isFinite(attempts) && attempts > 0) parts.push(`${attempts} attempt${attempts === 1 ? '' : 's'}`);
    if (anchor.has_code) parts.push('your code is still here');
  }
  return parts.length ? ` — ${parts.join(', ')}.` : '';
}

// A non-AC verdict for this slug, less than 30 minutes old. decideRung forces a
// floor-3 diagnostic inside that window, so the panel says so rather than
// letting it surprise them.
function recentFailAttempt() {
  const ctx = problem.ctx;
  const attempt = problem.lastVerdict || (ctx && ctx.lastAttempt ? ctx.lastAttempt : null);
  if (!attempt || attempt.title_slug !== problem.slug) return null;
  if (Number(attempt.status_code) === 10) return null;
  const at = parseTime(attempt.recordedAt) || parseTime(attempt.capturedAt) || null;
  if (at !== null && Date.now() - at > RECENT_FAIL_MS) return null;
  return attempt;
}

function failDescription(attempt) {
  const label = verdictLabel(attempt.status_code, attempt.status_msg);
  const bucket = attempt.result && attempt.result.bucket ? ` · ${bucketText(attempt.result.bucket)}` : '';
  return `${label}${bucket}`;
}

/**
 * The memory block, built from data only: no globals beyond document.
 * HARD PROMISES, both of which live only here (guard.js never sees this text):
 *   1. anchor.why is NEVER rendered (it names the state formulation, which is the
 *      answer to the rung-2 question).
 *   2. no problem title is printed that is not present in anchors[].
 * @param {{data, error, loading, solved, language, lastFail, habit, onRetry}} input
 */
function memoryBlockNode(input) {
  const opts = input || {};
  const language = opts.language === 'hinglish' ? 'hinglish' : 'english';
  const hinglish = language === 'hinglish';
  const solved = Number.isFinite(Number(opts.solved)) && Number(opts.solved) > 0 ? Number(opts.solved) : null;
  const node = document.createDocumentFragment();
  const data = opts.data || null;

  if (!data && opts.loading) {
    const text = solved === null
      ? 'Looking through what you have solved…'
      : hinglish
        ? `Tumhare ${formatCount(solved)} solve kiye problems dekh raha hoon…`
        : `Looking through your ${formatCount(solved)} solved problems…`;
    node.appendChild(el('div', 'memory-note', text));
    return node;
  }

  if (!data) {
    const err = opts.error || {};
    const status = Number(err.status);
    const text = status === 404
      ? "This problem is not in Anchor's catalogue yet. Reload the page once it has loaded fully."
      : status === 401
        ? 'Token expired.'
        : 'Could not load anchors (network).';
    node.appendChild(el('div', 'memory-note', text));
    if (status !== 401 && typeof opts.onRetry === 'function') {
      node.appendChild(button('btn tiny', 'Retry', opts.onRetry));
    }
    return node;
  }

  const anchors = Array.isArray(data.anchors) ? data.anchors.filter((a) => a && a.slug) : [];

  if (data.solved_here === true) {
    const day = formatDay(data.solved_here_on || data.solved_on || null);
    const line = day
      ? (hinglish ? `Ye problem tum ${day} ko solve kar chuke ho.` : `You solved this one already, on ${day}.`)
      : 'You solved this one already.';
    node.appendChild(el('div', 'memory-line', line));
  }

  if (anchors.length) {
    node.appendChild(el('div', 'memory-claim', hinglish ? 'Ye shape tumne pehle solve ki hai.' : 'You have solved this shape before.'));
    // A third anchor is dropped, not collapsed behind a disclosure.
    for (const anchor of anchors.slice(0, 2)) {
      const line = el('div', 'memory-line');
      const title = anchor.title || anchor.slug;
      line.appendChild(anchorLink(title, `${LC_ORIGIN}problems/${encodeURIComponent(anchor.slug)}/`, `Open ${title} in a new tab`));
      const tail = anchorLineText(anchor, language);
      if (tail) line.appendChild(document.createTextNode(tail));
      node.appendChild(line);
    }
    const family = data.family ? String(data.family).toLowerCase() : null;
    const familyLine = family ? (FAMILY_LINE[language] || FAMILY_LINE.english)[family] : null;
    if (familyLine) node.appendChild(el('div', 'memory-note', familyLine));
  } else {
    node.appendChild(el('div', 'memory-claim', hinglish ? 'Ye tumhare liye naya ilaaka hai.' : 'New ground for you.'));
    node.appendChild(el('div', 'memory-line', omittedCopy(data.omitted_reason, solved)));
    if (opts.habit && (opts.habit.statement || opts.habit.key)) {
      const line = el('div', 'memory-note');
      line.appendChild(document.createTextNode(hinglish ? 'Ek pattern tumhara zaroor hai: ' : 'One pattern of yours, though: '));
      line.appendChild(renderInline(opts.habit.statement || opts.habit.key));
      node.appendChild(line);
    }
  }

  if (opts.lastFail) {
    const text = hinglish
      ? `Yahan tumhara pichla run fail hua: ${opts.lastFail}. Pehla hint wahi pakdega.`
      : `Your last run here failed: ${opts.lastFail}. My first hint goes straight at that.`;
    node.appendChild(el('div', 'memory-note', text));
  }
  return node;
}

function renderMemoryBlock() {
  const refs = problem.refs;
  if (!refs || !refs.memory) return;
  const memory = refs.memory;
  memory.classList.remove("is-in");
  clear(memory);
  const fail = recentFailAttempt();
  const habits = relevantHabits();
  memory.appendChild(memoryBlockNode({
    data: problem.anchors,
    error: problem.anchorsError,
    loading: problem.anchorsLoading,
    solved: solvedCount(),
    language: lang(),
    lastFail: fail ? failDescription(fail) : null,
    habit: habits.length ? habits[0] : null,
    onRetry: () => loadAnchors(problem.gen, true)
  }));
  // The block resolves ABOVE the transcript, so its growth is compensated:
  // the reading position must not jump when anchors land.
  preserveScroll(() => {
    let i = 0;
    for (const child of memory.children) {
      child.style.setProperty("--i", String(i));
      i += 1;
    }
    if (problem.anchorsLoading) {
      const note = memory.querySelector(".memory-note");
      if (note) note.classList.add("is-waiting");
    }
    flush(memory);
    memory.classList.add("is-in");
  });
}

function relevantHabits() {
  const all = problem.me && Array.isArray(problem.me.habits) ? problem.me.habits : [];
  const data = problem.anchors;
  const live = all.filter((h) => h && h.live !== false && h.state !== 'dismissed' && h.reaction !== 'dismissed');
  if (!data || !Array.isArray(data.subpatterns)) return live.slice(0, MAX_HABITS_SHOWN);
  const subs = new Set(data.subpatterns.map((s) => s.id));
  const filtered = live.filter((h) => (h.subpattern && subs.has(h.subpattern)) || h.category === 'overflow' || h.key === 'overflow');
  return filtered.slice(0, MAX_HABITS_SHOWN);
}

// ---- stance line (one muted line above the composer) ----
function hintsLeft() {
  const hints = problem.me && problem.me.hints;
  if (!hints) return null;
  const cap = Number(hints.cap);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  const today = Number(hints.today) || 0;
  return Math.max(0, cap - today);
}

function failedTestNumber(attempt) {
  const candidates = [
    attempt && attempt.result ? attempt.result.failed_test : null,
    attempt ? attempt.last_test : null,
    attempt && attempt.result ? attempt.result.last_test : null
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// The ordered precedence table from the spec: first match wins.
function stanceText() {
  if (problem.sending) return pick('Thinking…', 'Soch raha hoon…');
  if (problem.ctx && problem.ctx.isContest) return pick('Anchor is off during contests.', 'Contest me Anchor band hai.');
  const left = hintsLeft();
  if (problem.capHit || left === 0) return pick('Hint cap reached today. Resets at 00:00 UTC.', 'Aaj ke hints khatam. 00:00 UTC pe reset.');
  if (problem.belowGate) return 'Run it once more and I can go further.';
  const fail = recentFailAttempt();
  if (fail) {
    const bucket = fail.result && fail.result.bucket ? bucketText(fail.result.bucket) : null;
    if (bucket) return pick(`Last run failed on ${bucket}. Going at that.`, `Pichla run ${bucket} pe fail. Wahi dekh raha hoon.`);
    const test = failedTestNumber(fail);
    if (test !== null) return pick(`Last run failed on test ${test}. Going at that.`, `Pichla run test ${test} pe fail. Wahi dekh raha hoon.`);
  }
  if (problem.allowedRung >= 4 && !problem.gateOpen) return pick('Still stuck? Ask me for the shape of the code.', 'Ab bhi atke ho? Code ka shape maang lo.');
  if (problem.allowed >= 3) return pick('You have put work in. I can get specific now.', 'Kaam kiya hai tumne. Ab specific ho sakta hoon.');
  if (problem.allowed >= 2) {
    const anchors = problem.anchors && Array.isArray(problem.anchors.anchors) ? problem.anchors.anchors : [];
    const first = anchors.length ? anchors[0].title || anchors[0].slug : null;
    if (first) return pick(`Working from ${first}.`, `${first} se chal raha hoon.`);
    return pick('Working from what you wrote.', 'Jo tumne likha usi se chal raha hoon.');
  }
  return pick('Say what you are thinking — wrong is fine.', 'Jo soch rahe ho bolo — galat bhi chalega.');
}

function renderStance() {
  const refs = problem.refs;
  if (!refs || !refs.stance) return;
  const text = stanceText();
  if (refs.stance.textContent !== text) refs.stance.textContent = text;
}

// ---- the affordance slot: exactly one occupant, gate > stall > capture ----
function matchesRung4Intent(text) {
  const value = String(text || '');
  return RUNG4_INTENT.some((re) => re.test(value));
}

function gatePredicate() {
  // The server's own rung4Ready, the last bubble at rung 3, and new evidence after it.
  if (problem.gateDismissed) return false;
  if (problem.allowedRung !== 4) return false;
  if (problem.lastRung !== 3) return false;
  if (problem.failedSince) return true;
  return Boolean(problem.lastHint && problem.stallDue === problem.lastHint.message_id);
}

function openGate(path) {
  if (problem.gateOpen) return;
  problem.gateOpen = true;
  problem.gateDismissed = false;
  problem.gateSent = false;
  problem.belowGate = false;
  api.clientEvent('gate_shown', { slug: problem.slug, path: path || 'predicate', rung: problem.lastRung }).catch(() => {});
  renderSlot();
  renderStance();
  const refs = problem.refs;
  if (refs && refs.slot) {
    const field = refs.slot.querySelector('textarea');
    if (field) field.focus();
  }
}

function closeGate(abandoned) {
  if (!problem.gateOpen) return;
  problem.gateOpen = false;
  if (abandoned && !problem.gateSent) {
    api.clientEvent('gate_abandoned', { slug: problem.slug, rung: problem.lastRung }).catch(() => {});
  }
  problem.gateSent = false;
  problem.gateDraft = '';
  if (abandoned) problem.gateDismissed = true;
  renderSlot();
  renderStance();
}

// A form with no button until GATE_MIN_CHARS non-space characters.
function gateNode() {
  if (!problem.gateOpen && gatePredicate()) {
    problem.gateOpen = true;
    api.clientEvent('gate_shown', { slug: problem.slug, path: 'predicate', rung: problem.lastRung }).catch(() => {});
  }
  if (!problem.gateOpen) return null;
  const node = el('div', 'gate');
  node.dataset.slot = 'gate';
  node.appendChild(el('div', 'gate-claim', pick('Still not it.', 'Ab bhi nahi hua.')));
  node.appendChild(el('div', 'gate-text', pick(
    'I can show the shape of the code: blanks for you to fill, never a working solution.',
    'Main code ka shape dikha sakta hoon: blanks tumhein bharne hain, chalta hua solution kabhi nahi.'
  )));
  node.appendChild(el('div', 'gate-text', pick(
    'First, in one line: what do you think is wrong?',
    'Pehle, ek line me: tumhe kya galat lag raha hai?'
  )));
  const field = el('textarea');
  field.rows = 2;
  field.placeholder = pick('I think my state is wrong because…', 'Mujhe lagta hai mera state galat hai kyunki…');
  // The draft survives a re-render of the slot (a ctx change must not eat it).
  field.value = problem.gateDraft || '';
  node.appendChild(field);
  const send = button('btn primary', pick('Show me the shape', 'Shape dikhao'), () => {
    const text = field.value.trim();
    if (text.replace(/\s/g, '').length < GATE_MIN_CHARS) return;
    problem.gateSent = true;
    api.clientEvent('gate_used', { slug: problem.slug, chars: text.length }).catch(() => {});
    sendMessage({ text, fromGate: true });
  });
  // No button EXISTS until the field holds GATE_MIN_CHARS non-space characters;
  // it appearing is announced through the slot's aria-live="polite".
  const paint = () => {
    problem.gateDraft = field.value;
    const ready = field.value.replace(/\s/g, '').length >= GATE_MIN_CHARS;
    if (ready && !send.isConnected) node.appendChild(send);
    else if (!ready && send.isConnected) send.remove();
  };
  field.addEventListener('input', paint);
  paint();
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGate(true);
    }
  });
  return node;
}

function stallNode() {
  if (!problem.lastHint || problem.stallDue !== problem.lastHint.message_id) return null;
  const failed = problem.failedSince || Boolean(recentFailAttempt());
  const label = failed
    ? pick('That run failed — what broke? →', 'Wo run fail hua — kya toota? →')
    : pick('I am still stuck →', 'Abhi bhi atka hoon →');
  // The sent text is always the English literal: it is the exact string the
  // backend plan stoplist carries, so a tap can never set a plan.
  const text = failed ? STALL_STRINGS.failed : STALL_STRINGS.stuck;
  const node = button('link', label, () => {
    problem.stallDue = null;
    sendMessage({ text, fromStall: true });
  });
  node.dataset.slot = 'stall';
  return node;
}

function captureNode() {
  const ctx = problem.ctx;
  const capture = captureStateOf(ctx);
  const stalledBlind = Boolean(problem.stallShownFor) && problem.verdictsSeen && problem.verdictsSeen.size === 0;
  if (capture.state !== 'off' && !(ctx && ctx.needsReload) && !stalledBlind) return null;
  const node = el('div', 'slot-row');
  node.dataset.slot = 'capture';
  node.appendChild(el('div', 'slot-text', pick('Anchor did not see that submission.', 'Anchor ne wo submission nahi dekhi.')));
  node.appendChild(button('link', pick('Check my last run', 'Pichla run check karo'), (event) => {
    manualCapture(event.currentTarget);
  }));
  return node;
}

// THE SINGLE SWITCH: one node, replaced in one operation. The paste box is not in
// this switch; it keeps its own position below the textarea.
function renderSlot() {
  const refs = problem.refs;
  if (!refs || !refs.slot) return;
  const hadFocus = refs.slot.contains(document.activeElement);
  // Never swap the slot out from under someone who is mid-sentence in the
  // composer: the movement below the caret is what makes a panel feel jumpy.
  if (!hadFocus && document.activeElement === refs.input && refs.input.value.trim()) {
    problem.slotDeferred = true;
    return;
  }
  problem.slotDeferred = false;
  clear(refs.slot);
  const node = gateNode() || stallNode() || captureNode();
  problem.slot = node ? node.dataset.slot || null : null;
  if (node) {
    const box = el("div", "slot-reveal");
    if (node.dataset.slot === "gate") box.classList.add("is-gate");
    box.appendChild(node);
    refs.slot.appendChild(box);
    flush(box);
    box.classList.add("is-open");
  }
  if (hadFocus && node) {
    const field = node.tagName === 'TEXTAREA' ? node : node.querySelector('textarea');
    if (field) {
      field.focus();
      const end = field.value.length;
      try {
        field.setSelectionRange(end, end);
      } catch (_) {
        // not a text field
      }
    }
  }
}

// ---- the 75-second stall ----
function clearStall() {
  clearTimeout(problem.stallTimer);
  problem.stallTimer = null;
}

function armStall(messageId) {
  clearStall();
  if (!messageId) return;
  if (problem.stallShownFor === messageId) return;      // at most once per hint
  if (problem.typedTurns < 1) return;                   // at least one typed turn exists
  if (!problem.previousTurnTyped) return;               // never two taps in a row
  if (document.visibilityState !== 'visible') return;   // the panel must be visible
  problem.stallTimer = setTimeout(() => {
    problem.stallTimer = null;
    if (document.visibilityState !== 'visible') return;
    if (!problem.lastHint || problem.lastHint.message_id !== messageId) return;
    problem.stallDue = messageId;
    problem.stallShownFor = messageId;
    api.clientEvent('hint_stall', { message_id: messageId, seconds: Math.round(STALL_MS / 1000) }).catch(() => {});
    renderSlot();
    renderStance();
  }, STALL_MS);
}

function onComposerKeystroke() {
  clearStall();
  if (problem.stallDue) {
    problem.stallDue = null;
    renderSlot();
  }
}

function growInput() {
  const refs = problem.refs;
  if (!refs || !refs.input) return;
  refs.input.style.height = 'auto';
  const wanted = Number(refs.input.scrollHeight);
  refs.input.style.height = `${Math.min(120, Math.max(56, Number.isFinite(wanted) ? wanted : 56))}px`;
}

// ---- implicit outcome events (no UI) ----
function emitHintOutcome(nextThing, extra) {
  const hint = problem.lastHint;
  if (!hint || hint.done) return;
  hint.done = true;
  clearTimeout(problem.silenceTimer);
  problem.silenceTimer = null;
  api.clientEvent('hint_outcome', {
    message_id: hint.message_id,
    rung: hint.rung,
    slug: hint.slug,
    next: nextThing,
    bucket: (extra && extra.bucket) || null,
    dwell_ms: Math.max(0, Date.now() - (hint.at || Date.now())),
    replied_chars: (extra && extra.replied_chars) || 0
  }).catch(() => {});
}

function armSilence() {
  clearTimeout(problem.silenceTimer);
  problem.silenceTimer = setTimeout(() => emitHintOutcome('silence', null), SILENCE_MS);
}

// ---- composer chrome ----
function renderComposer() {
  const refs = problem.refs;
  if (!refs || !refs.input) return;
  if (problem.sending) {
    refs.input.placeholder = pick('Sending…', 'Bhej raha hoon…');
    return;
  }
  refs.input.placeholder = recentFailAttempt()
    ? pick('What did you try?', 'Kya try kiya?')
    : pick('Where are you stuck? (Enter to send)', 'Kahan atke ho? (Enter se bhejo)');
}

// Under the composer, at most one line.
async function renderCodeNote() {
  const refs = problem.refs;
  if (!refs || !refs.codeNote) return;
  const left = hintsLeft();
  if (left !== null && left <= HINTS_LEFT_NOTE_AT) {
    refs.codeNote.textContent = pick(`${left} hint${left === 1 ? '' : 's'} left today.`, `Aaj ${left} hints bache hain.`);
    return;
  }
  const consent = await Ext.getConsent();
  if (problem.refs !== refs) return;
  refs.codeNote.textContent = consent ? '' : 'Code not shared (turn on in the popup).';
}

// ---- transcript ----
function renderTranscript() {
  const refs = problem.refs;
  if (!refs) return;
  clear(refs.transcript);
  problem.newestBubble = null;
  problem.judgingNode = null;
  if (!problem.history) {
    refs.transcript.appendChild(el('div', 'view-text muted center', problem.historyError ? `Could not load the conversation (${problem.historyError}).` : 'Loading the conversation…'));
    return;
  }
  const messages = Array.isArray(problem.history.messages) ? problem.history.messages : [];
  if (!messages.length) {
    refs.transcript.appendChild(makePrimer());
    return;
  }
  let lastTutorIndex = -1;
  messages.forEach((message, index) => {
    if (message && message.role !== 'user') lastTutorIndex = index;
  });
  messages.forEach((message, index) => {
    if (!message) return;
    if (message.role === 'user') {
      refs.transcript.appendChild(makeUserBubble(message.content));
      return;
    }
    const bubble = makeTutorBubble(message, { newest: index === lastTutorIndex });
    if (index === lastTutorIndex) problem.newestBubble = bubble;
    refs.transcript.appendChild(bubble);
  });
  scrollTranscript();
}

// The only instruction anywhere in the panel.
function primerText() {
  const anchors = problem.anchors && Array.isArray(problem.anchors.anchors) ? problem.anchors.anchors : [];
  return anchors.length
    ? pick('Tell me where you are stuck. I will start from those, not from scratch.', 'Batao kahan atke ho. Main wahi se shuru karunga, zero se nahi.')
    : pick('Tell me where you are stuck. We start from the problem itself.', 'Batao kahan atke ho. Problem se hi shuru karte hain.');
}

function makePrimer() {
  return el('div', 'primer', primerText());
}

// The transcript can render before the anchors land; the primer then catches up.
function refreshPrimer() {
  const refs = problem.refs;
  if (!refs) return;
  const first = refs.transcript.firstElementChild;
  if (first && first.classList.contains('primer')) first.textContent = primerText();
}

function scrollTranscript() {
  const refs = problem.refs;
  if (!refs) return;
  // Synchronous first: rAF does not fire while the panel is hidden, and the
  // transcript must still be at the bottom when it is reopened.
  els.view.scrollTop = els.view.scrollHeight;
  requestAnimationFrame(() => {
    els.view.scrollTop = els.view.scrollHeight;
  });
}

// Only the primer: a loading / error placeholder is left alone so a divider
// never replaces "Loading the conversation…".
function clearPrimer() {
  const refs = problem.refs;
  if (!refs) return;
  const first = refs.transcript.firstElementChild;
  if (first && first.classList.contains('primer')) first.remove();
}

// Before the first bubble of a turn: the primer and any placeholder go.
function clearPlaceholder() {
  const refs = problem.refs;
  if (!refs) return;
  const first = refs.transcript.firstElementChild;
  if (first && (first.classList.contains('primer') || first.classList.contains('view-text'))) clear(refs.transcript);
}

function makeUserBubble(text) {
  const wrap = el('div', 'bubble-row user');
  const bubble = el('div', 'bubble user', text);
  wrap.appendChild(bubble);
  return wrap;
}

/**
 * The lines shown while a hint is in flight.
 *
 * There is no streaming: POST /api/lc/chat returns one complete JSON reply, so
 * any character-by-character reveal would be a lie about the system. What is
 * NOT a lie is naming the inputs the hint is being built from, every one of
 * which is resolved on the client BEFORE the request is issued. The wait
 * becomes the one moment per turn where the tutor shows its reasoning inputs.
 *
 * HARD INVARIANT, the same one renderMemoryBlock() carries: no problem title
 * may be printed here that is not present in anchors[]. This is the second
 * panel-composed surface that could otherwise claim the student solved
 * something they did not.
 *
 * @param {{consent:boolean, code:string|null, codeLang:string|null}} input
 * @returns {Array<{text:string, final:boolean}>}
 */
function buildProgressLines(input) {
  const o = input || {};
  const hinglish = lang() === 'hinglish';
  const lines = [];

  // L1 CONTEXT — the optimistic user turn is already pushed at this point.
  const turns = problem.history && Array.isArray(problem.history.messages) ? problem.history.messages.length : 0;
  if (turns >= 2) {
    lines.push({
      text: hinglish ? `Ye poori baat padh raha hoon — abhi tak ${turns} turns.` : `Reading this thread — ${turns} turns so far.`,
      drop: 1
    });
  } else {
    lines.push({ text: hinglish ? 'Jo tumne likha wo padh raha hoon.' : 'Reading what you wrote.', drop: 1 });
  }

  // L2 CODE — consent and the editor read are both already resolved.
  if (o.consent && o.code) {
    const count = String(o.code).split('\n').length;
    const named = o.codeLang ? LANG_NAME[String(o.codeLang).toLowerCase()] : null;
    const tail = named ? (hinglish ? `${count} lines ${named}` : `${count} lines of ${named}`) : `${count} lines`;
    lines.push({ text: hinglish ? `Tumhara editor code saath hai — ${tail}.` : `Your editor code is attached — ${tail}.` });
  } else if (o.consent) {
    lines.push({
      text: hinglish ? 'Editor padh nahi paaya. Sirf tumhare shabdon par ja raha hoon.' : 'Could not read your editor. Going on your words alone.'
    });
  } else {
    lines.push({
      text: hinglish ? 'Tumhara code share nahi hota, to sirf tumhare shabdon se.' : 'Your code is not shared, so this is from your words alone.'
    });
  }

  // L3 FAILED RUN — only a non-AC verdict for this slug inside the 30-minute window.
  const attempt = recentFailAttempt();
  if (attempt) {
    if (attempt.pending) {
      lines.push({
        text: hinglish ? 'Tumhara pichla run abhi upload ho raha hai; ho sakta hai is hint ko na mile.' : 'Your last run is still uploading; this hint may not see it.'
      });
    } else {
      const desc = failDescription(attempt);
      lines.push({ text: hinglish ? `Tumhara pichla run record par hai: ${desc}.` : `Your last run is on the record: ${desc}.` });
    }
  }

  // L4 ANCHORS — titles come from anchors[] and nowhere else.
  const data = problem.anchors;
  const anchors = data && Array.isArray(data.anchors) ? data.anchors.filter((a) => a && a.slug) : [];
  if (anchors.length >= 1) {
    const first = anchors[0].title || anchors[0].slug;
    lines.push({ text: hinglish ? `${first} se kaam le raha hoon.` : `Working from ${first}.` });
    if (anchors.length >= 2) {
      const second = anchors[1].title || anchors[1].slug;
      lines.push({ text: hinglish ? `…aur ${second}.` : `…and ${second}.`, drop: 2 });
    }
  } else if (data) {
    lines.push({
      text: hinglish ? 'Tumhara koi solve kiya problem itna paas nahi — isi problem se ja raha hoon.' : 'No solved problem of yours is close enough — working from this problem itself.'
    });
  } else {
    lines.push({ text: hinglish ? 'Isi problem se ja raha hoon.' : 'Working from this problem.' });
  }

  // L5 — always last, and it is the current action, so it is not muted.
  lines.push({ text: hinglish ? 'Likh raha hoon.' : 'Writing.', final: true });

  // Budget: drop the least informative first (L1), then the second anchor.
  for (const rank of [1, 2]) {
    while (lines.length > PROGRESS_MAX_LINES) {
      const i = lines.findIndex((l) => l.drop === rank);
      if (i === -1) break;
      lines.splice(i, 1);
    }
  }
  while (lines.length > PROGRESS_MAX_LINES) lines.splice(1, 1);

  return lines.map((l) => ({ text: l.text, final: l.final === true }));
}

// The bubble is built at FULL HEIGHT with every line at opacity 0, so its
// height is final at frame one and the entire wait is opacity-only. That is
// what stops it fighting scrollTranscript(). The stagger is CSS
// transition-delay, not setTimeout: there is no timer to leak, cancellation is
// one class change, and it works while the panel is hidden.
function makePendingBubble(lines) {
  const wrap = el('div', 'bubble-row tutor pending');
  const bubble = el('div', 'bubble tutor');
  const list = el('div', 'think-list');
  const items = Array.isArray(lines) && lines.length ? lines : [{ text: 'Writing.', final: true }];
  items.forEach((line, i) => {
    const node = el('div', 'think-line', line.text);
    if (line.final) node.classList.add('is-final');
    node.style.setProperty('--i', String(i));
    list.appendChild(node);
  });
  bubble.appendChild(list);
  const live = el('span', 'sr-only');
  live.setAttribute('aria-live', 'polite');
  bubble.appendChild(live);
  wrap.appendChild(bubble);
  wrap._live = live;
  return wrap;
}

function announce(pending, text) {
  if (pending && pending._live) pending._live.textContent = text;
}

function lastThinkLine(pending) {
  const list = pending.querySelector('.think-list');
  return list ? list.lastElementChild : null;
}

function clearWaitTimers() {
  const t = problem.waitTimers;
  if (!t) return;
  clearTimeout(t.long);
  clearTimeout(t.probe);
  clearTimeout(t.decide);
  clearInterval(t.elapsed);
  problem.waitTimers = { long: null, probe: null, decide: null, elapsed: null };
}

function armWaitTimers(pending) {
  clearWaitTimers();
  const gen = problem.gen;
  const t = problem.waitTimers;
  t.long = setTimeout(() => {
    if (gen === problem.gen) onLongWait(pending);
  }, LONG_WAIT_MS);
  t.probe = setTimeout(() => {
    if (gen !== problem.gen) return;
    // A recent successful call already proves the server is awake.
    if (Date.now() - health.okAt < 5000) {
      problem.probeResult = 'warm';
      return;
    }
    api.health()
      .then((r) => { problem.probeResult = r && r.ok ? 'warm' : 'cold'; })
      .catch(() => { problem.probeResult = 'cold'; });
  }, PROBE_AT_MS);
  t.decide = setTimeout(() => {
    if (gen === problem.gen && problem.probeResult !== 'warm') enterColdState(pending);
  }, COLD_DECIDE_MS);
}

// Past p95 (5.1s measured), so "longer than usual" is a true statement rather
// than an anxious one. The last line's text is REPLACED, never appended, so
// the bubble height does not change.
function onLongWait(pending) {
  if (!pending.isConnected) return;
  problem.waitPhase = 'long';
  pending.classList.add('is-long');
  const hinglish = lang() === 'hinglish';
  const copy = problem.probeResult === 'warm'
    ? (hinglish ? 'Abhi bhi likh raha hoon. Shayad doosra draft ho raha hai.' : 'Still writing. It may be on a second draft.')
    : (hinglish ? 'Abhi bhi likh raha hoon. Thoda zyada lag raha hai.' : 'Still writing. Longer than usual.');
  const line = lastThinkLine(pending);
  if (line) {
    line.classList.add('is-swapping');
    exitThen(line, MOTION.d1, () => {
      line.textContent = copy;
      line.classList.remove('is-swapping');
    });
  }
  announce(pending, copy);
}

// The server sleeps on the free plan. A 20-60s wake can still succeed inside
// the 60s client timeout, so this narrates the wake rather than giving up.
function enterColdState(pending) {
  if (!pending.isConnected || problem.waitPhase === 'cold') return;
  problem.waitPhase = 'cold';
  pending.classList.add('is-cold');
  const hinglish = lang() === 'hinglish';
  const head = hinglish ? 'Server so gaya tha; jaga raha hoon.' : 'The server was asleep. Waking it up.';
  const list = pending.querySelector('.think-list');
  if (list) {
    preserveScroll(() => {
      clear(list);
      const a = el('div', 'think-line', head);
      a.style.setProperty('--i', '0');
      const b = el('div', 'think-line is-final', hinglish ? '0s' : '0s');
      b.style.setProperty('--i', '1');
      list.appendChild(a);
      list.appendChild(b);
      flush(list);
      enter(a, { dur: MOTION.d2 });
      enter(b, { dur: MOTION.d2, delay: 80 });
      // The stagger classes no longer apply to these; show them outright.
      a.style.opacity = '1';
      a.style.transform = 'none';
      b.style.opacity = '1';
      b.style.transform = 'none';
      const started = problem.sendStartedAt || Date.now();
      problem.waitTimers.elapsed = setInterval(() => {
        if (!b.isConnected) return;
        // Always recomputed from the clock, so a hidden panel never shows a
        // stale count when it comes back.
        b.textContent = `${Math.round((Date.now() - started) / 1000)}s`;
      }, 1000);
    });
  }
  banners.waking = true;
  renderBanners();
  announce(pending, head);
}

// Below 600ms an exit animation IS most of the wait and reads as latency the
// panel invented, so the swap is instant.
function settlePending(pending, node, insert) {
  const quick = Date.now() - (problem.sendStartedAt || 0) < SETTLE_MIN_MS;
  if (quick || !canMove()) {
    pending.remove();
    insert();
    scrollTranscript();
    return;
  }
  pending.classList.add('is-out');
  exitThen(pending, 140, () => {
    pending.remove();
    preserveScroll(insert);
    if (node) enter(node, { dur: MOTION.d3 });
  });
}


// The meter renders the rung the SERVER RETURNED, never the depth requested.
function depthMeterText(rung, degraded, newest) {
  if (degraded) return 'fallback';
  const word = (DEPTH_WORD[lang()] || DEPTH_WORD.english)[rung];
  if (!word) return '';
  return newest ? `${DEPTH_DOTS[rung]} ${word}` : word;
}

function firstHabitOf(message) {
  const shown = Array.isArray(message.habits_shown) ? message.habits_shown : Array.isArray(message.habits) ? message.habits : [];
  return shown.find((h) => h && (h.statement || h.key)) || null;
}

// The in-flow kill for a stale habit. Only dismissal is captured in v1.
function makeHabitNote(habit) {
  const note = el('div', 'habit-note');
  const text = el('span', 'habit-note-text');
  text.appendChild(document.createTextNode(pick('Your pattern: ', 'Tumhara pattern: ')));
  text.appendChild(renderInline(habit.statement || habit.key));
  note.appendChild(text);
  const notMe = button('link', pick('not me', 'main nahi'), async () => {
    if (!habit.id) return;
    notMe.disabled = true;
    const result = await api.habitFeedback(habit.id, { reaction: 'dismissed' });
    if (!result.ok) {
      notMe.disabled = false;
      setStatus(result.status === 401 ? 'Token expired.' : 'Could not save your answer.', 'error');
      return;
    }
    invalidateMe();
    clear(note);
    note.appendChild(el('span', 'habit-note-text', pick('Noted. It will not be mentioned again.', 'Note kar liya. Dobara nahi bolunga.')));
  });
  note.appendChild(notMe);
  return note;
}

function makeTutorBubble(message, opts = {}) {
  const newest = opts.newest === true;
  const rung = Number(message.rung) || null;
  const wrap = el('div', 'bubble-row tutor');
  const bubble = el('div', 'bubble tutor');
  if (message.degraded) bubble.classList.add('degraded');
  const body = el('div', 'bubble-body');
  body.appendChild(renderModelText(message.content || '', { allowFence: rung === 4 }));
  bubble.appendChild(body);

  const habit = firstHabitOf(message);
  if (habit) bubble.appendChild(makeHabitNote(habit));

  const foot = el('div', 'bubble-foot');
  const meter = el('span', 'depth-meter', depthMeterText(rung, message.degraded, newest));
  foot.appendChild(meter);
  // The hint is read first; the meter settles after it. Only ever on the
  // newest bubble, and never when a previous bubble is demoted.
  if (newest && rung && rung !== problem.lastRungShown) enter(meter, { y: 0, dur: 240, delay: 200 });
  if (newest && rung) problem.lastRungShown = rung;
  const right = el('span', 'row');
  if (CFG.ENV !== 'production' && rung) {
    right.appendChild(el('span', 'dev-rung', `Rung ${rung} · ${DEV_DEPTH_LABEL[rung] || rung}`));
  }
  foot.appendChild(right);
  bubble.appendChild(foot);

  const noteWrap = el('div', 'missed-note hidden');
  const noteInput = el('textarea');
  noteInput.rows = 2;
  noteInput.placeholder = pick('What was off? (optional)', 'Kya galat tha? (optional)');
  const noteSend = button('btn tiny', 'Send');
  noteWrap.appendChild(noteInput);
  noteWrap.appendChild(noteSend);
  bubble.appendChild(noteWrap);

  const post = async (payload) => {
    if (!message.id) {
      setStatus('This reply cannot take feedback.', 'error');
      return false;
    }
    const result = await api.messageFeedback(message.id, payload);
    if (!result.ok) {
      setStatus(result.status === 401 ? 'Token expired.' : 'Could not save feedback.', 'error');
      return false;
    }
    return true;
  };

  const collapse = () => {
    show(noteWrap, false);
  };
  const missed = button('link missed', pick('hint missed?', 'hint miss hua?'), () => {
    // The signal is banked immediately, even if they type nothing.
    post({ thumb: 'down' }).catch(() => {});
    missed.remove();
    show(noteWrap, true);
    noteInput.focus();
  });
  noteSend.addEventListener('click', async () => {
    const text = noteInput.value.trim();
    if (!text) {
      collapse();
      return;
    }
    if (await post({ thumb: 'down', note: text.slice(0, 500) })) {
      clear(noteWrap);
      noteWrap.appendChild(el('span', 'slot-text', pick('Sent. Thank you.', 'Bhej diya. Shukriya.')));
    }
  });
  noteInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      collapse();
    }
  });
  noteInput.addEventListener('blur', () => {
    if (!noteInput.value.trim()) collapse();
  });

  if (newest && message.feedback_thumb === 'down') {
    right.appendChild(el('span', 'slot-text', pick('Sent. Thank you.', 'Bhej diya. Shukriya.')));
  } else if (newest) {
    right.appendChild(missed);
  }

  // When the next hint arrives the link leaves this bubble, answered or not.
  wrap.demote = () => {
    meter.textContent = depthMeterText(rung, message.degraded, false);
    missed.remove();
    show(noteWrap, false);
  };
  wrap.appendChild(bubble);
  return wrap;
}

// ---- verdict dividers and the AC moment ----
function dividerNode(text) {
  return el('div', 'divider', text);
}

function syncJudgingDivider(ctx) {
  const refs = problem.refs;
  if (!refs) return;
  const judgingSlug = ctx && ctx.judging ? ctx.judging.title_slug || ctx.judging.slug || null : null;
  const judging = Boolean(ctx && ctx.judging && (!judgingSlug || judgingSlug === problem.slug));
  if (judging && !problem.judgingNode) {
    clearPrimer();
    problem.judgingNode = dividerNode('— judging… —');
    refs.transcript.appendChild(problem.judgingNode);
    scrollTranscript();
    return;
  }
  if (!judging && problem.judgingNode) {
    problem.judgingNode.remove();
    problem.judgingNode = null;
  }
}

function appendVerdictDivider(attempt) {
  const refs = problem.refs;
  if (!refs || !attempt) return;
  if (problem.judgingNode) {
    problem.judgingNode.remove();
    problem.judgingNode = null;
  }
  clearPrimer();
  // Verdict names stay in English in both languages: they are LeetCode's own words.
  const node = dividerNode(`— submitted: ${failDescription(attempt)} —`);

  if (document.hidden) {
    refs.transcript.appendChild(node);
    problem.pendingReveal = attempt;
    return;
  }

  if (!atBottom()) {
    // They are reading further up. Offer it; never yank the viewport.
    refs.transcript.appendChild(node);
    showNewBelow(`${failDescription(attempt)} ↓`);
    return;
  }

  node.classList.add("is-enter");
  refs.transcript.appendChild(node);
  flush(node);
  node.classList.remove("is-enter");
  scrollTranscript();
}

// A local line, no hint spent: free retrieval practice at the one moment a
// finished student will spend effort willingly.
function appendAcLine(attempt) {
  const refs = problem.refs;
  if (!refs) return;
  const hinglish = lang() === 'hinglish';
  const attempts = Number(attempt && attempt.result ? attempt.result.submissions_here : NaN);
  const ordinal = ordinalWord(attempts, lang());
  const anchors = problem.anchors && Array.isArray(problem.anchors.anchors) ? problem.anchors.anchors : [];
  const anchor = anchors.find((a) => a && Number(a.attempts_to_ac) > 0) || null;
  const parts = [];
  parts.push(ordinal ? (hinglish ? `Accepted — ${ordinal} attempt.` : `Accepted — ${ordinal} attempt.`) : 'Accepted.');
  if (anchor) {
    const took = countWord(anchor.attempts_to_ac, lang());
    const title = anchor.title || anchor.slug;
    parts.push(hinglish ? `${title} me ${took} lage the.` : `${title} took you ${took}.`);
  }
  parts.push(hinglish ? 'Batao aakhir kya click hua?' : 'Want to say what finally clicked?');
  clearPrimer();
  refs.transcript.appendChild(el('div', 'local-line', parts.join(' ')));
  scrollTranscript();
}

// ---- data loading ----
async function loadProblemData(gen) {
  const { slug, tabId } = problem;
  let ping = false;
  try {
    await tabCall(tabId, 'lc:ping', {}, PING_TIMEOUT_MS);
    ping = true;
  } catch (_) {
    ping = false;
  }
  if (gen !== problem.gen) return;
  problem.pingOk = ping;
  banners.reload_tab = !ping;
  renderBanners();
  if (ping) checkWhoami(tabId, gen, false).catch(() => {});

  await Promise.all([
    (async () => {
      await ensureProblemSent(slug, tabId, ping, gen);
      if (gen !== problem.gen) return;
      await loadAnchors(gen, false);
    })(),
    loadHistory(gen)
  ]);
}

async function checkWhoami(tabId, gen, force) {
  const now = Date.now();
  if (!force && problem.whoami.at && now - problem.whoami.at < WHOAMI_TTL_MS) return;
  let reply;
  try {
    reply = await tabCall(tabId, 'lc:whoami', {}, WHOAMI_TIMEOUT_MS);
  } catch (_) {
    return;
  }
  if (gen !== problem.gen) return;
  const code = lcErrorCode(reply);
  if (code) {
    applyLcErrorCode(code);
    return;
  }
  const signedIn = unwrap(reply, 'isSignedIn');
  problem.whoami = { at: Date.now(), signedIn: signedIn === null ? null : Boolean(signedIn) };
  banners.lc_logged_out = signedIn === false;
  if (signedIn === true) banners.challenge = false;
  renderBanners();
}

async function ensureProblemSent(slug, tabId, ping, gen) {
  const sent = (await getLocal('problemsSent')) || {};
  if (sent[slug]) return;
  if (!ping) return;
  let reply;
  try {
    reply = await tabCall(tabId, 'lc:fetch_problem', { slug }, FETCH_PROBLEM_TIMEOUT_MS);
  } catch (_) {
    return;
  }
  if (gen !== problem.gen) return;
  const code = lcErrorCode(reply);
  if (code) {
    applyLcErrorCode(code);
    return;
  }
  const meta = unwrap(reply, 'meta');
  if (!meta || typeof meta !== 'object') return;
  if (meta.title) {
    problem.title = meta.title;
    problem.difficulty = meta.difficulty || problem.difficulty;
    renderSubtitle();
  }
  const result = await api.putProblem(slug, meta);
  if (gen !== problem.gen) return;
  if (result.ok) {
    const latest = (await getLocal('problemsSent')) || {};
    latest[slug] = Date.now();
    await setLocal({ problemsSent: latest });
    return;
  }
  if (result.status === 0) {
    // Server unreachable: hand the metadata to the background queue.
    chrome.runtime.sendMessage({ type: 'problem:meta', slug, meta }).catch(() => {});
    banners.waking = true;
    renderBanners();
  }
}

function anchorsMemoKey() {
  return `${problem.tabId}:${problem.slug}`;
}

function anchorsLocalKey(slug) {
  return `anchors:${slug || problem.slug}`;
}

function syncedAtKey() {
  return (state.profileSummary && state.profileSummary.synced_at) || null;
}

async function readAnchorsCache() {
  const now = Date.now();
  const key = anchorsMemoKey();
  const memo = problem.anchorsMemo.get(key);
  if (memo && memo.syncedAt === syncedAtKey() && now - memo.fetchedAt < ANCHORS_TTL_MS) return memo.data;
  const ctx = await getCtx(problem.tabId);
  const cached = ctx && ctx.anchors;
  if (cached && cached.slug === problem.slug && cached.syncedAt === syncedAtKey() && now - (cached.fetchedAt || 0) < ANCHORS_TTL_MS && cached.data) {
    problem.anchorsMemo.set(key, { syncedAt: cached.syncedAt, fetchedAt: cached.fetchedAt, data: cached.data });
    return cached.data;
  }
  // Durable per-slug fallback: a cold dyno must not open with a spinner.
  const stored = await getLocal(anchorsLocalKey());
  if (stored && stored.slug === problem.slug && stored.syncedAt === syncedAtKey() && now - (stored.fetchedAt || 0) < ANCHORS_LOCAL_TTL_MS && stored.data) {
    return stored.data;
  }
  return null;
}

async function writeAnchorsCache(data) {
  const entry = { slug: problem.slug, syncedAt: syncedAtKey(), fetchedAt: Date.now(), data };
  problem.anchorsMemo.set(anchorsMemoKey(), entry);
  await setLocal({ [anchorsLocalKey()]: entry });
  await mergeCtx(problem.tabId, { anchors: entry });
}

async function invalidateAnchorsCache() {
  problem.anchorsMemo.delete(anchorsMemoKey());
  await removeLocal(anchorsLocalKey());
  await mergeCtx(problem.tabId, { anchors: null });
}

async function loadAnchors(gen, force) {
  problem.anchorsLoading = true;
  problem.anchorsError = null;
  renderMemoryBlock();
  let data = force ? null : await readAnchorsCache();
  if (gen !== problem.gen) return;
  if (!data) {
    const result = await api.anchors(problem.slug);
    if (gen !== problem.gen) return;
    if (result.ok && result.data) {
      data = result.data;
      writeAnchorsCache(data).catch(() => {});
      banners.waking = false;
    } else {
      problem.anchorsError = result;
      if (result.status === 0) banners.waking = true;
      if (result.status === 401) scheduleCompute(0);
    }
  }
  problem.anchorsLoading = false;
  if (data) {
    problem.anchors = data;
    if (data.title) problem.title = data.title;
    if (data.difficulty) problem.difficulty = data.difficulty;
    applyAllowedRung(data.allowed_rung, data.unlock_reason, { submissionsHere: Number(data.submissions_here) || 0 });
  }
  renderSubtitle();
  renderMemoryBlock();
  refreshPrimer();
  renderStance();
  renderSlot();
  renderBanners();
}

function applyAllowedRung(serverAllowed, serverReason, facts) {
  const session = problem.history && problem.history.session;
  const turns = session ? Number(session.turn_count) || 0 : 0;
  const planStated = Boolean(session && session.plan_text);
  const submissionsHere = facts && facts.submissionsHere !== undefined
    ? facts.submissionsHere
    : problem.anchors ? Number(problem.anchors.submissions_here) || 0 : 0;
  const estimate = estimateAllowedRung({ planStated, submissionsHere, turns });
  const server = Number(serverAllowed) || 0;
  problem.allowedRung = Math.max(1, Math.min(4, Math.max(server, estimate)));
  problem.unlockReason = server >= estimate && serverReason !== undefined ? serverReason : estimateUnlockReason({ planStated, submissionsHere, turns });
  // The computed-depth path never requests above 3; rung 4 comes from the gate only.
  problem.allowed = Math.min(3, problem.allowedRung);
}

async function loadHistory(gen) {
  const result = await api.history(problem.slug);
  if (gen !== problem.gen) return;
  if (result.ok && result.data) {
    problem.history = result.data;
    problem.historyError = null;
    const messages = Array.isArray(result.data.messages) ? result.data.messages : [];
    const lastTutor = [...messages].reverse().find((m) => m.role !== 'user');
    if (lastTutor && lastTutor.rung) {
      problem.lastRung = Number(lastTutor.rung) || 0;
    }
    problem.typedTurns = messages.filter((m) => m && m.role === 'user').length;
    if (problem.anchors) applyAllowedRung(problem.anchors.allowed_rung, problem.anchors.unlock_reason);
    else applyAllowedRung(0, undefined);
  } else {
    problem.history = result.status === 404 ? { session: null, messages: [] } : null;
    problem.historyError = result.error || `http_${result.status}`;
    if (result.status === 0) banners.waking = true;
  }
  // The stall timer is never armed for hints restored from history.
  renderTranscript();
  renderStance();
  renderSlot();
  renderBanners();
}

// ---- send ----
async function readEditorCode() {
  const refs = problem.refs;
  if (problem.pasteVisible && refs.paste.value.trim()) return { code: refs.paste.value, lang: null, source: 'paste' };
  try {
    const reply = await tabCall(problem.tabId, 'editor:get_code', {}, GET_CODE_TIMEOUT_MS);
    const code = unwrap(reply, 'code');
    const language = unwrap(reply, 'lang');
    if (typeof code === 'string' && code.trim()) return { code, lang: typeof language === 'string' ? language : null, source: 'editor' };
  } catch (_) {
    // fall through to the paste box
  }
  return { code: null, lang: null, source: null };
}

function showPasteBox() {
  const refs = problem.refs;
  if (!refs) return;
  problem.pasteVisible = true;
  show(refs.pasteWrap, true);
}

function chatErrorCopy(result) {
  if (result.status === 429 && result.error === 'daily_cap') return 'Daily hint cap reached. It resets at 00:00 UTC.';
  if (result.status === 429) return 'Too many hints in a minute. Wait a little.';
  if (result.status === 409 && result.error === 'not_synced') return 'Sync your history first.';
  if (result.status === 409 && result.error === 'problem_not_cached') return 'Reload the LeetCode tab so Anchor can read this problem, then try again.';
  if (result.status === 403 && result.error === 'contest_mode') return 'Anchor is locked during contests.';
  if (result.status === 403) return 'Access denied.';
  if (result.status === 503) return 'Hints are paused right now.';
  if (result.status === 401) return 'Token expired. Paste a new one.';
  if (result.error === 'timeout' || result.error === 'aborted') return 'The tutor took too long. Try again.';
  if (result.status === 0) return "Could not reach Anchor's server.";
  return `Hint failed (${result.error || result.status}).`;
}

/**
 * @param {{text?: string, fromStall?: boolean, fromGate?: boolean}} [options]
 */
async function sendMessage(options = {}) {
  const refs = problem.refs;
  if (!refs || problem.sending) return;
  const fromStall = options.fromStall === true;
  const fromGate = options.fromGate === true;
  const typed = fromStall || fromGate ? String(options.text || '').trim() : refs.input.value.trim();
  if (!typed) {
    setStatus(pick('Type where you are stuck.', 'Likho kahan atke ho.'), 'error');
    return;
  }

  // The typed ask for the shape opens the gate; it never sends rung 4 by itself,
  // and their sentence stays in the composer.
  if (!fromGate && !fromStall && !problem.gateOpen && matchesRung4Intent(typed)) {
    if (problem.allowedRung === 4) {
      openGate('typed');
      return;
    }
    // Below the gate the same ask sends as an ordinary turn; nothing lights up.
    problem.belowGate = true;
  } else if (!fromGate) {
    problem.belowGate = false;
  }
  if (!fromGate && !fromStall && !matchesRung4Intent(typed) && BEG_RE.test(typed) && problem.allowedRung === 4) {
    api.clientEvent('rung4_near_miss', { slug: problem.slug, chars: typed.length }).catch(() => {});
  }

  if (!fromGate && problem.gateOpen) closeGate(true);

  const gen = problem.gen;
  problem.sending = true;
  refs.send.disabled = true;
  refs.send.classList.add("is-busy");
  clearStall();
  problem.stallDue = null;
  if (!fromStall && problem.lastUserText && similarity(problem.lastUserText, typed) >= REPEAT_SIMILARITY && problem.lastHint) {
    api.clientEvent('hint_repeat', {
      message_id: problem.lastHint.message_id,
      rung: problem.lastHint.rung,
      similarity: Math.round(similarity(problem.lastUserText, typed) * 100) / 100
    }).catch(() => {});
  }
  emitHintOutcome('reply', { replied_chars: typed.length });
  if (!fromStall) problem.lastUserText = typed;
  if (!fromStall && !fromGate) refs.input.value = '';
  renderComposer();
  renderStance();
  renderSlot();

  const consent = await Ext.getConsent();
  let code = null;
  let codeLang = null;
  if (consent) {
    const read = await readEditorCode();
    code = read.code;
    codeLang = read.lang;
    if (code === null) {
      showPasteBox();
      setStatus('Could not read the editor; sending without code.', 'info');
    }
  }
  if (gen !== problem.gen) return;

  if (problem.history && Array.isArray(problem.history.messages)) problem.history.messages.push({ role: 'user', content: typed });
  clearPlaceholder();
  refs.transcript.appendChild(makeUserBubble(typed));
  // Every input the narration names is already resolved above: consent, the
  // editor read, the verdict, the anchors. Nothing here is guessed.
  const pending = makePendingBubble(buildProgressLines({ consent, code, codeLang }));
  refs.transcript.appendChild(pending);
  problem.pendingNode = pending;
  // One forced reflow that doubles as the style flush for the stagger, and
  // gives the travelling rule the exact height of what it narrates.
  const pendingH = pending.offsetHeight;
  pending.style.setProperty("--rule-travel", Math.max(0, pendingH - 28) + "px");
  pending.classList.add("is-running");
  problem.sendStartedAt = Date.now();
  problem.waitPhase = "normal";
  problem.probeResult = null;
  armWaitTimers(pending);
  scrollTranscript();

  const lastRung = Number(problem.lastRung) || 0;
  const allowed = Math.max(1, Math.min(3, Number(problem.allowed) || 1));
  const failedSince = problem.failedSince === true;
  const sentFromStallAffordance = fromStall;
  const gateOpen = fromGate;
  const body = { title_slug: problem.slug, message: typed, is_contest: false };

  // policy.js:21-22 is `const wanted = requestedRung || floor; rung = max(floor, min(wanted, max))`.
  // Sending null pins EVERY hint at rung 1 except inside the 30-minute post-failure window.
  // Always send a number. Do not "simplify" this back to null.
  let depth = (lastRung === 0) ? 1 : Math.min(lastRung + 1, allowed);
  if (failedSince) depth = allowed;            // a real failure JUMPS, it does not step
  if (sentFromStallAffordance) depth = Math.max(1, lastRung);   // a tap never buys depth
  body.requested_rung = gateOpen ? 4 : depth;

  if (code) body.code = code;
  if (codeLang) body.lang = codeLang;

  const controller = new AbortController();
  problem.controller = controller;
  const timer = setTimeout(() => {
    api.clientEvent('hint_timeout', { slug: problem.slug, rung: body.requested_rung, timeout_ms: CHAT_TIMEOUT_MS }).catch(() => {});
    controller.abort();
  }, CHAT_TIMEOUT_MS);
  const result = await api.chat(body, { signal: controller.signal });
  clearTimeout(timer);
  if (gen !== problem.gen) return;
  problem.controller = null;
  problem.sending = false;
  refs.send.disabled = false;
  refs.send.classList.remove("is-busy");
  clearWaitTimers();
  renderComposer();

  if (!result.ok || !result.data) {
    // Roll the optimistic user turn back and redraw from history.
    pending.remove();
    problem.pendingNode = null;
    if (problem.history && Array.isArray(problem.history.messages)) problem.history.messages.pop();
    renderTranscript();
    if (!fromStall && !fromGate) refs.input.value = typed;
    if (result.status === 429 && result.error === 'daily_cap') problem.capHit = true;
    setStatus(chatErrorCopy(result), 'error');
    renderStance();
    renderSlot();
    if (result.status === 401 || result.status === 426 || (result.status === 409 && result.error === 'not_synced')) {
      invalidateMe();
      scheduleCompute(0);
    }
    if (result.status === 403 && result.error === 'contest_mode') scheduleCompute(0);
    if (result.status === 409 && result.error === 'problem_not_cached') {
      // The PUT /problems never happened (lc:ping failed): the reload banner is the recovery path.
      banners.reload_tab = true;
      renderBanners();
    }
    if (result.status === 503) {
      banners.degraded = true;
      renderBanners();
    }
    if (result.status === 0 && result.error === 'network') {
      banners.waking = true;
      health.okAt = 0;
      renderBanners();
      scheduleCompute(0);
    }
    return;
  }

  const data = result.data;
  const tutorMessage = {
    id: data.message_id,
    role: 'assistant',
    content: data.reply,
    rung: data.rung,
    degraded: data.degraded,
    habits_shown: Array.isArray(data.habits_shown) ? data.habits_shown : []
  };
  if (problem.history && Array.isArray(problem.history.messages)) problem.history.messages.push(tutorMessage);
  if (problem.history) {
    problem.history.session = problem.history.session || { turn_count: 0, plan_text: null, max_rung: 0 };
    problem.history.session.turn_count = (Number(problem.history.session.turn_count) || 0) + 1;
  }
  if (problem.newestBubble && typeof problem.newestBubble.demote === 'function') problem.newestBubble.demote();
  const bubble = makeTutorBubble(tutorMessage, { newest: true });
  problem.newestBubble = bubble;
  settlePending(pending, bubble, () => refs.transcript.appendChild(bubble));
  problem.pendingNode = null;

  // The tutor states its contract instead of silently down-clamping.
  if (!fromGate && BEG_RE.test(typed) && Number(data.allowed_rung_next) === 4) {
    bubble.appendChild(el('div', 'refusal', pick(
      "I don't hand over solutions. I can lay out the skeleton with the key lines blank — say the word.",
      'Main solution nahi deta. Skeleton de sakta hoon, key lines blank — bas bol do.'
    )));
  }
  scrollTranscript();

  problem.lastRung = Number(data.rung) || problem.lastRung;
  if (data.allowed_rung_next) {
    problem.allowedRung = Math.max(1, Math.min(4, Number(data.allowed_rung_next)));
    problem.unlockReason = data.unlock_reason === undefined ? problem.unlockReason : data.unlock_reason;
  }
  problem.allowed = Math.min(3, problem.allowedRung);
  problem.failedSince = false;
  if (!fromStall) problem.typedTurns += 1;
  problem.previousTurnTyped = !fromStall;
  problem.lastHint = {
    message_id: data.message_id,
    rung: Number(data.rung) || null,
    slug: problem.slug,
    at: Date.now(),
    attempts_at_hint: problem.anchors ? Number(problem.anchors.submissions_here) || 0 : 0,
    done: false
  };
  if (fromGate) {
    api.clientEvent('rung4_asked', {
      slug: problem.slug,
      turns: problem.history && problem.history.session ? Number(problem.history.session.turn_count) || 0 : 0,
      submissions_here: problem.anchors ? Number(problem.anchors.submissions_here) || 0 : 0,
      granted: Number(data.rung) === 4
    }).catch(() => {});
    problem.gateOpen = false;
    problem.gateSent = false;
    problem.gateDraft = '';
  }
  problem.gateDismissed = false;
  armStall(data.message_id);
  armSilence();
  renderSlot();
  renderStance();
  banners.degraded = Boolean(data.degraded);
  banners.waking = false;
  renderBanners();
  invalidateMe();
  if (!fromStall && !fromGate) refs.input.focus();
  growInput();
}

// ---- capture ----
async function manualCapture(trigger) {
  const refs = problem.refs;
  if (!refs) return;
  const { slug, tabId } = problem;
  const gen = problem.gen;
  const control = trigger && typeof trigger.disabled === 'boolean' ? trigger : null;
  if (control) control.disabled = true;
  setStatus('Checking your latest submission…');
  let reply;
  try {
    reply = await tabCall(tabId, 'lc:manual_capture', { slug }, MANUAL_CAPTURE_TIMEOUT_MS);
  } catch (err) {
    if (gen === problem.gen) {
      if (control) control.disabled = false;
      if (err && err.code === 'no_receiver') {
        banners.reload_tab = true;
        renderBanners();
        setStatus('Reload the LeetCode tab first.', 'error');
      } else {
        setStatus('LeetCode did not answer in time. Try again.', 'error');
      }
    }
    return;
  }
  if (gen !== problem.gen) return;
  if (control) control.disabled = false;
  const code = lcErrorCode(reply);
  if (code) {
    applyLcErrorCode(code);
    setStatus(code === 'lc_logged_out' ? 'Sign in to LeetCode first.' : `LeetCode error: ${code}.`, 'error');
    return;
  }
  const submission = unwrap(reply, 'submission');
  const details = unwrap(reply, 'details');
  if (!submission || !submission.id) {
    setStatus('No submission found for this problem yet.', 'error');
    return;
  }
  if (submission.slug && submission.slug !== slug) {
    setStatus('Your latest submission is for a different problem.', 'error');
    return;
  }
  if (submission.status_code === null || submission.status_code === undefined) {
    if (!details || details.status_code === null || details.status_code === undefined) {
      setStatus('That submission is still being judged. Try again in a moment.', 'error');
      return;
    }
  }
  const consent = await Ext.getConsent();
  const body = buildManualAttempt(slug, submission, details, consent, Math.floor(Date.now() / 1000));
  setStatus('Recording…');
  const result = await api.postAttempt(body);
  if (gen !== problem.gen) return;
  if (result.ok) {
    const data = result.data || {};
    const attempt = { submission_id: body.submission_id, title_slug: slug, status_code: body.status_code, status_msg: body.status_msg, result: data, recordedAt: Date.now(), pending: false };
    problem.lastVerdict = attempt;
    setStatus(`Recorded: ${verdictLabel(body.status_code, body.status_msg)}${data.is_first_ac ? ' (first accepted)' : ''}.`, 'success');
    onVerdict(attempt);
    await invalidateAnchorsCache();
    invalidateMe();
    const me = await getMe(true);
    if (gen !== problem.gen) return;
    if (me.ok) problem.me = me.data;
    await loadAnchors(gen, true);
    if (data.allowed_rung_next) {
      problem.allowedRung = Math.max(problem.allowedRung, Math.min(4, Number(data.allowed_rung_next)));
      problem.allowed = Math.min(3, problem.allowedRung);
    }
    renderSlot();
    renderStance();
    renderCodeNote();
    return;
  }
  if (result.status === 0) {
    const { code: bodyCode, ...verdict } = body;
    chrome.runtime.sendMessage({
      type: 'attempt:captured',
      title_slug: slug,
      captured_via: 'manual',
      submission_id: body.submission_id,
      verdict,
      code: bodyCode,
      lang: body.lang
    }).catch(() => {});
    setStatus('Server unreachable; the verdict is queued and will be sent later.', 'info');
    banners.waking = true;
    renderBanners();
    return;
  }
  if (result.status === 401) {
    scheduleCompute(0);
    return;
  }
  setStatus(`Could not record the verdict (${result.error || result.status}).`, 'error');
}

// One place where a verdict becomes visible: a divider, the failure jump, and
// (on Accepted) the local self-explanation line.
function onVerdict(attempt) {
  if (!attempt || !problem.refs) return;
  const id = attempt.submission_id;
  if (id !== null && id !== undefined) {
    if (!problem.verdictsSeen) problem.verdictsSeen = new Set();
    if (problem.verdictsSeen.has(id)) return;
    problem.verdictsSeen.add(id);
  }
  const isAc = Number(attempt.status_code) === 10;
  appendVerdictDivider(attempt);
  const bucket = attempt.result && attempt.result.bucket ? attempt.result.bucket : null;
  if (isAc) {
    const hint = problem.lastHint;
    if (hint && !hint.acEmitted && Date.now() - (hint.at || 0) <= HINT_TO_AC_MS) {
      hint.acEmitted = true;
      api.clientEvent('hint_to_ac', {
        message_id: hint.message_id,
        rung: hint.rung,
        minutes: Math.round((Date.now() - (hint.at || Date.now())) / 60000),
        attempts_since: Math.max(0, (Number(attempt.result && attempt.result.submissions_here) || 0) - (hint.attempts_at_hint || 0))
      }).catch(() => {});
    }
    emitHintOutcome('submit_ac', { bucket });
    appendAcLine(attempt);
    problem.failedSince = false;
  } else {
    // A real failure JUMPS: the next hint is a diagnostic whatever they type.
    problem.failedSince = true;
    emitHintOutcome('submit_fail', { bucket });
  }
  renderSlot();
  renderStance();
  renderComposer();
}

async function onAttemptRecorded(message) {
  if (state.view !== 'PROBLEM' || !problem.refs) return;
  const sameTab = message.tabId === null || message.tabId === undefined || message.tabId === problem.tabId;
  const sameSlug = !message.title_slug || message.title_slug === problem.slug;
  if (!sameTab && !sameSlug) return;
  const gen = problem.gen;
  const ctx = await getCtx(problem.tabId);
  if (gen !== problem.gen) return;
  applyCtx(ctx);
  const attempt = ctx && ctx.lastAttempt && ctx.lastAttempt.title_slug === problem.slug ? ctx.lastAttempt : null;
  if (attempt) {
    problem.lastVerdict = { ...attempt, result: message.result || attempt.result, pending: false };
    setStatus(`Verdict recorded: ${verdictLabel(attempt.status_code, attempt.status_msg)}.`, 'success');
    onVerdict(problem.lastVerdict);
  }
  await invalidateAnchorsCache();
  invalidateMe();
  const me = await getMe(true);
  if (gen !== problem.gen) return;
  if (me.ok) problem.me = me.data;
  await loadAnchors(gen, true);
  const result = message.result || {};
  if (result.allowed_rung_next) {
    problem.allowedRung = Math.max(problem.allowedRung, Math.min(4, Number(result.allowed_rung_next)));
    problem.allowed = Math.min(3, problem.allowedRung);
  }
  renderSlot();
  renderStance();
  renderCodeNote();
}

// ---------------------------------------------------------------------------
// footer: version, last sync, report an issue
// ---------------------------------------------------------------------------
function refreshFooter() {
  els.footVersion.textContent = CFG.ENV === 'production' ? `v${CFG.EXT_VERSION}` : `v${CFG.EXT_VERSION} · ${CFG.ENV}`;
  const summary = state.profileSummary || {};
  els.footSync.textContent = `sync: ${formatRelative(summary.synced_at, Date.now())}`;
}

function toggleIssueForm(visible) {
  show(els.issueForm, visible);
  if (visible) els.issueText.focus();
}

async function sendIssue() {
  const text = els.issueText.value.trim();
  if (!text) {
    setStatus('Write something first.', 'error');
    return;
  }
  const tab = await activeTab();
  const payload = {
    text: text.slice(0, ISSUE_TEXT_MAX),
    url: tab && isLcUrl(tab.url) ? tab.url.slice(0, 500) : null,
    slug: state.view === 'PROBLEM' ? problem.slug : null,
    view: state.view,
    language: await Ext.getLanguage(),
    consent_code: await Ext.getConsent(),
    theme: await Ext.getTheme(),
    ua: navigator.userAgent.slice(0, 200)
  };
  els.issueSend.disabled = true;
  const result = await api.clientEvent('issue_report', payload);
  els.issueSend.disabled = false;
  if (result.ok) {
    els.issueText.value = '';
    toggleIssueForm(false);
    setStatus('Sent. Thank you.', 'success');
    return;
  }
  if (result.error === 'missing_token' || result.status === 401) {
    setStatus('Paste a token first.', 'error');
    return;
  }
  if (result.error === 'payload_too_large') {
    setStatus('Report too long. Shorten it and send again.', 'error');
    return;
  }
  try {
    const queued = await chrome.runtime.sendMessage({ type: 'client:event', event: 'issue_report', detail: payload });
    if (queued && queued.ok) {
      els.issueText.value = '';
      toggleIssueForm(false);
      setStatus('Queued. It will send when online.', 'success');
      return;
    }
  } catch (_) {
    // fall through
  }
  setStatus('Could not send.', 'error');
}

// ---------------------------------------------------------------------------
// listeners
// ---------------------------------------------------------------------------
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    let recompute = false;
    if (changes.authToken) {
      invalidateMe();
      if (changes.authToken.newValue) state.tokenExpired = false;
      recompute = true;
    }
    if (changes.profileSummary) {
      state.profileSummary = changes.profileSummary.newValue || null;
      refreshFooter();
      recompute = true;
    }
    if (changes.syncState) recompute = true;
    if (changes.consentCode) {
      if (state.view === 'PROBLEM') renderCodeNote();
      recompute = true;
    }
    if (changes.language) {
      // Set once in the popup; this panel only mirrors it.
      state.language = changes.language.newValue === 'hinglish' ? 'hinglish' : 'english';
      invalidateMe();
      if (state.view === 'PROBLEM' && problem.refs) {
        renderMemoryBlock();
        renderStance();
        renderSlot();
        renderComposer();
        renderCodeNote();
      }
    }
    if (changes.theme) applyTheme(changes.theme.newValue || 'system');
    if (recompute) scheduleCompute();
    return;
  }
  if (area === 'session') {
    const keys = Object.keys(changes).filter((key) => key.startsWith('tab:'));
    if (!keys.length) return;
    if (state.view === 'PROBLEM' && changes[ctxKey(problem.tabId)]) {
      applyCtx(changes[ctxKey(problem.tabId)].newValue || null);
    }
    scheduleCompute();
  }
});

chrome.tabs.onActivated.addListener(() => scheduleCompute());
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.url) scheduleCompute();
});
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(() => scheduleCompute());
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === 'attempt:recorded') {
    onAttemptRecorded(message).catch(() => {});
    scheduleCompute();
  }
  return false;
});

// The footer sync item is the only place a sync can be started from a problem page.
els.footSync.addEventListener('click', () => startIncrementalSync());
els.reportIssue.addEventListener('click', () => toggleIssueForm(els.issueForm.classList.contains('hidden')));
els.issueCancel.addEventListener('click', () => toggleIssueForm(false));
els.issueSend.addEventListener('click', sendIssue);

// The stall timer only runs while the panel is visible.
document.addEventListener('visibilitychange', () => {
  if (state.view !== 'PROBLEM' || !problem.refs) return;
  if (document.visibilityState !== 'visible') {
    clearStall();
    return;
  }
  if (problem.lastHint && !problem.stallDue) armStall(problem.lastHint.message_id);
});

window.addEventListener('unload', () => {
  stopPort();
  clearTimeout(health.pollTimer);
  clearTimeout(computeTimer);
});

document.addEventListener("visibilitychange", () => {
  document.body.classList.toggle("is-hidden", document.hidden);
  if (!document.hidden && problem.pendingReveal) {
    problem.pendingReveal = null;
    scrollTranscript();
  }
});

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function init() {
  applyTheme(await Ext.getTheme());
  state.language = await Ext.getLanguage();
  state.profileSummary = (await getLocal('profileSummary')) || null;
  refreshFooter();
  renderBanners();
  await runCompute();
  setInterval(() => scheduleCompute(), RECOMPUTE_TICK_MS);
}

init().catch((err) => {
  console.error('[Anchor panel] init failed', err);
  setStatus('Anchor could not start. Reopen the panel.', 'error');
});
