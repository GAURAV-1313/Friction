'use strict';
/**
 * Repository: every SQL statement for Recall lives here. Every function takes `db` (a pool or a
 * transaction connection) first, so services can run inside withTransaction() or against a mock.
 * JSON columns are parsed defensively (mysql2 usually parses them already).
 */
const crypto = require('crypto');
const { parseJson } = require('../middleware/validate');

const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const uuid = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function rowJson(row, keys) { if (!row) return row; for (const k of keys) if (k in row) row[k] = parseJson(row[k], null); return row; }

// ---------------- profiles ----------------
const PROFILE_JSON = ['sync_progress', 'skill_summary'];
const PROFILE_FIELDS = new Set(['leetcode_username', 'language', 'consent_code', 'consent_at', 'sync_status', 'sync_progress', 'last_synced_at', 'skill_summary', 'model_version']);
const profiles = {
  async get(db, userId) { const [rows] = await db.query('SELECT * FROM lc_profiles WHERE user_id = ?', [userId]); return rows.length ? rowJson(rows[0], PROFILE_JSON) : null; },
  async ensure(db, userId) { await db.query('INSERT IGNORE INTO lc_profiles (user_id) VALUES (?)', [userId]); return profiles.get(db, userId); },
  async update(db, userId, fields) {
    const sets = []; const vals = [];
    for (const [k, v] of Object.entries(fields || {})) { if (!PROFILE_FIELDS.has(k)) continue; sets.push(`${k} = ?`); vals.push(k === 'sync_progress' || k === 'skill_summary' ? J(v) : v); }
    if (!sets.length) return profiles.get(db, userId);
    await db.query(`UPDATE lc_profiles SET ${sets.join(', ')} WHERE user_id = ?`, [...vals, userId]);
    return profiles.get(db, userId);
  },
  // Returns true if the hint is allowed (and counted), false if the daily cap is reached.
  async incrementHintsAtomic(db, userId, cap) {
    const [r] = await db.query('UPDATE lc_profiles SET hints_today = IF(hints_day = CURDATE(), hints_today + 1, 1), hints_day = CURDATE() WHERE user_id = ? AND (hints_day IS NULL OR hints_day <> CURDATE() OR hints_today < ?)', [userId, cap]);
    return r.affectedRows > 0;
  }
};

const consents = {
  async get(db, userId, version) { const [rows] = await db.query('SELECT * FROM lc_consents WHERE user_id = ? AND version = ?', [userId, version]); return rows[0] || null; },
  async insert(db, userId, version) { await db.query('INSERT IGNORE INTO lc_consents (user_id, version) VALUES (?, ?)', [userId, version]); }
};

// ---------------- problems (shared cache) ----------------
const PROBLEM_JSON = ['topic_tags', 'similar_slugs', 'hints'];
const problems = {
  async get(db, slug) { const [rows] = await db.query('SELECT * FROM lc_problems WHERE slug = ?', [slug]); return rows.length ? rowJson(rows[0], PROBLEM_JSON) : null; },
  async getMany(db, slugs) { if (!slugs.length) return []; const [rows] = await db.query('SELECT * FROM lc_problems WHERE slug IN (?)', [slugs]); return rows.map((r) => rowJson(r, PROBLEM_JSON)); },
  // First writer wins per column: later writes only fill NULLs. Returns { created }.
  async upsertFirstWriter(db, p) {
    const [r] = await db.query(
      `INSERT INTO lc_problems (slug, title, frontend_id, question_id, difficulty, topic_tags, similar_slugs, hints, statement_excerpt, constraints_text, is_paid, first_writer_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = COALESCE(title, VALUES(title)), frontend_id = COALESCE(frontend_id, VALUES(frontend_id)), question_id = COALESCE(question_id, VALUES(question_id)),
         difficulty = COALESCE(difficulty, VALUES(difficulty)), topic_tags = COALESCE(topic_tags, VALUES(topic_tags)), similar_slugs = COALESCE(similar_slugs, VALUES(similar_slugs)),
         hints = COALESCE(hints, VALUES(hints)), statement_excerpt = COALESCE(statement_excerpt, VALUES(statement_excerpt)), constraints_text = COALESCE(constraints_text, VALUES(constraints_text)),
         is_paid = GREATEST(is_paid, VALUES(is_paid))`,
      [p.slug, p.title || p.slug, p.frontend_id || null, p.question_id || null, p.difficulty || null, J(p.topic_tags || null), J(p.similar_slugs || null), J(p.hints || null), p.statement_excerpt || null, p.constraints_text || null, p.is_paid ? 1 : 0, p.first_writer_user_id || null]
    );
    return { created: r.affectedRows === 1 };
  }
};

// ---------------- solved ----------------
const solved = {
  async listForUser(db, userId) { const [rows] = await db.query('SELECT * FROM lc_solved WHERE user_id = ? ORDER BY first_ac_ts, slug', [userId]); return rows.map((r) => rowJson(r, ['tags'])); },
  // From the sync's solved list. Keeps computed columns intact.
  async upsertMany(db, userId, rows) {
    if (!rows.length) return 0;
    const values = rows.map((r) => [userId, r.slug, r.title || null, r.difficulty || null, J(r.tags || null), r.source || 'sync', r.solved_at || null]);
    const [res] = await db.query(
      `INSERT INTO lc_solved (user_id, slug, title, difficulty, tags, source, solved_at) VALUES ?
       ON DUPLICATE KEY UPDATE title = COALESCE(VALUES(title), title), difficulty = COALESCE(VALUES(difficulty), difficulty), tags = COALESCE(VALUES(tags), tags), solved_at = COALESCE(solved_at, VALUES(solved_at))`,
      [values]
    );
    return res.affectedRows;
  },
  // From recompute: attempt-derived columns (and rows for ACs missing from the solved list).
  async upsertComputed(db, userId, rows) {
    if (!rows.length) return 0;
    const values = rows.map((r) => [userId, r.slug, r.title || null, r.difficulty || null, J(r.tags || null), r.source || 'attempt', r.first_ac_ts || null, r.first_ac_submission_id || null, r.attempts_to_ac ?? null, r.fails_before_ac ?? null]);
    const [res] = await db.query(
      `INSERT INTO lc_solved (user_id, slug, title, difficulty, tags, source, first_ac_ts, first_ac_submission_id, attempts_to_ac, fails_before_ac) VALUES ?
       ON DUPLICATE KEY UPDATE title = COALESCE(title, VALUES(title)), difficulty = COALESCE(difficulty, VALUES(difficulty)), tags = COALESCE(tags, VALUES(tags)),
         first_ac_ts = VALUES(first_ac_ts), first_ac_submission_id = VALUES(first_ac_submission_id), attempts_to_ac = VALUES(attempts_to_ac), fails_before_ac = VALUES(fails_before_ac)`,
      [values]
    );
    return res.affectedRows;
  },
  async setAssisted(db, userId, slug, assisted) { await db.query('UPDATE lc_solved SET assisted = ? WHERE user_id = ? AND slug = ?', [assisted ? 1 : 0, userId, slug]); }
};

// ---------------- submissions ----------------
const META_COLS = 'user_id, lc_submission_id, slug, status_code, status_msg, verdict_bucket, lang, ts, runtime_percentile, total_correct, total_testcases, has_details, captured_via, created_at';
const submissions = {
  // Fill-if-null upsert: re-sending is a no-op; details upgrade wa_unknown -> real bucket; nothing is downgraded. code only when present.
  async upsertMany(db, userId, rows) {
    if (!rows.length) return 0;
    const values = rows.map((r) => [userId, r.lc_submission_id, r.slug, r.status_code ?? null, r.status_msg || null, r.verdict_bucket || null, r.lang || null, r.ts, r.runtime_percentile ?? null,
      r.last_testcase ?? null, r.expected_output ?? null, r.code_output ?? null, r.error_text ?? null, r.total_correct ?? null, r.total_testcases ?? null, r.has_details ? 1 : 0,
      r.code ?? null, r.code ? sha256(r.code) : (r.code_hash || null), r.captured_via || 'sync']);
    const [res] = await db.query(
      `INSERT INTO lc_submissions (user_id, lc_submission_id, slug, status_code, status_msg, verdict_bucket, lang, ts, runtime_percentile, last_testcase, expected_output, code_output, error_text, total_correct, total_testcases, has_details, code, code_hash, captured_via) VALUES ?
       ON DUPLICATE KEY UPDATE status_code = COALESCE(status_code, VALUES(status_code)), status_msg = COALESCE(status_msg, VALUES(status_msg)), lang = COALESCE(lang, VALUES(lang)),
         runtime_percentile = COALESCE(runtime_percentile, VALUES(runtime_percentile)), last_testcase = COALESCE(last_testcase, VALUES(last_testcase)), expected_output = COALESCE(expected_output, VALUES(expected_output)),
         code_output = COALESCE(code_output, VALUES(code_output)), error_text = COALESCE(error_text, VALUES(error_text)), total_correct = COALESCE(total_correct, VALUES(total_correct)), total_testcases = COALESCE(total_testcases, VALUES(total_testcases)),
         verdict_bucket = IF(has_details = 0 AND VALUES(has_details) = 1, VALUES(verdict_bucket), COALESCE(verdict_bucket, VALUES(verdict_bucket))), has_details = GREATEST(has_details, VALUES(has_details)),
         code = COALESCE(code, VALUES(code)), code_hash = COALESCE(code_hash, VALUES(code_hash))`,
      [values]
    );
    return res.affectedRows;
  },
  async listMetaForUser(db, userId) { const [rows] = await db.query(`SELECT ${META_COLS} FROM lc_submissions WHERE user_id = ? ORDER BY ts, lc_submission_id`, [userId]); return rows; },
  async listForSlug(db, userId, slug) { const [rows] = await db.query(`SELECT ${META_COLS}, last_testcase, expected_output, code_output, error_text FROM lc_submissions WHERE user_id = ? AND slug = ? ORDER BY ts, lc_submission_id`, [userId, slug]); return rows; },
  async latestForSlug(db, userId, slug) { const [rows] = await db.query('SELECT * FROM lc_submissions WHERE user_id = ? AND slug = ? ORDER BY ts DESC, lc_submission_id DESC LIMIT 1', [userId, slug]); return rows[0] || null; },
  async codeByIds(db, userId, ids) { if (!ids.length) return new Map(); const [rows] = await db.query('SELECT lc_submission_id, code FROM lc_submissions WHERE user_id = ? AND lc_submission_id IN (?)', [userId, ids]); return new Map(rows.map((r) => [Number(r.lc_submission_id), r.code])); },
  async maxId(db, userId) { const [rows] = await db.query('SELECT MAX(lc_submission_id) AS m, COUNT(*) AS n FROM lc_submissions WHERE user_id = ?', [userId]); return { max: rows[0].m ? Number(rows[0].m) : null, count: rows[0].n }; },
  async nullAllCode(db, userId) { const [r] = await db.query('UPDATE lc_submissions SET code = NULL WHERE user_id = ?', [userId]); return r.affectedRows; }
};

// ---------------- habits ----------------
const habits = {
  async listForUser(db, userId) { const [rows] = await db.query('SELECT * FROM lc_habits WHERE user_id = ? ORDER BY habit_key', [userId]); return rows.map((r) => rowJson(r, ['counts', 'evidence'])); },
  async getById(db, userId, id) { const [rows] = await db.query('SELECT * FROM lc_habits WHERE user_id = ? AND id = ?', [userId, id]); return rows.length ? rowJson(rows[0], ['counts', 'evidence']) : null; },
  // Preserves confirmed/dismissed; otherwise live -> auto, not live -> stale.
  async upsertMany(db, userId, list) {
    if (!list.length) return 0;
    const values = list.map((h) => [userId, h.key, h.category, h.subpattern || null, h.bucket || null, h.tier, h.live ? 1 : 0, J(h.counts || null), J(h.evidence || null), h.live ? 'auto' : 'stale']);
    const [res] = await db.query(
      `INSERT INTO lc_habits (user_id, habit_key, category, subpattern, bucket, tier, live, counts, evidence, state) VALUES ?
       ON DUPLICATE KEY UPDATE tier = VALUES(tier), live = VALUES(live), counts = VALUES(counts), evidence = VALUES(evidence), last_seen_at = CURRENT_TIMESTAMP,
         state = IF(state IN ('confirmed','dismissed'), state, IF(VALUES(live) = 1, 'auto', 'stale'))`,
      [values]
    );
    return res.affectedRows;
  },
  async markStaleExcept(db, userId, keys) {
    if (!keys.length) { const [r] = await db.query("UPDATE lc_habits SET live = 0, state = 'stale' WHERE user_id = ? AND state NOT IN ('confirmed','dismissed')", [userId]); return r.affectedRows; }
    const [r] = await db.query("UPDATE lc_habits SET live = 0, state = 'stale' WHERE user_id = ? AND habit_key NOT IN (?) AND state NOT IN ('confirmed','dismissed')", [userId, keys]); return r.affectedRows;
  },
  async setReaction(db, userId, id, reaction) { const [r] = await db.query('UPDATE lc_habits SET reaction = ?, reaction_at = CURRENT_TIMESTAMP, state = ? WHERE user_id = ? AND id = ?', [reaction, reaction, userId, id]); return r.affectedRows > 0; }
};

// ---------------- chat ----------------
const sessions = {
  async getOrCreate(db, userId, slug) {
    const [rows] = await db.query('SELECT * FROM lc_chat_sessions WHERE user_id = ? AND slug = ?', [userId, slug]);
    if (rows.length) return rows[0];
    const id = uuid();
    await db.query('INSERT IGNORE INTO lc_chat_sessions (id, user_id, slug) VALUES (?, ?, ?)', [id, userId, slug]);
    const [again] = await db.query('SELECT * FROM lc_chat_sessions WHERE user_id = ? AND slug = ?', [userId, slug]);
    return again[0];
  },
  async update(db, id, fields) {
    const allowed = new Set(['plan_text', 'turn_count', 'max_rung', 'is_contest']); const sets = []; const vals = [];
    for (const [k, v] of Object.entries(fields || {})) if (allowed.has(k)) { sets.push(`${k} = ?`); vals.push(v); }
    sets.push('last_message_at = CURRENT_TIMESTAMP');
    await db.query(`UPDATE lc_chat_sessions SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
  },
  async listOpenForUser(db, userId) { const [rows] = await db.query('SELECT id, slug, turn_count, max_rung, last_message_at FROM lc_chat_sessions WHERE user_id = ?', [userId]); return rows; }
};

const MSG_JSON = ['anchors', 'habits', 'contract', 'usage_json', 'guard_json'];
const messages = {
  async insert(db, m) {
    const id = m.id || uuid();
    await db.query(
      'INSERT INTO lc_chat_messages (id, session_id, user_id, role, content, rung, anchors, habits, contract, usage_json, guard_json, provider, model, degraded) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, m.session_id, m.user_id, m.role, m.content, m.rung ?? null, J(m.anchors || null), J(m.habits || null), J(m.contract || null), J(m.usage || null), J(m.guard || null), m.provider || null, m.model || null, m.degraded ? 1 : 0]
    );
    return id;
  },
  async lastN(db, sessionId, n) { const [rows] = await db.query('SELECT role, content, rung, created_at FROM lc_chat_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [sessionId, n]); return rows.reverse(); },
  async listForSession(db, sessionId, limit = 50) { const [rows] = await db.query('SELECT id, role, content, rung, anchors, habits, degraded, feedback_thumb, feedback_reason, created_at FROM lc_chat_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [sessionId, limit]); return rows.reverse().map((r) => rowJson(r, ['anchors', 'habits'])); },
  async get(db, userId, id) { const [rows] = await db.query('SELECT * FROM lc_chat_messages WHERE user_id = ? AND id = ?', [userId, id]); return rows.length ? rowJson(rows[0], MSG_JSON) : null; },
  async setFeedback(db, userId, id, fb) { const [r] = await db.query('UPDATE lc_chat_messages SET feedback_thumb = ?, feedback_reason = ?, feedback_note = ?, feedback_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ? AND role = ?', [fb.thumb || null, fb.reason || null, fb.note || null, userId, id, 'assistant']); return r.affectedRows > 0; }
};

// ---------------- events ----------------
const events = {
  async skill(db, userId, kind, payload, modelVersion) { await db.query('INSERT INTO lc_skill_events (user_id, kind, payload, model_version) VALUES (?, ?, ?, ?)', [userId, kind, J(payload || null), modelVersion || null]); },
  async client(db, userId, type, payload, extVersion) { await db.query('INSERT INTO lc_client_events (user_id, type, payload, ext_version) VALUES (?, ?, ?, ?)', [userId, type, J(payload || null), extVersion || null]); }
};

// Deletes every Recall row for a user; the users row and the shared problem cache are untouched.
async function purgeUser(db, userId) {
  const counts = {};
  for (const t of ['lc_client_events', 'lc_chat_messages', 'lc_chat_sessions', 'lc_habits', 'lc_skill_events', 'lc_submissions', 'lc_solved', 'lc_consents', 'lc_profiles']) {
    const [r] = await db.query(`DELETE FROM ${t} WHERE user_id = ?`, [userId]);
    counts[t] = r.affectedRows;
  }
  return counts;
}

module.exports = { profiles, consents, problems, solved, submissions, habits, sessions, messages, events, purgeUser, uuid, sha256 };
