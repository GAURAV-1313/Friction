'use strict';
// Anchor background service worker.
//
// Responsibilities
//   - message router for the ISOLATED content script and the extension pages
//   - per-tab context in chrome.storage.session under 'tab:<tabId>'
//       { slug, page, isContest, url, updatedAt, capture, judging, lastAttempt, needsReload }
//   - durable POST/PUT queue in chrome.storage.local.postQueue, drained
//     immediately on enqueue and by the 'anchor-queue' alarm every minute
//   - action badge with the last recorded verdict
//   - cached /health probe in chrome.storage.session.serverHealth
//
// Every backend call originates here, in the popup, or in the side panel:
// the page origin (leetcode.com) never talks to the API.
importScripts('./config.js', './anchor-setup.js');

const CFG = globalThis.ANCHOR_CONFIG;
const Ext = globalThis.AnchorExt;

const QUEUE_KEY = 'postQueue';
const QUEUE_ALARM = 'anchor-queue';
const QUEUE_TRY_TIMEOUT_MS = 20000;
const QUEUE_MAX_ATTEMPTS = 20;
const QUEUE_BASE_BACKOFF_MS = 60 * 1000;
const QUEUE_MAX_BACKOFF_MS = 60 * 60 * 1000;
const QUEUE_MAX_LENGTH = 500;
const QUEUE_DRAIN_LIMIT = 100;
const BADGE_MS = 3000;
const HEALTH_CACHE_MS = 30000;
const EVENT_PAYLOAD_MAX_CHARS = 4000;
const JUDGE_TEXT_MAX_CHARS = 8000;
const CODE_MAX_CHARS = 200000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BADGE_BY_STATUS = { 10: 'AC', 11: 'WA', 12: 'MLE', 13: 'OLE', 14: 'TLE', 15: 'RE', 20: 'CE' };

function log(...args) {
  console.log('[Anchor BG]', ...args);
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function isSlug(value) {
  return typeof value === 'string' && value.length <= 191 && SLUG_RE.test(value);
}

function clampText(value, max) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toSeconds(value) {
  const n = toNumber(value);
  if (n === null || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

async function readJson(response) {
  let text = '';
  try {
    text = await response.text();
  } catch (_) {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, QUEUE_MAX_BACKOFF_MS);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), QUEUE_MAX_BACKOFF_MS));
  return null;
}

function backoffMs(attempts) {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(QUEUE_MAX_BACKOFF_MS, QUEUE_BASE_BACKOFF_MS * 2 ** exponent);
}

// ---------------------------------------------------------------------------
// per-tab context (chrome.storage.session)
// ---------------------------------------------------------------------------
function ctxKey(tabId) {
  return `tab:${tabId}`;
}

async function getCtx(tabId) {
  const key = ctxKey(tabId);
  const stored = await chrome.storage.session.get([key]);
  return stored[key] || null;
}

async function mergeCtx(tabId, patch) {
  const key = ctxKey(tabId);
  const current = (await getCtx(tabId)) || {};
  const next = { ...current, ...patch, tabId };
  await chrome.storage.session.set({ [key]: next });
  return next;
}

async function removeCtx(tabId) {
  await chrome.storage.session.remove([ctxKey(tabId)]);
}

// ---------------------------------------------------------------------------
// badge
// ---------------------------------------------------------------------------
let badgeTimer = null;

async function flashBadge(text, color) {
  if (!text) return;
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text: text.slice(0, 4) });
  } catch (_) {
    return;
  }
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  }, BADGE_MS);
}

// ---------------------------------------------------------------------------
// durable queue (chrome.storage.local.postQueue)
// item: { id, method, path, body, kind, meta, attempts, nextAt, createdAt, lastStatus, lastError }
// kind: 'attempt' | 'problem' | 'event'
// ---------------------------------------------------------------------------
let queueChain = Promise.resolve();

async function readQueue() {
  const stored = await chrome.storage.local.get([QUEUE_KEY]);
  return Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
}

// Serialises read-modify-write cycles on the stored queue. fn(queue) mutates in place.
function mutateQueue(fn) {
  const run = queueChain.then(async () => {
    const queue = await readQueue();
    const result = await fn(queue);
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    return result;
  });
  queueChain = run.catch(() => {});
  return run;
}

function trimQueue(queue) {
  while (queue.length > QUEUE_MAX_LENGTH) {
    const eventIndex = queue.findIndex((item) => item.kind === 'event');
    queue.splice(eventIndex >= 0 ? eventIndex : 0, 1);
  }
}

async function enqueue({ method, path, body, kind, meta }) {
  const item = {
    id: crypto.randomUUID(),
    method,
    path,
    body,
    kind: kind || 'event',
    meta: meta || null,
    attempts: 0,
    nextAt: 0,
    createdAt: Date.now(),
    lastStatus: null,
    lastError: null
  };
  await mutateQueue((queue) => {
    queue.push(item);
    trimQueue(queue);
  });
  processQueue('enqueue').catch(() => {});
  return item.id;
}

async function attemptItem(item) {
  let response;
  try {
    response = await Ext.fetchWithAuth(
      item.path,
      {
        method: item.method,
        headers: { 'Content-Type': 'application/json' },
        body: item.body === undefined ? undefined : JSON.stringify(item.body)
      },
      { timeoutMs: QUEUE_TRY_TIMEOUT_MS }
    );
  } catch (err) {
    const name = err && err.name;
    return { action: 'retry', status: 0, data: null, error: name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  const data = await readJson(response);
  const status = response.status;
  if (response.ok) return { action: 'done', status, data, error: null };
  const error = data && typeof data.error === 'string' ? data.error : `http_${status}`;
  if (status === 401) return { action: 'halt', status, data, error };
  if (status === 429) {
    return { action: 'retry', status, data, error, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) };
  }
  if (status >= 400 && status < 500) return { action: 'drop', status, data, error };
  return { action: 'retry', status, data, error };
}

// Applies an outcome to the stored queue. Returns { removed, exhausted }.
function applyOutcome(queue, id, outcome, now) {
  const index = queue.findIndex((item) => item.id === id);
  if (index < 0) return { removed: true, exhausted: false };
  const item = queue[index];
  if (outcome.action === 'done' || outcome.action === 'drop') {
    queue.splice(index, 1);
    return { removed: true, exhausted: false };
  }
  if (outcome.action === 'halt') {
    item.lastStatus = outcome.status;
    item.lastError = outcome.error;
    return { removed: false, exhausted: false };
  }
  item.attempts = (item.attempts || 0) + 1;
  item.lastStatus = outcome.status;
  item.lastError = outcome.error;
  if (item.attempts >= QUEUE_MAX_ATTEMPTS) {
    queue.splice(index, 1);
    return { removed: true, exhausted: true };
  }
  const wait = outcome.retryAfterMs !== null && outcome.retryAfterMs !== undefined
    ? outcome.retryAfterMs
    : backoffMs(item.attempts);
  item.nextAt = now + wait;
  return { removed: false, exhausted: false };
}

async function onItemDone(item, outcome) {
  if (item.kind === 'attempt') {
    const meta = item.meta || {};
    const record = {
      submission_id: meta.submission_id,
      title_slug: meta.title_slug,
      status_code: item.body ? item.body.status_code : null,
      status_msg: item.body ? item.body.status_msg : null,
      captured_via: item.body ? item.body.captured_via : null,
      result: outcome.data,
      recordedAt: Date.now(),
      pending: false
    };
    if (meta.tabId !== null && meta.tabId !== undefined) {
      await mergeCtx(meta.tabId, { lastAttempt: record, judging: null });
    }
    chrome.runtime
      .sendMessage({
        type: 'attempt:recorded',
        tabId: meta.tabId === undefined ? null : meta.tabId,
        submission_id: meta.submission_id,
        title_slug: meta.title_slug,
        result: outcome.data
      })
      .catch(() => {});
    const code = item.body ? item.body.status_code : null;
    await flashBadge(BADGE_BY_STATUS[code], code === 10 ? '#22c55e' : '#f87171');
    return;
  }
  if (item.kind === 'problem') {
    const slug = item.meta && item.meta.slug;
    if (!slug) return;
    const stored = await chrome.storage.local.get(['problemsSent']);
    const sent = stored.problemsSent && typeof stored.problemsSent === 'object' ? stored.problemsSent : {};
    sent[slug] = Date.now();
    await chrome.storage.local.set({ problemsSent: sent });
  }
}

async function onItemDropped(item, outcome, reason) {
  log('queue drop', item.kind, item.method, item.path, outcome.status, reason);
  if (item.kind === 'event') return; // never chain telemetry about telemetry
  await enqueue({
    method: 'POST',
    path: '/api/lc/client-events',
    kind: 'event',
    body: {
      type: 'queue_drop',
      ext_version: CFG.EXT_VERSION,
      payload: {
        kind: item.kind,
        method: item.method,
        path: item.path,
        status: outcome.status,
        error: outcome.error || null,
        attempts: item.attempts || 0,
        reason
      }
    }
  });
}

let draining = null;

function processQueue(reason) {
  if (draining) return draining;
  draining = drainQueue(reason)
    .catch((err) => log('queue drain failed', err && err.message))
    .finally(() => {
      draining = null;
    });
  return draining;
}

async function drainQueue() {
  const skip = new Set();
  for (let i = 0; i < QUEUE_DRAIN_LIMIT; i += 1) {
    const token = await Ext.getAuthToken();
    if (!token) return; // 401 / no token: wait until a token reappears
    const now = Date.now();
    const queue = await readQueue();
    const item = queue.find((entry) => (entry.nextAt || 0) <= now && !skip.has(entry.id));
    if (!item) return;
    skip.add(item.id);

    const outcome = await attemptItem(item);
    const { removed, exhausted } = await mutateQueue((stored) => applyOutcome(stored, item.id, outcome, Date.now()));

    if (outcome.action === 'halt') return;
    if (outcome.action === 'done') {
      await onItemDone(item, outcome);
    } else if (outcome.action === 'drop') {
      await onItemDropped(item, outcome, 'rejected');
    } else if (exhausted && removed) {
      await onItemDropped(item, outcome, 'max_attempts');
    }
  }
}

async function ensureAlarm() {
  const existing = await chrome.alarms.get(QUEUE_ALARM);
  if (!existing) {
    await chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 1 });
  }
}

// ---------------------------------------------------------------------------
// /health cache (chrome.storage.session.serverHealth)
// ---------------------------------------------------------------------------
async function checkHealth({ maxAgeMs = HEALTH_CACHE_MS, force = false } = {}) {
  const stored = await chrome.storage.session.get(['serverHealth']);
  const cached = stored.serverHealth;
  if (!force && cached && Date.now() - (cached.checkedAt || 0) < maxAgeMs) return cached;
  let entry;
  try {
    const response = await Ext.fetchWithAuth('/health', { method: 'GET' }, { timeoutMs: CFG.HEALTH_TIMEOUT_MS });
    entry = { ok: response.ok, status: response.status, data: await readJson(response), error: null, checkedAt: Date.now() };
  } catch (err) {
    const name = err && err.name;
    entry = { ok: false, status: 0, data: null, error: name === 'TimeoutError' ? 'timeout' : 'network', checkedAt: Date.now() };
  }
  await chrome.storage.session.set({ serverHealth: entry });
  return entry;
}

// ---------------------------------------------------------------------------
// message handlers
// handler(message, { tabId, sender }) -> result (merged into the {ok:true} reply)
// ---------------------------------------------------------------------------
function requireTab(tabId) {
  if (tabId === null || tabId === undefined) throw new Error('no_tab');
  return tabId;
}

function buildAttemptBody(message, consent) {
  const verdict = message.verdict && typeof message.verdict === 'object' ? message.verdict : {};
  const titleSlug = message.title_slug || message.slug || verdict.title_slug;
  const submissionId = toInt(message.submission_id !== undefined ? message.submission_id : verdict.submission_id);
  const statusCode = toInt(verdict.status_code);
  if (!isSlug(titleSlug)) throw new Error('invalid_slug');
  if (submissionId === null || submissionId <= 0) throw new Error('invalid_submission_id');
  if (statusCode === null) throw new Error('invalid_status_code');

  const capturedVia = message.captured_via === 'manual' ? 'manual' : 'interceptor';
  // MAIN stamps the judge time as judged_at (ms); buffered events must keep it, never the enqueue time.
  const timestamp =
    toSeconds(verdict.timestamp) ||
    toSeconds(verdict.task_finish_time) ||
    toSeconds(message.timestamp) ||
    toSeconds(message.judged_at) ||
    Math.floor(Date.now() / 1000);

  const body = {
    submission_id: submissionId,
    title_slug: titleSlug,
    captured_via: capturedVia,
    status_code: statusCode,
    status_msg: clampText(verdict.status_msg, 64),
    lang: clampText(message.lang || verdict.lang || verdict.pretty_lang, 32),
    timestamp,
    runtime_percentile: toNumber(verdict.runtime_percentile),
    last_testcase: clampText(verdict.last_testcase, JUDGE_TEXT_MAX_CHARS),
    expected_output: clampText(verdict.expected_output, JUDGE_TEXT_MAX_CHARS),
    code_output: clampText(verdict.code_output, JUDGE_TEXT_MAX_CHARS),
    // The manual-capture fallback already carries the judge text as error_text (lc-client.mapDetails).
    error_text: clampText(
      verdict.error_text || verdict.runtime_error || verdict.full_runtime_error || verdict.compile_error || verdict.full_compile_error || null,
      JUDGE_TEXT_MAX_CHARS
    ),
    total_correct: toInt(verdict.total_correct),
    total_testcases: toInt(verdict.total_testcases)
  };

  // Consent is enforced in MAIN, ISOLATED, here, and on the server. Code never
  // leaves this worker unless the toggle is on.
  // MAIN's interceptor event carries the source as typed_code; the manual path sends code.
  const code = typeof message.code === 'string' ? message.code : message.typed_code;
  if (consent && typeof code === 'string' && code.length > 0) {
    body.code = clampText(code, CODE_MAX_CHARS);
  }
  return body;
}

function eventPayload(detail) {
  if (detail === undefined) return null;
  let text;
  try {
    text = JSON.stringify(detail);
  } catch (_) {
    return { truncated: true, reason: 'unserialisable' };
  }
  if (text === undefined) return null;
  if (text.length <= EVENT_PAYLOAD_MAX_CHARS) return detail;
  return { truncated: true, head: text.slice(0, EVENT_PAYLOAD_MAX_CHARS - 200) };
}

const HANDLERS = {
  async 'route:changed'(message, { tabId }) {
    const id = requireTab(tabId);
    const current = (await getCtx(id)) || {};
    const slug = isSlug(message.slug) ? message.slug : null;
    const patch = {
      slug,
      page: typeof message.page === 'string' ? message.page : null,
      isContest: message.isContest === true,
      url: typeof message.url === 'string' ? message.url.slice(0, 2048) : null,
      updatedAt: Date.now()
    };
    if (current.slug !== slug) patch.judging = null;
    const ctx = await mergeCtx(id, patch);
    return { ctx };
  },

  async 'capture:state'(message, { tabId }) {
    const id = requireTab(tabId);
    const { type, tabId: ignored, ...rest } = message;
    const state = rest.state && typeof rest.state === 'object' ? rest.state : rest;
    // lc-content reports { capture: 'on'|'off', reason, ... }; the panel and popup read capture.state.
    const ctx = await mergeCtx(id, { capture: { ...state, state: state.capture || state.state || null, updatedAt: Date.now() } });
    return { ctx };
  },

  async 'attempt:judging'(message, { tabId }) {
    const id = requireTab(tabId);
    const { type, tabId: ignored, code, typed_code, ...rest } = message; // never keep code in session
    const ctx = await mergeCtx(id, { judging: { ...rest, since: Date.now() } });
    return { ctx };
  },

  async 'attempt:captured'(message, { tabId }) {
    const consent = await Ext.getConsent();
    const body = buildAttemptBody(message, consent);
    if (tabId !== null && tabId !== undefined) {
      await mergeCtx(tabId, {
        judging: null,
        lastAttempt: {
          submission_id: body.submission_id,
          title_slug: body.title_slug,
          status_code: body.status_code,
          status_msg: body.status_msg,
          captured_via: body.captured_via,
          result: null,
          capturedAt: Date.now(),
          pending: true
        }
      });
    }
    const queueId = await enqueue({
      method: 'POST',
      path: '/api/lc/attempts',
      kind: 'attempt',
      body,
      meta: {
        tabId: tabId === undefined ? null : tabId,
        submission_id: body.submission_id,
        title_slug: body.title_slug
      }
    });
    return { queued: queueId, code_included: Object.prototype.hasOwnProperty.call(body, 'code') };
  },

  async 'problem:meta'(message) {
    const slug = message.slug;
    if (!isSlug(slug)) throw new Error('invalid_slug');
    const meta = message.meta && typeof message.meta === 'object' ? message.meta : {};
    const stored = await chrome.storage.local.get(['problemsSent']);
    const sent = stored.problemsSent && typeof stored.problemsSent === 'object' ? stored.problemsSent : {};
    if (sent[slug]) return { queued: null, skipped: 'already_sent' };
    const queueId = await enqueue({
      method: 'PUT',
      path: `/api/lc/problems/${encodeURIComponent(slug)}`,
      kind: 'problem',
      body: meta,
      meta: { slug }
    });
    return { queued: queueId };
  },

  async 'client:event'(message) {
    const eventType =
      message.event ||
      message.name ||
      (message.payload && message.payload.type) ||
      (message.detail && message.detail.type) ||
      'unknown';
    const detail = message.detail !== undefined ? message.detail : message.payload;
    const queueId = await enqueue({
      method: 'POST',
      path: '/api/lc/client-events',
      kind: 'event',
      body: {
        type: String(eventType).slice(0, 48),
        ext_version: CFG.EXT_VERSION,
        payload: eventPayload(detail)
      }
    });
    return { queued: queueId };
  },

  async 'content:invalidated'(message, { tabId }) {
    const id = requireTab(tabId);
    const ctx = await mergeCtx(id, { needsReload: true, updatedAt: Date.now() });
    return { ctx };
  },

  // ---- helpers for the popup / side panel ----
  async 'health:check'(message) {
    return { health: await checkHealth({ maxAgeMs: message.maxAgeMs, force: message.force === true }) };
  },

  async 'ctx:get'(message, { tabId }) {
    const id = message.tabId !== undefined && message.tabId !== null ? message.tabId : tabId;
    return { ctx: id === null || id === undefined ? null : await getCtx(id) };
  },

  async 'queue:flush'() {
    await processQueue('manual');
    return { pending: (await readQueue()).length };
  },

  async 'queue:status'() {
    const queue = await readQueue();
    return {
      pending: queue.length,
      items: queue.map(({ id, method, path, kind, attempts, nextAt, lastStatus, lastError }) => ({
        id, method, path, kind, attempts, nextAt, lastStatus, lastError
      }))
    };
  }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const handler = HANDLERS[message.type];
  if (!handler) return false;
  const tabId = sender && sender.tab && sender.tab.id !== undefined ? sender.tab.id : null;
  Promise.resolve()
    .then(() => handler(message, { tabId, sender }))
    .then((result) => sendResponse({ ok: true, ...(result || {}) }))
    .catch((err) => sendResponse({ ok: false, error: (err && err.message) || 'handler_failed' }));
  return true; // keep the channel open for the async reply
});

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  ensureAlarm().catch(() => {});
  processQueue('installed').catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().catch(() => {});
  processQueue('startup').catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) processQueue('alarm').catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeCtx(tabId).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.authToken && changes.authToken.newValue) {
    processQueue('token').catch(() => {});
  }
});

ensureAlarm().catch(() => {});
