'use strict';
/**
 * syncService: ingests the extension's first-run / incremental sync in three phases.
 *   solved       (re)starts a sync: profile -> partial, solved list + minimal problem rows, recent_ac timestamps
 *   submissions  <=200 rows per request, fill-if-null upserts (re-sends are no-ops), code only with consent
 *   finalize     synchronous recompute, profile -> complete, one lc_skill_events('sync') row
 * Every phase needs an lc_consents row for config.consentVersion (403 consent_required) and is off when
 * config.killSync (503 sync_paused). submissions/finalize must carry the sync_id of the running sync (409).
 */
const { withTransaction } = require('../../db/transaction');
const repo = require('../db/repo');
const modelService = require('./modelService');
const { HttpError } = require('../middleware/errors');
const { isSlug, clampStr, toInt, isPlainObject } = require('../middleware/validate');
const { bucketOf, statusOf } = require('../domain/buckets');
const { normDiff } = require('../domain/seed');
const { MODEL_VERSION } = require('../domain/constants');

const PHASES = new Set(['solved', 'submissions', 'finalize']);
const MAX_SOLVED = 1000;
const MAX_SUBMISSIONS = 200;
const MAX_TAGS = 40;
const TEXT_CAP = 8000;
const CODE_CAP = 200000;
const SOLVED_BATCH = 250;
const SUBMISSION_BATCH = 100;
const SYNC_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }
function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now > 1e12 ? now : now * 1000);
  return new Date();
}
const numOrNull = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const strOrNull = (v, n) => { const s = clampStr(v, n); return s && s.trim() ? s.trim() : null; };

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const t of tags) {
    const raw = typeof t === 'string' ? t : (t && typeof t.slug === 'string' ? t.slug : null);
    if (!raw) continue;
    const s = raw.trim().toLowerCase().slice(0, 64);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function fromCatalog(slug, seed) {
  const c = seed ? seed.problemFromCatalog(slug) : null;
  return { slug, title: c ? c.title : null, frontend_id: c ? c.frontendId : null, difficulty: c ? c.difficulty : null, tags: c ? (c.tags || []) : [], paid: c ? !!c.paid : false, solved_at: null };
}

function normalizeSolvedRow(item, seed) {
  if (!isPlainObject(item)) return null;
  const slug = item.slug || item.titleSlug || item.title_slug;
  if (!isSlug(slug)) return null;
  const base = fromCatalog(slug, seed);
  const tags = cleanTags(item.tags || item.topic_tags || item.topicTags);
  const fid = item.frontend_id ?? item.frontendId ?? item.frontendQuestionId;
  return {
    slug,
    title: strOrNull(item.title, 255) || base.title,
    frontend_id: fid === undefined || fid === null || fid === '' ? base.frontend_id : String(fid).slice(0, 16),
    difficulty: normDiff(item.difficulty) || base.difficulty,
    tags: tags.length ? tags : base.tags,
    paid: item.paid === undefined ? base.paid : !!item.paid,
    solved_at: null
  };
}

function normalizeSubmissionRow(item, consentCode) {
  if (!isPlainObject(item)) return null;
  // toInt clamps to its bounds, so range-check explicitly: an id or timestamp of 0 is invalid, never 1.
  const id = toInt(item.id ?? item.lc_submission_id ?? item.submission_id);
  if (id === null || id < 1) return null;
  const slug = item.slug || item.title_slug || item.titleSlug;
  if (!isSlug(slug)) return null;
  const ts = toInt(item.timestamp ?? item.ts);
  if (ts === null || ts < 1) return null;
  const statusMsg = strOrNull(item.status_msg ?? item.status_display ?? item.statusDisplay, 64);
  const statusCode = statusOf({ status_code: item.status_code, status_msg: statusMsg });
  const det = isPlainObject(item.details) ? item.details : null;
  const bucket = bucketOf({ status_code: statusCode, status_msg: statusMsg }, det);
  const code = consentCode && typeof item.code === 'string' && item.code.length ? item.code.slice(0, CODE_CAP) : null;
  return {
    lc_submission_id: id,
    slug,
    status_code: statusCode,
    status_msg: statusMsg,
    verdict_bucket: bucket,
    lang: strOrNull(item.lang, 32),
    ts,
    runtime_percentile: numOrNull(det ? det.runtime_percentile ?? item.runtime_percentile : item.runtime_percentile),
    last_testcase: det ? clampStr(det.last_testcase, TEXT_CAP) : null,
    expected_output: det ? clampStr(det.expected_output, TEXT_CAP) : null,
    code_output: det ? clampStr(det.code_output, TEXT_CAP) : null,
    error_text: det ? clampStr(det.error_text, TEXT_CAP) : null,
    total_correct: det ? toInt(det.total_correct, { min: 0 }) : null,
    total_testcases: det ? toInt(det.total_testcases, { min: 0 }) : null,
    has_details: !!det,
    code,
    captured_via: 'sync'
  };
}

function compactTagCounts(tc) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(tc)) {
    if (typeof k !== 'string' || !k) continue;
    const c = toInt(v, { min: 0 });
    if (c === null) continue;
    out[k.slice(0, 64)] = c;
    if (++n >= 300) break;
  }
  return out;
}

function activeProgress(profile, syncId) {
  const progress = profile && isPlainObject(profile.sync_progress) ? profile.sync_progress : null;
  if (!progress || progress.sync_id !== syncId) throw new HttpError(409, 'sync_id_mismatch', { active_sync_id: progress ? progress.sync_id || null : null });
  return progress;
}

async function ingestSolved(pool, userId, body, ctx) {
  const { seed, syncId, at, extVersion } = ctx;
  const solvedIn = Array.isArray(body.solved) ? body.solved : [];
  if (solvedIn.length > MAX_SOLVED) throw new HttpError(400, 'too_many_rows', { max: MAX_SOLVED });
  const rows = new Map();
  let dropped = 0;
  for (const item of solvedIn) {
    const r = normalizeSolvedRow(item, seed);
    if (!r) { dropped++; continue; }
    rows.set(r.slug, r);
  }
  const recentAc = Array.isArray(body.recent_ac) ? body.recent_ac : [];
  for (const ra of recentAc) {
    if (!isPlainObject(ra) || !isSlug(ra.slug)) continue;
    const ts = toInt(ra.timestamp ?? ra.ts);
    if (ts === null || ts < 1) continue;
    let r = rows.get(ra.slug);
    if (!r) { r = fromCatalog(ra.slug, seed); rows.set(ra.slug, r); }
    const when = new Date(ts * 1000);
    if (!r.solved_at || when < r.solved_at) r.solved_at = when;
  }
  const tagCounts = isPlainObject(body.tag_counts) ? compactTagCounts(body.tag_counts) : null;
  const username = strOrNull(body.leetcode_username, 64);
  const list = [...rows.values()];
  await withTransaction(pool, async (conn) => {
    await repo.profiles.ensure(conn, userId);
    const progress = { sync_id: syncId, phase: 'solved', started: at.toISOString(), chunks: 0, submissions_seen: 0, solved_count: list.length, ext_version: extVersion || null };
    if (tagCounts) progress.tag_counts = tagCounts;
    const fields = { sync_status: 'partial', sync_progress: progress };
    if (username) fields.leetcode_username = username;
    await repo.profiles.update(conn, userId, fields);
    for (const chunk of chunks(list, SOLVED_BATCH)) {
      await repo.solved.upsertMany(conn, userId, chunk.map((r) => ({ slug: r.slug, title: r.title, difficulty: r.difficulty, tags: r.tags.length ? r.tags : null, source: 'sync', solved_at: r.solved_at || null })));
    }
    const existing = new Set();
    for (const chunk of chunks(list.map((r) => r.slug), SOLVED_BATCH)) for (const p of await repo.problems.getMany(conn, chunk)) existing.add(p.slug);
    for (const r of list) {
      if (existing.has(r.slug)) continue;
      await repo.problems.upsertFirstWriter(conn, { slug: r.slug, title: r.title || r.slug, frontend_id: r.frontend_id, difficulty: r.difficulty, topic_tags: r.tags.length ? r.tags : null, is_paid: r.paid, first_writer_user_id: userId });
    }
  });
  const { count } = await repo.submissions.maxId(pool, userId);
  return { ok: true, phase: 'solved', sync_id: syncId, upserted: list.length, dropped, total_submissions_known: Number(count) || 0, next: 'submissions' };
}

async function ingestSubmissions(pool, userId, body, ctx) {
  const { syncId, at, extVersion } = ctx;
  const profile = await repo.profiles.get(pool, userId);
  const progress = activeProgress(profile, syncId);
  const subsIn = Array.isArray(body.submissions) ? body.submissions : [];
  if (subsIn.length > MAX_SUBMISSIONS) throw new HttpError(400, 'too_many_rows', { max: MAX_SUBMISSIONS });
  const consentCode = !!Number(profile.consent_code);
  const rows = [];
  const seen = new Set();
  let dropped = 0;
  for (const item of subsIn) {
    const r = normalizeSubmissionRow(item, consentCode);
    if (!r || seen.has(r.lc_submission_id)) { dropped++; continue; }
    seen.add(r.lc_submission_id);
    rows.push(r);
  }
  await withTransaction(pool, async (conn) => {
    for (const chunk of chunks(rows, SUBMISSION_BATCH)) await repo.submissions.upsertMany(conn, userId, chunk);
    const next = { ...progress, phase: 'submissions', chunks: (Number(progress.chunks) || 0) + 1, submissions_seen: (Number(progress.submissions_seen) || 0) + rows.length, last_chunk_at: at.toISOString() };
    if (extVersion) next.ext_version = extVersion;
    await repo.profiles.update(conn, userId, { sync_status: 'partial', sync_progress: next });
  });
  const { count } = await repo.submissions.maxId(pool, userId);
  return { ok: true, phase: 'submissions', sync_id: syncId, upserted: rows.length, dropped, code_stored: consentCode, total_submissions_known: Number(count) || 0, next: 'finalize' };
}

async function finalize(pool, userId, body, ctx) {
  const { seed, syncId, at, extVersion } = ctx;
  const profile = await repo.profiles.get(pool, userId);
  const progress = activeProgress(profile, syncId);
  // recent_ac may arrive with finalize (the panel sends it last): fill solved_at where still unknown.
  const recentAc = Array.isArray(body.recent_ac) ? body.recent_ac : [];
  const acRows = [];
  for (const ra of recentAc) {
    if (!isPlainObject(ra) || !isSlug(ra.slug)) continue;
    const ts = toInt(ra.timestamp ?? ra.ts);
    if (ts === null || ts < 1) continue;
    const base = fromCatalog(ra.slug, seed);
    acRows.push({ ...base, solved_at: new Date(ts * 1000) });
  }
  if (acRows.length) await repo.solved.upsertMany(pool, userId, acRows);
  const recompute = await modelService.recomputeStudentModel(pool, userId, { seed, now: Math.floor(at.getTime() / 1000) });
  const liveKeys = recompute.habits.filter((h) => h.live).map((h) => h.key);
  const next = { ...progress, phase: 'complete', finished: at.toISOString() };
  if (extVersion) next.ext_version = extVersion;
  await withTransaction(pool, async (conn) => {
    await repo.profiles.update(conn, userId, { sync_status: 'complete', last_synced_at: at, sync_progress: next });
    await repo.events.skill(conn, userId, 'sync', {
      phase: 'finalize',
      sync_id: syncId,
      chunks: Number(progress.chunks) || 0,
      submissions_seen: Number(progress.submissions_seen) || 0,
      solved_count: Number(progress.solved_count) || 0,
      n_attempts: recompute.n_attempts,
      n_solved: recompute.n_solved,
      habit_keys: recompute.habits.map((h) => h.key),
      live_keys: liveKeys,
      recompute_ms: recompute.ms,
      ext_version: extVersion || progress.ext_version || null
    }, MODEL_VERSION);
  });
  const { count, max } = await repo.submissions.maxId(pool, userId);
  return {
    ok: true,
    phase: 'finalize',
    sync_id: syncId,
    upserted: 0,
    total_submissions_known: Number(count) || 0,
    max_lc_submission_id: max,
    next: null,
    recompute: { n_attempts: recompute.n_attempts, n_solved: recompute.n_solved, habits: recompute.habits.length, habits_live: liveKeys.length, ms: recompute.ms, model_version: recompute.model_version }
  };
}

/**
 * ingestSync(pool, userId, body, { seed, config, now }) -> { ok, phase, upserted, total_submissions_known, next, recompute? }
 */
async function ingestSync(pool, userId, body, { seed, config, now } = {}) {
  if (!isPlainObject(body)) throw new HttpError(400, 'invalid_body');
  if (config && config.killSync) throw new HttpError(503, 'sync_paused');
  const phase = body.phase;
  if (!PHASES.has(phase)) throw new HttpError(400, 'invalid_phase');
  const syncId = typeof body.sync_id === 'string' && SYNC_ID_RE.test(body.sync_id) ? body.sync_id : null;
  if (!syncId) throw new HttpError(400, 'invalid_sync_id');
  const consentVersion = config ? config.consentVersion : '1';
  const consent = await repo.consents.get(pool, userId, consentVersion);
  if (!consent) throw new HttpError(403, 'consent_required', { consent_version: consentVersion });
  const ctx = { seed, config, syncId, at: toDate(now), extVersion: strOrNull(body.ext_version, 20) };
  if (phase === 'solved') return ingestSolved(pool, userId, body, ctx);
  if (phase === 'submissions') return ingestSubmissions(pool, userId, body, ctx);
  return finalize(pool, userId, body, ctx);
}

module.exports = { ingestSync, normalizeSolvedRow, normalizeSubmissionRow, cleanTags, MAX_SOLVED, MAX_SUBMISSIONS };
