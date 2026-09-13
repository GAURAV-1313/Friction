'use strict';
/**
 * attemptService: records one live-captured verdict (interceptor or manual), detects the first AC for the
 * problem, marks it assisted when a chat session for that slug had turns, then recomputes the model.
 * Idempotent: repo.submissions.upsertMany is fill-if-null, so a re-sent verdict changes nothing.
 *
 *   recordAttempt(pool, userId, body, { seed, config, now }) ->
 *     { ok, submission_id, slug, bucket, tier, is_first_ac, assisted, already_known, habits_changed, recompute_ms, allowed_rung_next }
 */
const { withTransaction } = require('../../db/transaction');
const repo = require('../db/repo');
const modelService = require('./modelService');
const { HttpError } = require('../middleware/errors');
const { isSlug, clampStr, toInt, isPlainObject } = require('../middleware/validate');
const { bucketOf, tierOf, statusOf } = require('../domain/buckets');
const { decideRung } = require('../domain/policy');
const { normDiff } = require('../domain/seed');
const { MODEL_VERSION } = require('../domain/constants');

const CAPTURED_VIA = new Set(['interceptor', 'manual']);
const TEXT_CAP = 8000;
const CODE_CAP = 200000;
const DETAIL_KEYS = ['last_testcase', 'expected_output', 'code_output', 'error_text', 'total_correct', 'total_testcases'];

function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now > 1e12 ? now : now * 1000);
  return new Date();
}
const numOrNull = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const strOrNull = (v, n) => { const s = clampStr(v, n); return s && s.trim() ? s.trim() : null; };

function validateAttempt(body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'invalid_body');
  // toInt clamps to its bounds, so range-check explicitly: 0 must be rejected, never coerced to 1.
  const id = toInt(body.submission_id ?? body.id);
  if (id === null || id < 1) throw new HttpError(400, 'invalid_submission_id');
  const slug = body.title_slug || body.slug;
  if (!isSlug(slug)) throw new HttpError(400, 'invalid_slug');
  const capturedVia = body.captured_via === undefined ? 'interceptor' : body.captured_via;
  if (!CAPTURED_VIA.has(capturedVia)) throw new HttpError(400, 'invalid_captured_via');
  const statusMsg = strOrNull(body.status_msg ?? body.status_display, 64);
  const statusCode = statusOf({ status_code: body.status_code, status_msg: statusMsg });
  if (statusCode === null || !Number.isInteger(statusCode)) throw new HttpError(400, 'invalid_status');
  const ts = toInt(body.timestamp ?? body.ts);
  if (ts === null || ts < 1) throw new HttpError(400, 'invalid_timestamp');
  const hasDetails = DETAIL_KEYS.some((k) => body[k] !== undefined && body[k] !== null);
  const details = hasDetails ? {
    last_testcase: clampStr(body.last_testcase, TEXT_CAP),
    expected_output: clampStr(body.expected_output, TEXT_CAP),
    code_output: clampStr(body.code_output, TEXT_CAP),
    error_text: clampStr(body.error_text, TEXT_CAP),
    total_correct: toInt(body.total_correct, { min: 0 }),
    total_testcases: toInt(body.total_testcases, { min: 0 })
  } : null;
  const code = typeof body.code === 'string' && body.code.length ? body.code.slice(0, CODE_CAP) : null;
  return { id, slug, capturedVia, statusCode, statusMsg, lang: strOrNull(body.lang, 32), ts, details, runtimePercentile: numOrNull(body.runtime_percentile), code };
}

const before = (r, ts, id) => Number(r.ts) < ts || (Number(r.ts) === ts && Number(r.lc_submission_id) < id);

async function recordAttempt(pool, userId, body, { seed, config, now } = {}) {
  if (!seed) throw new Error('recordAttempt: seed is required');
  const at = toDate(now);
  const nowS = Math.floor(at.getTime() / 1000);
  const a = validateAttempt(body);
  const profile = await repo.profiles.ensure(pool, userId);
  const consent = !!(profile && Number(profile.consent_code));
  const bucket = bucketOf({ status_code: a.statusCode, status_msg: a.statusMsg }, a.details);
  const tier = tierOf(bucket);
  const isAc = a.statusCode === 10;

  const existing = await repo.submissions.listForSlug(pool, userId, a.slug);
  const others = existing.filter((r) => Number(r.lc_submission_id) !== a.id);
  const known = existing.some((r) => Number(r.lc_submission_id) === a.id);
  const priorAcs = others.filter((r) => Number(r.status_code) === 10 && before(r, a.ts, a.id));
  const isFirstAc = isAc && priorAcs.length === 0;
  const failsBefore = others.filter((r) => Number(r.status_code) !== 10 && before(r, a.ts, a.id)).length;

  const habitsBefore = await repo.habits.listForUser(pool, userId);
  const liveBefore = new Map(habitsBefore.map((h) => [h.habit_key, !!Number(h.live)]));
  const sessions = await repo.sessions.listOpenForUser(pool, userId);
  const session = sessions.find((s) => s.slug === a.slug) || null;
  const turns = session ? Number(session.turn_count) || 0 : 0;
  const assisted = isFirstAc && turns > 0;

  const row = {
    lc_submission_id: a.id,
    slug: a.slug,
    status_code: a.statusCode,
    status_msg: a.statusMsg,
    verdict_bucket: bucket,
    lang: a.lang,
    ts: a.ts,
    runtime_percentile: a.runtimePercentile,
    last_testcase: a.details ? a.details.last_testcase : null,
    expected_output: a.details ? a.details.expected_output : null,
    code_output: a.details ? a.details.code_output : null,
    error_text: a.details ? a.details.error_text : null,
    total_correct: a.details ? a.details.total_correct : null,
    total_testcases: a.details ? a.details.total_testcases : null,
    has_details: !!a.details,
    code: consent ? a.code : null,
    captured_via: a.capturedVia
  };

  await withTransaction(pool, async (conn) => {
    await repo.submissions.upsertMany(conn, userId, [row]);
    if (isFirstAc) {
      const cached = await repo.problems.get(conn, a.slug);
      const cat = seed.problemFromCatalog(a.slug);
      const tags = (cached && Array.isArray(cached.topic_tags) && cached.topic_tags.length) ? cached.topic_tags : (cat ? cat.tags || [] : []);
      await repo.solved.upsertComputed(conn, userId, [{
        slug: a.slug,
        title: (cached && cached.title) || (cat && cat.title) || a.slug,
        difficulty: normDiff((cached && cached.difficulty) || (cat && cat.difficulty)),
        tags: tags.length ? tags : null,
        source: 'attempt',
        first_ac_ts: a.ts,
        first_ac_submission_id: a.id,
        attempts_to_ac: failsBefore + 1,
        fails_before_ac: failsBefore
      }]);
      await repo.solved.setAssisted(conn, userId, a.slug, assisted);
    }
    await repo.events.skill(conn, userId, 'attempt', {
      id: a.id, slug: a.slug, status_code: a.statusCode, bucket, tier, captured_via: a.capturedVia,
      is_first_ac: isFirstAc, assisted, already_known: known, has_details: !!a.details, has_code: !!row.code
    }, MODEL_VERSION);
  });

  const recompute = await modelService.recomputeStudentModel(pool, userId, { seed, now: nowS });
  const liveAfter = new Map((recompute.habits || []).map((h) => [h.key, !!h.live]));
  const changed = new Set();
  for (const [k, v] of liveAfter) if ((liveBefore.get(k) || false) !== v) changed.add(k);
  for (const [k, v] of liveBefore) if (v && !liveAfter.has(k)) changed.add(k);

  const submissionsHere = others.length + 1;
  const contract = decideRung({
    requestedRung: null,
    planStated: false,
    submissionsHere,
    turns,
    lastFailAgeS: isAc ? null : Math.max(0, nowS - a.ts),
    lastFailBucket: isAc ? null : bucket,
    isContest: false,
    maxRungGlobal: config && Number.isFinite(config.maxRung) ? config.maxRung : undefined
  });

  return {
    ok: true,
    submission_id: a.id,
    slug: a.slug,
    bucket,
    tier,
    is_first_ac: isFirstAc,
    assisted,
    already_known: known,
    solved_here: isAc || others.some((r) => Number(r.status_code) === 10),
    submissions_here: submissionsHere,
    habits_changed: [...changed].sort(),
    recompute_ms: recompute.ms,
    allowed_rung_next: contract.allowed_rung_next,
    unlock_reason: contract.unlock_reason,
    model_version: MODEL_VERSION
  };
}

module.exports = { recordAttempt, validateAttempt };
