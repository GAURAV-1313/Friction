'use strict';
/**
 * profileService: /me, /profile, /consent, delete.
 *   getMe(pool, userId, { seed, config, auth, now })
 *   getProfile(pool, userId, { config })
 *   putProfile(pool, userId, body, { config, now })    consent true -> consent_at; true->false nulls stored code
 *   recordConsent(pool, userId, body, { config })
 *   deleteMe(pool, userId)                             every lc_ row for the user; users row untouched
 */
const { withTransaction } = require('../../db/transaction');
const repo = require('../db/repo');
const { HttpError } = require('../middleware/errors');
const { isPlainObject } = require('../middleware/validate');
const { renderStatement } = require('../domain/habits');
const { MODEL_VERSION } = require('../domain/constants');

const LANGUAGES = new Set(['english', 'hinglish']);
const USERNAME_RE = /^[^\s]{1,64}$/;
const VERSION_RE = /^[A-Za-z0-9_.-]{1,16}$/;

function toDate(now) {
  if (now instanceof Date) return now;
  if (typeof now === 'number' && Number.isFinite(now)) return new Date(now > 1e12 ? now : now * 1000);
  return new Date();
}
const pad2 = (n) => String(n).padStart(2, '0');
// mysql2 returns DATE columns as local-midnight Date objects (or 'YYYY-MM-DD' with dateStrings).
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad2(v.getMonth() + 1)}-${pad2(v.getDate())}`;
  return String(v).slice(0, 10);
}
const iso = (v) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

function summarizeProgress(p) {
  if (!isPlainObject(p)) return null;
  const { sync_id, phase, started, chunks, submissions_seen, solved_count, finished, last_chunk_at, ext_version } = p;
  return { sync_id: sync_id || null, phase: phase || null, started: started || null, chunks: chunks || 0, submissions_seen: submissions_seen || 0, solved_count: solved_count || 0, last_chunk_at: last_chunk_at || null, finished: finished || null, ext_version: ext_version || null };
}

function profileView(profile, consent, consentVersion) {
  return {
    language: (profile && profile.language) || 'english',
    consent_code: !!(profile && Number(profile.consent_code)),
    consent_at: iso(profile ? profile.consent_at : null),
    leetcode_username: (profile && profile.leetcode_username) || null,
    sync_status: (profile && profile.sync_status) || 'never',
    sync_progress: profile ? summarizeProgress(profile.sync_progress) : null,
    last_synced_at: iso(profile ? profile.last_synced_at : null),
    consent_version_accepted: consent ? consent.version : null,
    consent_version_required: consentVersion,
    exists: !!profile
  };
}

function habitView(h, language, seed) {
  const domainHabit = { key: h.habit_key, category: h.category, subpattern: h.subpattern, bucket: h.bucket, tier: h.tier, live: !!Number(h.live), counts: h.counts || {}, evidence: h.evidence || {}, statement_template: h.category };
  return {
    id: Number(h.id),
    key: h.habit_key,
    category: h.category,
    subpattern: h.subpattern || null,
    subpattern_label: h.subpattern && seed ? seed.subLabel.get(h.subpattern) || h.subpattern : null,
    bucket: h.bucket || null,
    tier: h.tier,
    live: !!Number(h.live),
    state: h.state,
    reaction: h.reaction || null,
    counts: h.counts || {},
    evidence: h.evidence || {},
    statement: renderStatement(domainHabit, language, seed),
    last_seen_at: iso(h.last_seen_at)
  };
}

async function getMe(pool, userId, { seed, config, auth, now } = {}) {
  const at = toDate(now);
  const profile = await repo.profiles.get(pool, userId);
  const consent = await repo.consents.get(pool, userId, config.consentVersion);
  const solvedRows = await repo.solved.listForUser(pool, userId);
  const { max, count } = await repo.submissions.maxId(pool, userId);
  const allHabits = await repo.habits.listForUser(pool, userId);
  const language = (profile && profile.language) || 'english';
  const habits = allHabits
    .filter((h) => h.state !== 'dismissed' && (Number(h.live) === 1 || h.state === 'confirmed'))
    .map((h) => habitView(h, language, seed));
  const todayUtc = at.toISOString().slice(0, 10);
  const hintsToday = profile && dateStr(profile.hints_day) === todayUtc ? Number(profile.hints_today) || 0 : 0;
  return {
    user: { user_id: userId, email: (auth && auth.email) || null, name: (auth && auth.name) || null },
    profile: profileView(profile, consent, config.consentVersion),
    counts: { solved: solvedRows.length, submissions: Number(count) || 0, max_lc_submission_id: max === undefined ? null : max },
    skill_summary: profile ? profile.skill_summary || null : null,
    habits,
    hints: { today: hintsToday, cap: config.dailyHintCap, resets_at: '00:00 UTC' },
    model_version: (profile && profile.model_version) || null,
    current_model_version: MODEL_VERSION,
    min_extension_version: config.minExtensionVersion,
    kill: { llm: !!config.killLlm, sync: !!config.killSync },
    consent_version: config.consentVersion
  };
}

async function getProfile(pool, userId, { config } = {}) {
  const profile = await repo.profiles.get(pool, userId);
  const consent = await repo.consents.get(pool, userId, config.consentVersion);
  return profileView(profile, consent, config.consentVersion);
}

function validateProfileUpdate(body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'invalid_body');
  const fields = {};
  if (body.language !== undefined) {
    if (!LANGUAGES.has(body.language)) throw new HttpError(400, 'invalid_language');
    fields.language = body.language;
  }
  if (body.consent_code !== undefined) {
    if (typeof body.consent_code !== 'boolean') throw new HttpError(400, 'invalid_consent_code');
    fields.consent_code = body.consent_code ? 1 : 0;
  }
  if (body.leetcode_username !== undefined) {
    if (body.leetcode_username === null || body.leetcode_username === '') fields.leetcode_username = null;
    else {
      const u = typeof body.leetcode_username === 'string' ? body.leetcode_username.trim() : '';
      if (!USERNAME_RE.test(u)) throw new HttpError(400, 'invalid_leetcode_username');
      fields.leetcode_username = u;
    }
  }
  if (!Object.keys(fields).length) throw new HttpError(400, 'no_fields');
  return fields;
}

async function putProfile(pool, userId, body, { config, now } = {}) {
  const fields = validateProfileUpdate(body);
  const at = toDate(now);
  const result = await withTransaction(pool, async (conn) => {
    const beforeRow = await repo.profiles.ensure(conn, userId);
    const hadConsent = !!(beforeRow && Number(beforeRow.consent_code));
    let codeRowsNulled = 0;
    if (fields.consent_code === 1) fields.consent_at = at;
    if (fields.consent_code === 0) codeRowsNulled = await repo.submissions.nullAllCode(conn, userId);
    const after = await repo.profiles.update(conn, userId, fields);
    await repo.events.skill(conn, userId, 'profile', {
      fields: Object.keys(fields).filter((k) => k !== 'consent_at'),
      consent_granted: fields.consent_code === 1 && !hadConsent,
      consent_revoked: fields.consent_code === 0 && hadConsent,
      code_rows_nulled: codeRowsNulled
    }, null);
    return { after, codeRowsNulled };
  });
  const consent = await repo.consents.get(pool, userId, config.consentVersion);
  return { ok: true, profile: profileView(result.after, consent, config.consentVersion), code_rows_nulled: result.codeRowsNulled };
}

async function recordConsent(pool, userId, body, { config } = {}) {
  const raw = isPlainObject(body) ? body.version : undefined;
  const version = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'invalid_version');
  await repo.profiles.ensure(pool, userId);
  await repo.consents.insert(pool, userId, version);
  return { ok: true, version, required_version: config.consentVersion, satisfied: version === config.consentVersion };
}

async function deleteMe(pool, userId) {
  const counts = await withTransaction(pool, (conn) => repo.purgeUser(conn, userId));
  return { deleted: true, counts };
}

module.exports = { getMe, getProfile, putProfile, recordConsent, deleteMe, profileView, habitView, validateProfileUpdate };
