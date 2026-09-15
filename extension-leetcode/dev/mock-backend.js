#!/usr/bin/env node
'use strict';
/**
 * mock-backend.js: in-memory stand-in for the Recall backend (backend/src/lc) on http://localhost:4100.
 * No dependencies (http, url only). State lives per Bearer token and is lost on restart.
 *
 *   node extension-leetcode/dev/mock-backend.js
 *
 * Every /api/lc/* route from the plan's route table answers with the real response shapes:
 *   GET  /health, /health/ready
 *   GET  /api/lc/me            DELETE /api/lc/me
 *   GET  /api/lc/profile       PUT /api/lc/profile        POST /api/lc/consent
 *   POST /api/lc/sync          (phases solved -> submissions -> finalize; 403 consent_required until POST /consent)
 *   PUT  /api/lc/problems/:slug
 *   GET  /api/lc/anchors/:slug (canned 2 anchors with `why`; two-sum -> none; unknown-* -> 404)
 *   POST /api/lc/attempts      (bucket/tier; idempotent by submission_id; unlocks rungs)
 *   POST /api/lc/chat          (canned reply per rung and language; 403 contest, 409 not_synced, 429 daily_cap)
 *   GET  /api/lc/chat/:slug/history
 *   POST /api/lc/chat/messages/:id/feedback     POST /api/lc/habits/:id/feedback
 *   POST /api/lc/client-events (202)
 *   GET  /__mock/state, POST /__mock/reset       (debug only; never lists tokens or code)
 *
 * Auth: any non-empty Bearer token is a user (state keyed by token); the literal tokens `expired` and `bad`
 * answer 401 so the token-expiry UX can be tested. CORS: any chrome-extension:// origin and localhost.
 *
 * Fault knobs
 *   ?slow=25000 on any request      delay that response (cold start); capped at 120 s
 *   MOCK_COLD_START_MS=25000        delay only the first request after boot
 *   MOCK_CHAT_DELAY_MS=3000         delay every chat reply (70000 exercises the panel's 60 s timeout)
 *   MOCK_FAIL_EVERY=7               every 7th authenticated API call answers 503 (retry queue test)
 *   MOCK_KILL_LLM=1                 chat answers the templated reply with degraded:true
 *   MOCK_DAILY_CAP=2                third hint of the day is 429 daily_cap
 *   MOCK_MIN_EXT_VERSION=9.9.9      /health advertises this min_extension_version (UPDATE_REQUIRED view)
 *   MOCK_SKIP_CONSENT_GATE=1        sync does not require POST /consent first
 *   MOCK_SKIP_SYNC_GATE=1           chat works before a finalized sync
 */
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 4100;
const ENV = process.env;
const COLD_START_MS = Number(ENV.MOCK_COLD_START_MS) || 0;
const CHAT_DELAY_MS = Number(ENV.MOCK_CHAT_DELAY_MS) || 0;
const FAIL_EVERY = Number(ENV.MOCK_FAIL_EVERY) || 0;
const KILL_LLM = ['1', 'true', 'yes', 'on'].includes(String(ENV.MOCK_KILL_LLM || '').toLowerCase());
const DAILY_CAP = Number.isFinite(Number(ENV.MOCK_DAILY_CAP)) && ENV.MOCK_DAILY_CAP !== undefined ? Number(ENV.MOCK_DAILY_CAP) : 60;
const MIN_EXT_VERSION = ENV.MOCK_MIN_EXT_VERSION || '1.0.0';
const SKIP_CONSENT_GATE = ENV.MOCK_SKIP_CONSENT_GATE === '1';
const SKIP_SYNC_GATE = ENV.MOCK_SKIP_SYNC_GATE === '1';
const CONSENT_VERSION = ENV.MOCK_CONSENT_VERSION || '1';
const MODEL_VERSION = 'lc-model-v1';
const MAX_SLOW_MS = 120000;
const BODY_LIMIT = 2 * 1024 * 1024;
const BUCKET_TIERS = { re_overflow: 'high', re_null_memo: 'high', tle: 'high', wa_logic: 'medium', wa_modulo: 'medium', wa_edge_empty: 'medium', re_index: 'medium', mle_state: 'low' };
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUS_MSG = { 10: 'Accepted', 11: 'Wrong Answer', 12: 'Memory Limit Exceeded', 13: 'Output Limit Exceeded', 14: 'Time Limit Exceeded', 15: 'Runtime Error', 20: 'Compile Error', 50: 'Restricted' };

const startedAt = Date.now();
let firstRequestSeen = false;
let apiCalls = 0;

// ---------- canned model ----------
const ANCHOR_SETS = {
  interval: [
    { slug: 'burst-balloons', title: 'Burst Balloons', difficulty: 'hard', score: 6.5, why: 'same idea: Interval DP over [i..j]', subpattern: 'dp.interval', fine_tag: null, solved_on: '2026-07-08', attempts_to_ac: 3, first_ac_submission_id: 1801000009 },
    { slug: 'minimum-cost-to-cut-a-stick', title: 'Minimum Cost to Cut a Stick', difficulty: 'hard', score: 5.5, why: 'same idea: Interval DP over [i..j] (first cut between i and j)', subpattern: 'dp.interval', fine_tag: null, solved_on: '2026-07-23', attempts_to_ac: 2, first_ac_submission_id: 1801000014 }
  ],
  knapsack: [
    { slug: 'partition-equal-subset-sum', title: 'Partition Equal Subset Sum', difficulty: 'medium', score: 6.0, why: 'same idea: 0/1 knapsack / subset-sum', subpattern: 'dp.knapsack_01', fine_tag: '0-1-knapsack', solved_on: '2026-07-02', attempts_to_ac: 2, first_ac_submission_id: 1801000006 },
    { slug: 'target-sum', title: 'Target Sum', difficulty: 'medium', score: 5.0, why: 'shares the fine tag 0-1-knapsack', subpattern: 'dp.knapsack_01', fine_tag: '0-1-knapsack', solved_on: '2026-07-14', attempts_to_ac: 2, first_ac_submission_id: 1801000011 }
  ],
  dijkstra: [
    { slug: 'network-delay-time', title: 'Network Delay Time', difficulty: 'medium', score: 7.0, why: 'same idea: Dijkstra / best-first with priority queue', subpattern: 'graph.dijkstra', fine_tag: 'dijkstra', solved_on: '2026-06-26', attempts_to_ac: 1, first_ac_submission_id: 1801000004 },
    { slug: 'path-with-minimum-effort', title: 'Path With Minimum Effort', difficulty: 'medium', score: 5.5, why: 'shares the fine tag dijkstra (min-of-max relaxation)', subpattern: 'graph.dijkstra', fine_tag: 'dijkstra', solved_on: '2026-07-27', attempts_to_ac: 3, first_ac_submission_id: 1801000017 }
  ],
  topo: [
    { slug: 'course-schedule', title: 'Course Schedule', difficulty: 'medium', score: 6.5, why: 'same idea: Topological ordering / DAG DP', subpattern: 'graph.topological_sort', fine_tag: 'topological-sort', solved_on: '2026-06-20', attempts_to_ac: 3, first_ac_submission_id: 1801000003 },
    { slug: 'course-schedule-ii', title: 'Course Schedule II', difficulty: 'medium', score: 5.0, why: 'shares the fine tag topological-sort', subpattern: 'graph.topological_sort', fine_tag: 'topological-sort', solved_on: '2026-07-17', attempts_to_ac: 1, first_ac_submission_id: 1801000012 }
  ]
};
const FAMILY_META = {
  interval: { family: 'dp', subpatterns: [{ id: 'dp.interval', label: 'Interval DP over [i..j]', family: 'dp', primary: true }] },
  knapsack: { family: 'dp', subpatterns: [{ id: 'dp.knapsack_01', label: '0/1 knapsack / subset-sum', family: 'dp', primary: true }] },
  dijkstra: { family: 'graph', subpatterns: [{ id: 'graph.dijkstra', label: 'Dijkstra / best-first with priority queue', family: 'graph', primary: true }] },
  topo: { family: 'graph', subpatterns: [{ id: 'graph.topological_sort', label: 'Topological ordering / DAG DP', family: 'graph', primary: true }] }
};
function familyKeyOf(slug) {
  if (/triangulation|balloon|palindrom|stick|printer|stones|merge|boxes|scramble/.test(slug)) return 'interval';
  if (/ones-and-zeroes|subset|knapsack|target-sum|coin|billboard|partition/.test(slug)) return 'knapsack';
  if (/probab|delay|effort|swim|path-with|maze|cheapest|arrive|obstacle|network/.test(slug)) return 'dijkstra';
  if (/course|schedule|alien|topolog|recipe|parallel|ancestors|dependencies/.test(slug)) return 'topo';
  if (slug === 'two-sum' || /^no-anchors/.test(slug) || /^easy-/.test(slug)) return null;
  return 'interval';
}

function cannedHabits(nowIso) {
  return [
    { id: 1, key: 'bucket:dp.interval:wa_edge_empty', category: 'bucket', subpattern: 'dp.interval', subpattern_label: 'Interval DP over [i..j]', bucket: 'wa_edge_empty', tier: 'medium', live: true, state: 'auto', reaction: null, counts: { n: 2, window_n: 2, of: 3 }, evidence: { slugs: ['burst-balloons', 'longest-palindromic-subsequence'] }, statement: { english: 'On interval-DP problems your first wrong answer tends to be on a tiny input (2 of your last 3).', hinglish: 'Interval-DP problems mein tumhara pehla wrong answer aksar chhote input par aata hai (last 3 mein se 2).' }, last_seen_at: nowIso },
    { id: 2, key: 'overflow', category: 'overflow', subpattern: null, subpattern_label: null, bucket: 're_overflow', tier: 'high', live: true, state: 'auto', reaction: null, counts: { n: 2, window_n: 2 }, evidence: { slugs: ['target-sum', 'swim-in-rising-water'] }, statement: { english: 'Two recent runtime errors were signed int overflows (Target Sum, Swim in Rising Water).', hinglish: 'Do recent runtime errors signed int overflow the (Target Sum, Swim in Rising Water).' }, last_seen_at: nowIso },
    { id: 3, key: 'gap:dp.kadane_max_subarray', category: 'gap', subpattern: 'dp.kadane_max_subarray', subpattern_label: 'Kadane-style running best subarray ending here', bucket: null, tier: 'medium', live: false, state: 'stale', reaction: null, counts: { n: 3, window_n: 0 }, evidence: { slugs: [] }, statement: { english: 'Kadane-style problems used to take you more attempts than your baseline (stale: nothing in the last 180 days).', hinglish: 'Kadane-style problems pehle baseline se zyada attempts lete the (stale: last 180 din mein kuch nahi).' }, last_seen_at: '2025-03-01T00:00:00.000Z' }
  ];
}
function habitView(h, language) {
  return Object.assign({}, h, { statement: h.statement[language === 'hinglish' ? 'hinglish' : 'english'] });
}

// ---------- policy (local port of domain/policy.js decideRung) ----------
function decideRung({ requestedRung = null, planStated = false, submissionsHere = 0, turns = 0, lastFailAgeS = null, lastFailBucket = null, isContest = false, maxRungGlobal = 4 } = {}) {
  if (isContest) return { locked: true, reason: 'contest_mode' };
  let max = 1;
  let unlock = 'state_a_plan';
  if (planStated) { max = 2; unlock = 'submit_once'; }
  if (submissionsHere >= 1 || turns >= 3) { max = Math.max(max, 3); unlock = 'ask_for_rung_4'; }
  const rung4Ready = submissionsHere >= 2 || turns >= 5;
  if (rung4Ready && requestedRung === 4) { max = 4; unlock = null; } else if (rung4Ready) unlock = 'ask_for_rung_4';
  max = Math.min(max, maxRungGlobal);
  let floor = 1;
  let diagnostic = null;
  if (lastFailAgeS !== null && lastFailAgeS !== undefined && lastFailAgeS < 1800 && lastFailBucket) { floor = Math.min(3, max); diagnostic = lastFailBucket; }
  const wanted = requestedRung || floor;
  const rung = Math.max(floor, Math.min(wanted, max));
  return { locked: false, rung, max_rung: max, floor, diagnostic_focus: rung >= 3 ? diagnostic : null, code_allowed: rung === 4 ? 'blanked_pseudocode' : 'none', must_end_with_question: true, unlock_reason: rung >= 4 ? null : unlock, allowed_rung_next: rung4Ready ? 4 : max };
}

// ---------- buckets (small local classifier) ----------
function bucketOf(statusCode, d) {
  d = d || {};
  if (statusCode === 10) return 'ac';
  if (statusCode === 11) {
    const tc = String(d.last_testcase || '').trim();
    const edge = !tc || tc.length <= 6 || /^\[\]$|^\[[^,\]]*\]$|^""$|^"."$|^0$|^1$/.test(tc) || /^1\n\[\]$/.test(tc);
    if (/mod|10\^9|1000000007/.test(String(d.expected_output || '')) && !edge) return 'wa_modulo';
    return edge ? 'wa_edge_empty' : 'wa_logic';
  }
  if (statusCode === 14) return 'tle';
  if (statusCode === 15) {
    const e = String(d.error_text || '');
    if (/overflow/i.test(e)) return 're_overflow';
    if (/null|nullptr|bad_alloc|segmentation|member access within null/i.test(e)) return 're_null_memo';
    return 're_index';
  }
  if (statusCode === 12) return 'mle_state';
  if (statusCode === 20) return 'ce';
  if (statusCode === 50) return 'restricted';
  return 'other';
}

// ---------- state ----------
const users = new Map(); // token -> user
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); }
function uuid() { return globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
function newUser(token) {
  const id = `mock-${hash(token)}`;
  return {
    user_id: id, email: `${id}@example.invalid`, name: 'Mock Student',
    profile: null, consents: new Set(), solved: new Map(), submissions: new Map(), tag_counts: null, recent_ac: [],
    skill_summary: null, habits: [], sessions: new Map(), problems: new Map(), attempts: new Map(), events: [],
    hints: { day: null, count: 0 }, sync: null
  };
}
function userFor(token) { if (!users.has(token)) users.set(token, newUser(token)); return users.get(token); }
function ensureProfile(u) {
  if (!u.profile) u.profile = { language: 'english', consent_code: false, consent_at: null, leetcode_username: null, sync_status: 'never', sync_progress: null, last_synced_at: null, model_version: null };
  return u.profile;
}
function profileView(u) {
  const p = u.profile;
  return {
    language: p ? p.language : 'english', consent_code: !!(p && p.consent_code), consent_at: p ? p.consent_at : null, leetcode_username: p ? p.leetcode_username : null,
    sync_status: p ? p.sync_status : 'never', sync_progress: p ? p.sync_progress : null, last_synced_at: p ? p.last_synced_at : null,
    consent_version_accepted: u.consents.has(CONSENT_VERSION) ? CONSENT_VERSION : null, consent_version_required: CONSENT_VERSION, exists: !!p
  };
}
function maxSubmissionId(u) { let max = null; for (const id of u.submissions.keys()) if (max === null || id > max) max = id; return max; }
function todayUtc() { return new Date().toISOString().slice(0, 10); }
function hintsToday(u) { return u.hints.day === todayUtc() ? u.hints.count : 0; }
function language(u) { return u.profile && u.profile.language === 'hinglish' ? 'hinglish' : 'english'; }
function visibleHabits(u) { return u.habits.filter((h) => h.state !== 'dismissed' && (h.live || h.state === 'confirmed')).map((h) => habitView(h, language(u))); }

function computeSkillSummary(u) {
  const rows = [...u.solved.values()];
  const counts = { easy: 0, medium: 0, hard: 0 };
  const tagCount = {};
  for (const r of rows) {
    const d = String(r.difficulty || '').toLowerCase();
    if (d in counts) counts[d]++;
    for (const t of r.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
  }
  const DP = new Set(['dynamic-programming', 'memoization', 'knapsack-problem', '0-1-knapsack', 'bitmask']);
  const GRAPH = new Set(['graph', 'breadth-first-search', 'depth-first-search', 'topological-sort', 'shortest-path', 'union-find', 'dijkstra', 'directed-acyclic-graph']);
  const fam = (set) => rows.filter((r) => (r.tags || []).some((t) => set.has(t)));
  const level = (n) => (n >= 20 ? 'strong' : n >= 5 ? 'developing' : n >= 1 ? 'early' : 'none');
  const dp = fam(DP); const graph = fam(GRAPH);
  const strengths = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} (${n})`);
  const tagLevels = {}; for (const [t, n] of Object.entries(tagCount)) tagLevels[t] = level(n);
  return {
    version: MODEL_VERSION, band: rows.length >= 300 ? 'advanced' : rows.length >= 60 ? 'intermediate' : 'beginner', solved: rows.length, counts,
    dp: { level: level(dp.length), solved: dp.length, sample: dp.slice(0, 3).map((r) => r.title || r.slug) },
    graph: { level: level(graph.length), solved: graph.length, sample: graph.slice(0, 3).map((r) => r.title || r.slug) },
    strengths, gaps: ['dp.interval'], tag_levels: tagLevels, cold_start: rows.length < 10
  };
}

// ---------- http helpers ----------
function now() { return new Date().toISOString().slice(11, 23); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isAllowedOrigin(origin) { return !origin || origin.startsWith('chrome-extension://') || /^https?:\/\/localhost(?::\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(origin); }
function corsHeaders(origin) {
  const h = { 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type, Authorization, X-Recall-Version, X-Recall-Ext-Version', 'access-control-max-age': '600', vary: 'Origin' };
  if (origin) h['access-control-allow-origin'] = origin;
  return h;
}
class HttpError extends Error { constructor(status, error, extra) { super(error); this.status = status; this.error = error; this.extra = extra || null; } }
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > BODY_LIMIT) { reject(new HttpError(413, 'payload_too_large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function jsonBody(text) { if (!text) return {}; try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch (_) { throw new HttpError(400, 'invalid_json'); } }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const toInt = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const clamp = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
const isSlug = (s) => typeof s === 'string' && s.length <= 191 && SLUG_RE.test(s);

// ---------- handlers ----------
function health() {
  return { status: 'ok', service: 'recall', version: '0.0.0+mock', uptime_s: Math.round((Date.now() - startedAt) / 1000), provider: 'mock', model: 'mock-1', kill: { llm: KILL_LLM, sync: false }, min_extension_version: MIN_EXT_VERSION, db: 'ok', migration: '012_lc_init', mock: true };
}

function getMe(u) {
  return {
    user: { user_id: u.user_id, email: u.email, name: u.name },
    profile: profileView(u),
    counts: { solved: u.solved.size, submissions: u.submissions.size, max_lc_submission_id: maxSubmissionId(u) },
    skill_summary: u.skill_summary, habits: visibleHabits(u),
    hints: { today: hintsToday(u), cap: DAILY_CAP, resets_at: '00:00 UTC' },
    model_version: u.profile ? u.profile.model_version : null, current_model_version: MODEL_VERSION,
    min_extension_version: MIN_EXT_VERSION, kill: { llm: KILL_LLM, sync: false }, consent_version: CONSENT_VERSION
  };
}

function putProfile(u, body) {
  if (!isObj(body)) throw new HttpError(400, 'invalid_body');
  const p = ensureProfile(u);
  const fields = [];
  let nulled = 0;
  if (body.language !== undefined) { if (!['english', 'hinglish'].includes(body.language)) throw new HttpError(400, 'invalid_language'); p.language = body.language; fields.push('language'); }
  if (body.consent_code !== undefined) {
    if (typeof body.consent_code !== 'boolean') throw new HttpError(400, 'invalid_consent_code');
    if (body.consent_code && !p.consent_code) p.consent_at = new Date().toISOString();
    if (!body.consent_code) for (const s of u.submissions.values()) if (s.code) { s.code = null; nulled++; }
    p.consent_code = body.consent_code; fields.push('consent_code');
  }
  if (body.leetcode_username !== undefined) {
    if (body.leetcode_username === null || body.leetcode_username === '') p.leetcode_username = null;
    else { const s = typeof body.leetcode_username === 'string' ? body.leetcode_username.trim() : ''; if (!/^[^\s]{1,64}$/.test(s)) throw new HttpError(400, 'invalid_leetcode_username'); p.leetcode_username = s; }
    fields.push('leetcode_username');
  }
  if (!fields.length) throw new HttpError(400, 'no_fields');
  return { ok: true, profile: profileView(u), code_rows_nulled: nulled };
}

function recordConsent(u, body) {
  const raw = isObj(body) ? body.version : undefined;
  const version = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!/^[A-Za-z0-9_.-]{1,16}$/.test(version)) throw new HttpError(400, 'invalid_version');
  ensureProfile(u); u.consents.add(version);
  return { ok: true, version, required_version: CONSENT_VERSION, satisfied: version === CONSENT_VERSION };
}

function deleteMe(token, u) {
  const counts = { lc_client_events: u.events.length, lc_chat_messages: [...u.sessions.values()].reduce((n, s) => n + s.messages.length, 0), lc_chat_sessions: u.sessions.size, lc_habits: u.habits.length, lc_skill_events: 0, lc_submissions: u.submissions.size, lc_solved: u.solved.size, lc_consents: u.consents.size, lc_profiles: u.profile ? 1 : 0 };
  users.set(token, newUser(token));
  return { deleted: true, counts };
}

function ingestSync(u, body, extVersion) {
  if (!isObj(body)) throw new HttpError(400, 'invalid_body');
  const phase = body.phase;
  if (!['solved', 'submissions', 'finalize'].includes(phase)) throw new HttpError(400, 'invalid_phase');
  const syncId = typeof body.sync_id === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(body.sync_id) ? body.sync_id : null;
  if (!syncId) throw new HttpError(400, 'invalid_sync_id');
  if (!SKIP_CONSENT_GATE && !u.consents.has(CONSENT_VERSION)) throw new HttpError(403, 'consent_required', { consent_version: CONSENT_VERSION });
  const p = ensureProfile(u);
  const at = new Date().toISOString();
  if (phase === 'solved') {
    const rows = Array.isArray(body.solved) ? body.solved : [];
    if (rows.length > 1000) throw new HttpError(400, 'too_many_rows', { max: 1000 });
    let dropped = 0;
    for (const r of rows) {
      const slug = isObj(r) ? (r.slug || r.titleSlug || r.title_slug) : null;
      if (!isSlug(slug)) { dropped++; continue; }
      const tags = (r.tags || r.topicTags || r.topic_tags || []).map((t) => (typeof t === 'string' ? t : t && t.slug)).filter(Boolean);
      u.solved.set(slug, { slug, title: r.title || slug, difficulty: r.difficulty || null, frontend_id: r.frontend_id ?? r.frontendId ?? null, tags, solved_at: null });
    }
    for (const ra of Array.isArray(body.recent_ac) ? body.recent_ac : []) {
      if (!isObj(ra) || !isSlug(ra.slug)) continue;
      const row = u.solved.get(ra.slug) || { slug: ra.slug, title: ra.slug, difficulty: null, frontend_id: null, tags: [], solved_at: null };
      const ts = toInt(ra.timestamp ?? ra.ts);
      if (ts && (!row.solved_at || ts < row.solved_at)) row.solved_at = ts;
      u.solved.set(ra.slug, row);
    }
    u.tag_counts = isObj(body.tag_counts) ? body.tag_counts : u.tag_counts;
    if (typeof body.leetcode_username === 'string' && body.leetcode_username.trim()) p.leetcode_username = body.leetcode_username.trim().slice(0, 64);
    p.sync_status = 'partial';
    p.sync_progress = { sync_id: syncId, phase: 'solved', started: at, chunks: 0, submissions_seen: 0, solved_count: u.solved.size, last_chunk_at: null, finished: null, ext_version: extVersion || null };
    if (u.tag_counts) p.sync_progress.tag_counts = u.tag_counts;
    return { ok: true, phase: 'solved', sync_id: syncId, upserted: rows.length - dropped, dropped, total_submissions_known: u.submissions.size, next: 'submissions' };
  }
  if (!p.sync_progress || p.sync_progress.sync_id !== syncId) throw new HttpError(409, 'sync_id_mismatch', { active_sync_id: p.sync_progress ? p.sync_progress.sync_id : null });
  if (phase === 'submissions') {
    const subs = Array.isArray(body.submissions) ? body.submissions : [];
    if (subs.length > 200) throw new HttpError(400, 'too_many_rows', { max: 200 });
    const consent = !!p.consent_code;
    let upserted = 0; let dropped = 0;
    for (const s of subs) {
      const id = isObj(s) ? toInt(s.id ?? s.lc_submission_id ?? s.submission_id) : null;
      const slug = isObj(s) ? (s.slug || s.title_slug || s.titleSlug) : null;
      const ts = isObj(s) ? toInt(s.timestamp ?? s.ts) : null;
      if (!id || id < 1 || !isSlug(slug) || !ts) { dropped++; continue; }
      const statusCode = toInt(s.status_code);
      const det = isObj(s.details) ? s.details : null;
      const row = u.submissions.get(id) || { lc_submission_id: id, slug, status_code: statusCode, status_msg: s.status_msg || STATUS_MSG[statusCode] || null, lang: clamp(s.lang, 32), ts, details: null, code: null, captured_via: 'sync' };
      if (det && !row.details) row.details = det;
      if (consent && typeof s.code === 'string' && s.code.length && !row.code) row.code = s.code.slice(0, 200000);
      row.verdict_bucket = bucketOf(row.status_code, row.details || {});
      u.submissions.set(id, row);
      upserted++;
    }
    // detail rows may also travel in a separate `details` array (keyed by submission_id)
    for (const d of Array.isArray(body.details) ? body.details : []) {
      const id = isObj(d) ? toInt(d.submission_id ?? d.id) : null;
      if (!id) { dropped++; continue; }
      const row = u.submissions.get(id) || (isSlug(d.slug) && toInt(d.timestamp) ? { lc_submission_id: id, slug: d.slug, status_code: toInt(d.status_code), status_msg: STATUS_MSG[toInt(d.status_code)] || null, lang: clamp(d.lang, 32), ts: toInt(d.timestamp), details: null, code: null, captured_via: 'sync' } : null);
      if (!row) { dropped++; continue; }
      if (!row.details) row.details = d;
      if (consent && typeof d.code === 'string' && d.code.length && !row.code) row.code = d.code.slice(0, 200000);
      row.verdict_bucket = bucketOf(row.status_code, row.details || {});
      u.submissions.set(id, row);
      upserted++;
    }
    p.sync_progress = Object.assign({}, p.sync_progress, { phase: 'submissions', chunks: (p.sync_progress.chunks || 0) + 1, submissions_seen: (p.sync_progress.submissions_seen || 0) + upserted, last_chunk_at: at });
    return { ok: true, phase: 'submissions', sync_id: syncId, upserted, dropped, code_stored: consent, total_submissions_known: u.submissions.size, next: 'finalize' };
  }
  // finalize: canned recompute
  const t0 = Date.now();
  u.skill_summary = computeSkillSummary(u);
  if (!u.habits.length) u.habits = cannedHabits(at);
  const live = u.habits.filter((h) => h.live);
  p.sync_status = 'complete'; p.last_synced_at = at; p.model_version = MODEL_VERSION;
  p.sync_progress = Object.assign({}, p.sync_progress, { phase: 'complete', finished: at });
  u.sync = { sync_id: syncId, finished: at };
  return {
    ok: true, phase: 'finalize', sync_id: syncId, upserted: 0, total_submissions_known: u.submissions.size, max_lc_submission_id: maxSubmissionId(u), next: null,
    recompute: { n_attempts: u.submissions.size, n_solved: u.solved.size, habits: u.habits.length, habits_live: live.length, ms: Date.now() - t0, model_version: MODEL_VERSION },
    skill_summary: u.skill_summary, habits: visibleHabits(u)
  };
}

function putProblem(u, slug, body) {
  if (!isSlug(slug)) throw new HttpError(400, 'invalid_slug');
  if (!isObj(body)) throw new HttpError(400, 'invalid_body');
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 255) : null;
  if (!title) throw new HttpError(400, 'title_required');
  const tags = (body.topic_tags || body.topicTags || body.tags || []).map((t) => (typeof t === 'string' ? t : t && t.slug)).filter(Boolean).slice(0, 40);
  const created = !u.problems.has(slug);
  const excerptIn = body.statement_excerpt ?? body.statementExcerpt ?? body.content;
  const constraintsIn = body.constraints_text ?? body.constraintsText;
  const excerpt = typeof excerptIn === 'string' ? excerptIn.replace(/<[^>]+>/g, '').slice(0, 1500) : null;
  const constraints = typeof constraintsIn === 'string' ? constraintsIn.slice(0, 1000) : null;
  if (created) u.problems.set(slug, { slug, title, difficulty: body.difficulty || null, tags, hints: Array.isArray(body.hints) ? body.hints.slice(0, 10) : [], excerpt, constraints, similar: body.similar_slugs || body.similarQuestions || null, received_at: new Date().toISOString() });
  return { ok: true, slug, created, has_excerpt: !!excerpt, has_constraints: !!constraints, tags };
}

function submissionsHere(u, slug) { let n = 0; for (const s of u.submissions.values()) if (s.slug === slug) n++; return n; }
function lastFailHere(u, slug) {
  let best = null;
  for (const s of u.submissions.values()) if (s.slug === slug && s.status_code !== 10 && (!best || s.ts > best.ts || (s.ts === best.ts && s.lc_submission_id > best.lc_submission_id))) best = s;
  return best;
}
function solvedHere(u, slug) { if (u.solved.has(slug)) return true; for (const s of u.submissions.values()) if (s.slug === slug && s.status_code === 10) return true; return false; }
function contractFor(u, slug, { requestedRung = null, planStated = false, turns = 0, isContest = false } = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  const lf = lastFailHere(u, slug);
  return decideRung({ requestedRung, planStated, submissionsHere: submissionsHere(u, slug), turns, lastFailAgeS: lf ? Math.max(0, nowS - lf.ts) : null, lastFailBucket: lf ? lf.verdict_bucket : null, isContest });
}

function getAnchors(u, slug) {
  if (!isSlug(slug)) throw new HttpError(400, 'invalid_slug');
  if (/^unknown-/.test(slug)) throw new HttpError(404, 'problem_unknown');
  const key = familyKeyOf(slug);
  const meta = key ? FAMILY_META[key] : { family: null, subpatterns: [] };
  const consent = !!(u.profile && u.profile.consent_code);
  const anchors = key ? ANCHOR_SETS[key].map((a) => Object.assign({}, a, { has_code: consent })) : [];
  const c = contractFor(u, slug);
  const cached = u.problems.get(slug);
  return {
    slug, title: cached ? cached.title : slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), difficulty: cached ? cached.difficulty : (key ? 'medium' : 'easy'), frontend_id: null,
    family: meta.family, families: meta.family ? [meta.family] : [], subpatterns: meta.subpatterns, anchors,
    omitted_reason: anchors.length ? null : 'no_eligible', allowed_rung: c.allowed_rung_next, unlock_reason: c.unlock_reason,
    submissions_here: submissionsHere(u, slug), solved_here: solvedHere(u, slug), model_version: u.profile ? u.profile.model_version : null, computed_at: Math.floor(Date.now() / 1000)
  };
}

function recordAttempt(u, body) {
  if (!isObj(body)) throw new HttpError(400, 'invalid_body');
  const id = toInt(body.submission_id ?? body.id);
  if (!id || id < 1) throw new HttpError(400, 'invalid_submission_id');
  const slug = body.title_slug || body.slug;
  if (!isSlug(slug)) throw new HttpError(400, 'invalid_slug');
  const capturedVia = body.captured_via === undefined ? 'interceptor' : body.captured_via;
  if (!['interceptor', 'manual'].includes(capturedVia)) throw new HttpError(400, 'invalid_captured_via');
  const statusCode = toInt(body.status_code);
  if (statusCode === null) throw new HttpError(400, 'invalid_status');
  const ts = toInt(body.timestamp ?? body.ts);
  if (!ts || ts < 1) throw new HttpError(400, 'invalid_timestamp');
  const p = ensureProfile(u);
  const detailKeys = ['last_testcase', 'expected_output', 'code_output', 'error_text', 'total_correct', 'total_testcases'];
  const hasDetails = detailKeys.some((k) => body[k] !== undefined && body[k] !== null);
  const details = hasDetails ? Object.fromEntries(detailKeys.map((k) => [k, body[k] === undefined ? null : body[k]])) : null;
  const bucket = bucketOf(statusCode, details || {});
  const tier = BUCKET_TIERS[bucket] || null;
  const known = u.submissions.has(id);
  const others = [...u.submissions.values()].filter((s) => s.slug === slug && s.lc_submission_id !== id);
  const before = (r) => r.ts < ts || (r.ts === ts && r.lc_submission_id < id);
  const isAc = statusCode === 10;
  const isFirstAc = isAc && !others.some((r) => r.status_code === 10 && before(r));
  const session = u.sessions.get(slug);
  const assisted = isFirstAc && !!(session && session.turn_count > 0);
  if (!known) {
    u.submissions.set(id, { lc_submission_id: id, slug, status_code: statusCode, status_msg: clamp(body.status_msg, 64) || STATUS_MSG[statusCode] || null, verdict_bucket: bucket, lang: clamp(body.lang, 32), ts, details, code: p.consent_code && typeof body.code === 'string' && body.code.length ? body.code.slice(0, 200000) : null, captured_via: capturedVia, runtime_percentile: body.runtime_percentile ?? null });
    if (isFirstAc && !u.solved.has(slug)) u.solved.set(slug, { slug, title: (u.problems.get(slug) || {}).title || slug, difficulty: (u.problems.get(slug) || {}).difficulty || null, frontend_id: null, tags: (u.problems.get(slug) || {}).tags || [], solved_at: ts, first_ac_submission_id: id, attempts_to_ac: others.filter((r) => r.status_code !== 10 && before(r)).length + 1, assisted });
  }
  u.attempts.set(id, { id, slug, status_code: statusCode, bucket, captured_via: capturedVia, code_included: !!(body.code), at: new Date().toISOString() });
  if (u.skill_summary) u.skill_summary = computeSkillSummary(u);
  const habitsChanged = [];
  if (!known && bucket === 're_overflow' && u.habits.length) { const h = u.habits.find((x) => x.key === 'overflow'); if (h) { h.counts.n++; h.counts.window_n++; h.last_seen_at = new Date().toISOString(); habitsChanged.push('overflow'); } }
  const c = contractFor(u, slug, { turns: session ? session.turn_count : 0 });
  return { ok: true, submission_id: id, slug, bucket, tier, is_first_ac: isFirstAc, assisted, already_known: known, solved_here: isAc || others.some((r) => r.status_code === 10), submissions_here: others.length + 1, habits_changed: habitsChanged, recompute_ms: 1, allowed_rung_next: c.allowed_rung_next, unlock_reason: c.unlock_reason, model_version: MODEL_VERSION };
}

// ---------- chat ----------
const SKELETON = 'for len in 2..n:\n  for i in 0..n-len:\n    j = i + len - 1\n    best[i][j] = ___\n    for k in i+1..j-1:\n      best[i][j] = max(best[i][j], best[i][k] + best[k][j] + ___)';
function bucketWords(bucket, lang) {
  const en = { re_overflow: 'an integer overflow', re_null_memo: 'a crash on a null or missing entry', tle: 'the time limit', wa_logic: 'a wrong answer on a normal case', wa_modulo: 'a modulo or overflow mismatch', wa_edge_empty: 'a wrong answer on a tiny input', re_index: 'an out-of-bounds index', mle_state: 'the memory limit' };
  const hi = { re_overflow: 'integer overflow', re_null_memo: 'null ya missing-entry crash', tle: 'time limit', wa_logic: 'normal case pe wrong answer', wa_modulo: 'modulo ya overflow mismatch', wa_edge_empty: 'chhote input pe wrong answer', re_index: 'out-of-bounds index', mle_state: 'memory limit' };
  return (lang === 'hinglish' ? hi : en)[bucket] || null;
}
function cannedReply({ rung, lang, anchors, verdict, plan }) {
  const a1 = anchors[0] ? anchors[0].title : (lang === 'hinglish' ? 'ek pehle solve kiya hua problem' : 'a problem you solved before');
  const tc = verdict && verdict.details && verdict.details.last_testcase ? String(verdict.details.last_testcase).replace(/\s+/g, ' ').slice(0, 60) : (lang === 'hinglish' ? 'sabse chhota input' : 'the smallest input');
  const status = verdict ? (verdict.status_msg || STATUS_MSG[verdict.status_code] || 'a failed run') : null;
  const bw = verdict ? bucketWords(verdict.verdict_bucket, lang) : null;
  const planNote = plan ? (lang === 'hinglish' ? ` Tumhara plan ("${String(plan).slice(0, 40)}") theek direction mein hai.` : ` Your plan ("${String(plan).slice(0, 40)}") points the right way.`) : '';
  if (lang === 'hinglish') {
    if (rung === 1) return `Kisi technique ka naam liye bina shuru karo. Sabse chhota input lo jo constraints allow karte hain, use haath se solve karo, phir ek element add karke dekho kya badalta hai.${planNote} Kaunsa ek decision pehle lene se baaki problem ek chhoti copy ban jaati hai?`;
    if (rung === 2) return `Tumne **${a1}** pehle solve kiya tha. Wahan table mein input ke ek range ka best answer rakha tha, aur ranges chhote se bade hote gaye. Yahan bhi wahi shape hai, bas "range" ka matlab tay karna hai.${planNote} Kaunse do indices is problem ki ek state describe karenge?`;
    if (rung === 3) return `Yahan tumhara last verdict **${status || 'ek failed run'}** tha${bw ? ` (${bw} lagta hai)` : ''}. **${a1}** mein tumne ek element wale range ko alag base case bana ke handle kiya tha. Failing input (\`${tc}\`) par apna code haath se trace karo aur expected value se compare karo.${planNote} Single element ke liye tumhara code kya return karta hai?`;
    return `Yeh skeleton hai do gaps ke saath; loop order formula se zyada matter karta hai.\n\n\`\`\`\n${SKELETON}\n\`\`\`\n\nKuch bharne se pehle failing case par apna recurrence dobara chalao.${planNote} Length 2 ke range ko sahi score karne ke liye pehle gap mein kya aayega?`;
  }
  if (rung === 1) return `Start without any technique name. Take the smallest input the constraints allow, answer it by hand, then add one element and watch what changes.${planNote} What single decision, if you made it first, would leave you with a smaller copy of the same problem?`;
  if (rung === 2) return `You already solved **${a1}**. There, the thing you kept in a table was the best answer for a range of the input, and the ranges grew from small to large. This problem has the same shape once you decide what a "range" means here.${planNote} Which two indices would describe one state of this problem?`;
  if (rung === 3) return `Your latest verdict here was **${status || 'a failed run'}**${bw ? ` (it looks like ${bw})` : ''}. In **${a1}** you handled the one-element range as its own base case before any transition ran. Trace your code on the failing input (\`${tc}\`) by hand and compare what it returns with the expected value.${planNote} Which value does your code return for a single element?`;
  return `Here is the skeleton with two gaps; the loop order matters more than the formula.\n\n\`\`\`\n${SKELETON}\n\`\`\`\n\nRe-run your recurrence on the failing case before filling anything in.${planNote} What value belongs in the first gap so that a range of length 2 is scored correctly?`;
}
function templatedReply(lang) {
  return lang === 'hinglish' ? 'Hints abhi paused hain. Tab tak: sabse chhota input kaunsa hai jo tum haath se solve kar sakte ho?' : 'Hints are paused right now. Meanwhile: what is the smallest input you can solve by hand?';
}

function handleChat(u, body) {
  if (!isObj(body)) throw new HttpError(400, 'bad_request', { field: 'body' });
  const slug = body.title_slug;
  if (!isSlug(slug)) throw new HttpError(400, 'bad_request', { field: 'title_slug' });
  if (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) throw new HttpError(400, 'bad_request', { field: 'message' });
  if (body.requested_rung !== undefined && body.requested_rung !== null && !(Number.isInteger(body.requested_rung) && body.requested_rung >= 1 && body.requested_rung <= 4)) throw new HttpError(400, 'bad_request', { field: 'requested_rung' });
  for (const k of ['plan', 'code', 'lang']) if (body[k] !== undefined && body[k] !== null && typeof body[k] !== 'string') throw new HttpError(400, 'bad_request', { field: k });
  if (!SKIP_SYNC_GATE && !(u.profile && u.skill_summary)) throw new HttpError(409, 'not_synced');
  if (body.is_contest) throw new HttpError(403, 'contest_mode');
  ensureProfile(u);
  const lang = language(u);
  let session = u.sessions.get(slug);
  if (!session) { session = { id: uuid(), slug, plan_text: null, turn_count: 0, max_rung: 0, messages: [], created_at: new Date().toISOString() }; u.sessions.set(slug, session); }
  // Same chip semantics as the real contextBuilder.resolvePlan: keys map to sentences, no_idea means "no plan".
  const PLAN_CHIPS = { no_idea: null, have_plan_fails: 'I have a plan but it fails.', too_slow: 'My approach works but it is too slow.', wrong_on_edge: 'My approach is wrong on an edge case.' };
  const planIn = body.plan !== undefined && body.plan !== null ? String(body.plan).trim() : '';
  const plan = body.plan !== undefined ? (planIn ? (Object.prototype.hasOwnProperty.call(PLAN_CHIPS, planIn) ? PLAN_CHIPS[planIn] : planIn.slice(0, 500)) : null) : session.plan_text;
  const c = contractFor(u, slug, { requestedRung: body.requested_rung || null, planStated: !!plan, turns: session.turn_count, isContest: false });
  // daily cap (atomic in the real backend; a counter here)
  if (u.hints.day !== todayUtc()) u.hints = { day: todayUtc(), count: 0 };
  if (u.hints.count >= DAILY_CAP) throw new HttpError(429, 'daily_cap', { cap: DAILY_CAP });
  u.hints.count++;
  const key = familyKeyOf(slug);
  const anchors = key ? ANCHOR_SETS[key].slice(0, 3) : [];
  const offeredHabits = u.habits.filter((h) => h.live && h.state !== 'dismissed' && (key === 'interval' || key === 'knapsack' ? true : h.key === 'overflow')).slice(0, 2).map((h) => habitView(h, lang));
  const verdict = lastFailHere(u, slug);
  const degraded = KILL_LLM;
  const text = degraded ? templatedReply(lang) : cannedReply({ rung: c.rung, lang, anchors, verdict: c.rung >= 3 ? verdict : null, plan });
  const usedAnchors = degraded ? [] : (c.rung >= 2 && anchors[0] ? [anchors[0].slug] : []);
  const userMsg = { id: uuid(), role: 'user', content: body.message, rung: null, anchors: null, habits: null, degraded: false, feedback_thumb: null, feedback_reason: null, created_at: new Date().toISOString() };
  const reply = {
    id: uuid(), role: 'assistant', content: text, rung: c.rung,
    anchors: anchors.map((a) => ({ slug: a.slug, title: a.title, why: a.why, solved_on: a.solved_on, cited: usedAnchors.includes(a.slug) })),
    habits: offeredHabits.map((h) => ({ id: h.id, key: h.key, tier: h.tier, statement: h.statement, used: !degraded && c.rung >= 3 && h.key === 'overflow' })),
    degraded, feedback_thumb: null, feedback_reason: null, feedback_note: null, created_at: new Date(Date.now() + 1).toISOString(),
    contract: c, provider: degraded ? 'template' : 'mock', model: degraded ? null : 'mock-1'
  };
  session.messages.push(userMsg, reply);
  session.turn_count += 1;
  session.max_rung = Math.max(session.max_rung, c.rung);
  if (body.plan !== undefined) session.plan_text = plan;
  session.last_message_at = reply.created_at;
  return {
    response: { message_id: reply.id, reply: text, rung: c.rung, anchors: anchors.map((a) => ({ slug: a.slug, title: a.title, why: a.why })), habits_shown: offeredHabits.map((h) => ({ id: h.id, key: h.key, statement: h.statement })), allowed_rung_next: c.allowed_rung_next, unlock_reason: c.unlock_reason, degraded, provider: reply.provider },
    logNote: `slug=${slug} rung=${c.rung} requested=${body.requested_rung || '-'} allowed_next=${c.allowed_rung_next} code=${typeof body.code === 'string' ? body.code.length + 'ch' : 'none'} hints_today=${u.hints.count}/${DAILY_CAP}`
  };
}

function chatHistory(u, slug) {
  if (!isSlug(slug)) throw new HttpError(400, 'bad_request', { field: 'slug' });
  const s = u.sessions.get(slug);
  if (!s) return { session: null, messages: [] };
  const messages = s.messages.slice(-50).map((m) => ({ id: m.id, role: m.role, content: m.content, rung: m.rung, anchors: m.anchors, habits: m.habits, degraded: m.degraded, feedback_thumb: m.feedback_thumb, feedback_reason: m.feedback_reason, created_at: m.created_at }));
  return { session: { id: s.id, turn_count: s.turn_count, plan_text: s.plan_text, max_rung: s.max_rung }, messages };
}

function messageFeedback(u, id, body) {
  if (!isObj(body)) throw new HttpError(400, 'bad_request', { field: 'body' });
  if (!['up', 'down'].includes(body.thumb)) throw new HttpError(400, 'bad_request', { field: 'thumb' });
  if (body.reason !== undefined && body.reason !== null && !['helped', 'too_much', 'too_little', 'wrong'].includes(body.reason)) throw new HttpError(400, 'bad_request', { field: 'reason' });
  if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 500)) throw new HttpError(400, 'bad_request', { field: 'note' });
  for (const s of u.sessions.values()) {
    const m = s.messages.find((x) => x.id === id && x.role === 'assistant');
    if (m) { m.feedback_thumb = body.thumb; m.feedback_reason = body.reason || null; m.feedback_note = body.note || null; m.feedback_at = new Date().toISOString(); return { ok: true }; }
  }
  throw new HttpError(404, 'message_not_found');
}

function habitFeedback(u, idRaw, body) {
  const id = toInt(idRaw);
  if (!id || id < 1) throw new HttpError(400, 'invalid_habit_id');
  const reaction = isObj(body) ? body.reaction : undefined;
  if (!['confirmed', 'dismissed'].includes(reaction)) throw new HttpError(400, 'invalid_reaction');
  const h = u.habits.find((x) => x.id === id);
  if (!h) throw new HttpError(404, 'habit_not_found');
  h.reaction = reaction; h.state = reaction;
  return { ok: true, id, key: h.key, reaction, state: reaction };
}

function clientEvent(u, body, extVersionHeader) {
  const b = isObj(body) ? body : {};
  const type = typeof b.type === 'string' ? b.type.trim() : '';
  if (!/^[A-Za-z0-9_.:-]{1,48}$/.test(type)) throw new HttpError(400, 'invalid_type');
  const payload = b.payload === undefined || b.payload === null ? null : b.payload;
  if (payload !== null && !isObj(payload)) throw new HttpError(400, 'invalid_payload');
  if (payload !== null && Buffer.byteLength(JSON.stringify(payload), 'utf8') > 4096) throw new HttpError(400, 'payload_too_large', { max_bytes: 4096 });
  u.events.push({ type, ext_version: b.ext_version || extVersionHeader || null, at: new Date().toISOString(), payload_keys: payload ? Object.keys(payload).slice(0, 20) : [] });
  return { accepted: true, type };
}

function debugState() {
  const out = {};
  for (const [token, u] of users) {
    out[u.user_id] = {
      token_hint: `${token.slice(0, 2)}…(${token.length} chars)`, profile: profileView(u), solved: u.solved.size, submissions: u.submissions.size, submissions_with_code: [...u.submissions.values()].filter((s) => !!s.code).length,
      attempts: [...u.attempts.values()].slice(-10), problems_cached: [...u.problems.keys()], habits: u.habits.map((h) => ({ id: h.id, key: h.key, live: h.live, state: h.state, reaction: h.reaction })),
      sessions: [...u.sessions.values()].map((s) => ({ slug: s.slug, turn_count: s.turn_count, max_rung: s.max_rung, plan: !!s.plan_text, feedback: s.messages.filter((m) => m.feedback_thumb).map((m) => ({ id: m.id, thumb: m.feedback_thumb, reason: m.feedback_reason })) })),
      hints: u.hints, events: u.events.slice(-20)
    };
  }
  return { users: out, uptime_s: Math.round((Date.now() - startedAt) / 1000), api_calls: apiCalls, knobs: { cold_start_ms: COLD_START_MS, chat_delay_ms: CHAT_DELAY_MS, fail_every: FAIL_EVERY, kill_llm: KILL_LLM, daily_cap: DAILY_CAP, min_ext_version: MIN_EXT_VERSION, skip_consent_gate: SKIP_CONSENT_GATE, skip_sync_gate: SKIP_SYNC_GATE } };
}

// ---------- router ----------
async function dispatch(req, url, token, u) {
  const p = url.pathname;
  const m = req.method;
  const extVersion = req.headers['x-anchor-ext-version'] || null;
  const body = m === 'GET' || m === 'DELETE' ? null : jsonBody(await readBody(req));
  let x;
  if (m === 'GET' && p === '/api/lc/me') return { status: 200, body: getMe(u) };
  if (m === 'DELETE' && p === '/api/lc/me') return { status: 200, body: deleteMe(token, u) };
  if (m === 'GET' && p === '/api/lc/profile') return { status: 200, body: profileView(u) };
  if (m === 'PUT' && p === '/api/lc/profile') return { status: 200, body: putProfile(u, body) };
  if (m === 'POST' && p === '/api/lc/consent') return { status: 200, body: recordConsent(u, body) };
  if (m === 'POST' && p === '/api/lc/sync') { const r = ingestSync(u, body, extVersion || (body && body.ext_version)); return { status: 200, body: r, note: `phase=${r.phase} upserted=${r.upserted} known=${r.total_submissions_known}` }; }
  if (m === 'PUT' && (x = /^\/api\/lc\/problems\/([^/]+)\/?$/.exec(p))) { const r = putProblem(u, decodeURIComponent(x[1]), body); return { status: 200, body: r, note: `created=${r.created}` }; }
  if (m === 'GET' && (x = /^\/api\/lc\/anchors\/([^/]+)\/?$/.exec(p))) { const r = getAnchors(u, decodeURIComponent(x[1])); return { status: 200, body: r, note: `anchors=${r.anchors.length} allowed=${r.allowed_rung}` }; }
  if (m === 'POST' && p === '/api/lc/attempts') { const r = recordAttempt(u, body); return { status: 200, body: r, note: `slug=${r.slug} id=${r.submission_id} bucket=${r.bucket} first_ac=${r.is_first_ac} known=${r.already_known} code=${body.code ? 'yes' : 'no'}` }; }
  if (m === 'POST' && p === '/api/lc/chat') { if (CHAT_DELAY_MS) await sleep(CHAT_DELAY_MS); const r = handleChat(u, body); return { status: 200, body: r.response, note: r.logNote }; }
  if (m === 'GET' && (x = /^\/api\/lc\/chat\/([^/]+)\/history\/?$/.exec(p))) { const r = chatHistory(u, decodeURIComponent(x[1])); return { status: 200, body: r, note: `messages=${r.messages.length}` }; }
  if (m === 'POST' && (x = /^\/api\/lc\/chat\/messages\/([^/]+)\/feedback\/?$/.exec(p))) return { status: 200, body: messageFeedback(u, decodeURIComponent(x[1]), body), note: `thumb=${body.thumb} reason=${body.reason || '-'}` };
  if (m === 'POST' && (x = /^\/api\/lc\/habits\/([^/]+)\/feedback\/?$/.exec(p))) { const r = habitFeedback(u, x[1], body); return { status: 200, body: r, note: `habit=${r.key} reaction=${r.reaction}` }; }
  if (m === 'POST' && p === '/api/lc/client-events') { const r = clientEvent(u, body, extVersion); return { status: 202, body: { accepted: true }, note: `type=${r.type}` }; }
  throw new HttpError(404, 'not_found');
}

function writeJson(res, status, obj, extra) {
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, extra || {}));
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const t0 = Date.now();
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const origin = req.headers.origin || '';
  const cors = corsHeaders(origin);
  const finish = (status, body, note) => {
    writeJson(res, status, body, cors);
    console.log(`[mock] ${now()} ${req.method} ${url.pathname} -> ${status} ${Date.now() - t0}ms${note ? ' ' + note : ''}`);
  };
  if (!isAllowedOrigin(origin)) { finish(403, { error: 'origin_not_allowed' }, `origin=${origin}`); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); console.log(`[mock] ${now()} OPTIONS ${url.pathname} -> 204 origin=${origin || '-'}`); return; }

  const slow = Math.min(MAX_SLOW_MS, Math.max(0, Number(url.searchParams.get('slow')) || 0));
  if (slow) await sleep(slow);
  if (!firstRequestSeen) { firstRequestSeen = true; if (COLD_START_MS) { console.log(`[mock] ${now()} cold start: holding the first request ${COLD_START_MS}ms`); await sleep(COLD_START_MS); } }

  const p = url.pathname;
  if (req.method === 'GET' && p === '/health') { finish(200, health(), slow ? `slow=${slow}` : ''); return; }
  if (req.method === 'GET' && p === '/health/ready') { finish(200, { status: 'ok' }); return; }
  if (req.method === 'GET' && p === '/__mock/state') { finish(200, debugState()); return; }
  if (req.method === 'POST' && p === '/__mock/reset') { users.clear(); finish(200, { ok: true }); return; }
  if (!p.startsWith('/api/lc/')) { finish(404, { error: 'not_found' }); return; }

  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) { finish(401, { error: 'unauthorized' }, 'auth=no'); return; }
  if (token === 'expired' || token === 'bad') { finish(401, { error: token === 'expired' ? 'token_expired' : 'invalid_token' }, 'auth=rejected'); return; }
  apiCalls++;
  if (FAIL_EVERY && apiCalls % FAIL_EVERY === 0) { finish(503, { error: 'mock_unavailable' }, `fail_every=${FAIL_EVERY} call=${apiCalls}`); return; }
  const u = userFor(token);
  try {
    const out = await dispatch(req, url, token, u);
    finish(out.status, out.body, `user=${u.user_id}${out.note ? ' ' + out.note : ''}${slow ? ` slow=${slow}` : ''}`);
  } catch (err) {
    if (err instanceof HttpError) { finish(err.status, Object.assign({ error: err.error }, err.extra || {}), `user=${u.user_id} error=${err.error}`); return; }
    finish(500, { error: 'internal', message: String(err && err.message || err) }, `user=${u.user_id} ${String(err && err.stack || err).split('\n').slice(0, 2).join(' | ')}`);
  }
}

http.createServer((req, res) => { handle(req, res).catch((err) => { try { writeJson(res, 500, { error: 'internal' }); } catch (_) { /* ignore */ } console.log(`[mock] ${now()} unhandled ${String(err && err.message || err)}`); }); })
  .listen(PORT, () => {
    console.log(`[mock] anchor mock backend on http://localhost:${PORT}  (state is in memory; GET /__mock/state to inspect)`);
    const knobs = Object.entries({ MOCK_COLD_START_MS: COLD_START_MS, MOCK_CHAT_DELAY_MS: CHAT_DELAY_MS, MOCK_FAIL_EVERY: FAIL_EVERY, MOCK_KILL_LLM: KILL_LLM, MOCK_DAILY_CAP: DAILY_CAP, MOCK_MIN_EXT_VERSION: MIN_EXT_VERSION, MOCK_SKIP_CONSENT_GATE: SKIP_CONSENT_GATE, MOCK_SKIP_SYNC_GATE: SKIP_SYNC_GATE }).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`[mock] knobs: ${knobs}`);
  });
