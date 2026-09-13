'use strict';
/**
 * modelService: the student model recompute (skill summary + denormalised lc_solved + habits).
 * Pure JS over the user's submission metadata (never code, except the TLE->AC similarity pairs),
 * written back in one transaction. Runs at sync finalize and after every captured attempt.
 *
 *   recomputeStudentModel(pool, userId, { seed, now })  now = unix seconds (pass it in; deterministic)
 *   loadAttempts(pool, userId, { seed, withCode })      shared with anchorService
 */
const { withTransaction } = require('../../db/transaction');
const repo = require('../db/repo');
const { buildAttempts } = require('../domain/attempts');
const { statusOf } = require('../domain/buckets');
const { skillSummary } = require('../domain/skill');
const { computeHabits } = require('../domain/habits');
const { normDiff } = require('../domain/seed');
const { MODEL_VERSION } = require('../domain/constants');

const BATCH = 500;
const QUICK_AFTER_TLE_S = 300;

function chunks(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

function unixOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === 'number') return Number.isFinite(v) ? Math.floor(v) : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// Ids of (TLE, first AC) pairs closer than 300 s: the only rows whose code the model ever reads.
function tleAcPairIds(rows) {
  const bySlug = new Map();
  for (const r of rows || []) {
    if (!r || !r.slug) continue;
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push({ id: Number(r.lc_submission_id), ts: Number(r.ts), status: statusOf(r) });
  }
  const ids = [];
  for (const list of bySlug.values()) {
    list.sort((a, b) => a.ts - b.ts || a.id - b.id);
    const i = list.findIndex((x) => x.status === 10);
    if (i > 0 && list[i - 1].status === 14 && list[i].ts - list[i - 1].ts < QUICK_AFTER_TLE_S) ids.push(list[i - 1].id, list[i].id);
  }
  return ids;
}

// Precedence per field: the sync's solved row (LeetCode live) > shared lc_problems cache > shipped catalog.
function problemsMapFor(slugs, solvedRows, seed, cached) {
  const map = new Map();
  for (const slug of slugs) {
    const c = seed.problemFromCatalog(slug);
    if (c) map.set(slug, { title: c.title, difficulty: c.difficulty, tags: asArray(c.tags) });
  }
  for (const p of cached || []) {
    const prev = map.get(p.slug) || {};
    const tags = asArray(p.topic_tags);
    map.set(p.slug, { title: p.title || prev.title || p.slug, difficulty: normDiff(p.difficulty) || prev.difficulty || null, tags: tags.length ? tags : asArray(prev.tags) });
  }
  for (const r of solvedRows || []) {
    const prev = map.get(r.slug) || {};
    const tags = asArray(r.tags);
    map.set(r.slug, { title: r.title || prev.title || r.slug, difficulty: normDiff(r.difficulty) || prev.difficulty || null, tags: tags.length ? tags : asArray(prev.tags) });
  }
  return map;
}

// A solved-list row with no AC among the stored submissions still counts as solved (anchors, skill map).
function pseudoAttempt(row, seed, problem, real) {
  const p = problem || {};
  const tags = asArray(p.tags).length ? p.tags : asArray(row.tags);
  const firstAcTs = Number(row.first_ac_ts) || unixOf(row.solved_at) || 0;
  return {
    slug: row.slug,
    title: p.title || row.title || row.slug,
    difficulty: normDiff(p.difficulty || row.difficulty),
    tags,
    families: seed.familiesOf(tags),
    subpatterns: seed.subpatternsOf(row.slug),
    primary: seed.primarySub(row.slug),
    n_submissions: real ? real.n_submissions : 0,
    first_ts: real ? real.first_ts : firstAcTs,
    first_ac_ts: firstAcTs,
    first_ac_id: row.first_ac_submission_id ? Number(row.first_ac_submission_id) : null,
    attempts_to_ac: Number(row.attempts_to_ac) || (real ? real.n_submissions + 1 : 1),
    solved: true,
    fails_before_ac: Number(row.fails_before_ac) || (real ? real.fails_before_ac : 0),
    fail_buckets: real ? real.fail_buckets : [],
    time_to_ac_s: null,
    fragile_flags: [],
    sequence: real ? real.sequence : [],
    pseudo: true
  };
}

/**
 * loadAttempts(db, userId, { seed, withCode }) ->
 *   { rows, solvedRows, problemsBySlug, attempts, bySlug, pseudo, solvedAttempts }
 * attempts: real (submission-derived) attempts, the only input to habits.
 * solvedAttempts: real solved attempts + pseudo attempts for solved-list rows, the input to skill and anchors.
 */
async function loadAttempts(db, userId, { seed, withCode = true } = {}) {
  if (!seed) throw new Error('loadAttempts: seed is required');
  const rows = await repo.submissions.listMetaForUser(db, userId);
  const solvedRows = await repo.solved.listForUser(db, userId);
  const slugs = new Set();
  for (const r of rows) if (r && r.slug) slugs.add(r.slug);
  for (const r of solvedRows) if (r && r.slug) slugs.add(r.slug);
  const missing = [...slugs].filter((s) => !seed.problemFromCatalog(s));
  let cached = [];
  for (const chunk of chunks(missing, BATCH)) cached = cached.concat(await repo.problems.getMany(db, chunk));
  const problemsBySlug = problemsMapFor([...slugs], solvedRows, seed, cached);
  let codeLookup = () => null;
  if (withCode) {
    const ids = tleAcPairIds(rows);
    if (ids.length) {
      const m = await repo.submissions.codeByIds(db, userId, ids);
      codeLookup = (id) => m.get(Number(id)) || null;
    }
  }
  const attempts = buildAttempts(rows, problemsBySlug, seed, { codeLookup });
  const bySlug = new Map(attempts.map((a) => [a.slug, a]));
  const pseudo = [];
  for (const r of solvedRows) {
    if (!r || !r.slug) continue;
    const real = bySlug.get(r.slug) || null;
    if (real && real.solved) continue;
    pseudo.push(pseudoAttempt(r, seed, problemsBySlug.get(r.slug), real));
  }
  const solvedAttempts = attempts.filter((a) => a.solved).concat(pseudo)
    .sort((a, b) => (a.first_ac_ts || 0) - (b.first_ac_ts || 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  return { rows, solvedRows, problemsBySlug, attempts, bySlug, pseudo, solvedAttempts };
}

/**
 * recomputeStudentModel(pool, userId, { seed, now }) -> { skill, habits, n_attempts, n_solved, model_version, ms }
 * One transaction: skill_summary + model_version, lc_solved computed columns, habit upserts (confirmed/dismissed
 * preserved), missing keys -> stale, one lc_skill_events row.
 */
async function recomputeStudentModel(pool, userId, { seed, now } = {}) {
  const t0 = Date.now();
  const asOf = Number.isFinite(now) ? Math.floor(now) : Math.floor(Date.now() / 1000);
  const loaded = await loadAttempts(pool, userId, { seed, withCode: true });
  const skill = skillSummary(loaded.solvedAttempts, asOf);
  const habits = computeHabits({ attempts: loaded.attempts, asOf, seed });
  const computedRows = loaded.attempts.filter((a) => a.solved).map((a) => ({
    slug: a.slug,
    title: a.title,
    difficulty: a.difficulty,
    tags: asArray(a.tags).length ? a.tags : null,
    source: 'attempt',
    first_ac_ts: a.first_ac_ts,
    first_ac_submission_id: a.first_ac_id,
    attempts_to_ac: a.attempts_to_ac,
    fails_before_ac: a.fails_before_ac
  }));
  const keys = habits.map((h) => h.key);
  const liveKeys = habits.filter((h) => h.live).map((h) => h.key);
  await withTransaction(pool, async (conn) => {
    await repo.profiles.ensure(conn, userId);
    await repo.profiles.update(conn, userId, { skill_summary: skill, model_version: MODEL_VERSION });
    for (const chunk of chunks(computedRows, BATCH)) await repo.solved.upsertComputed(conn, userId, chunk);
    await repo.habits.upsertMany(conn, userId, habits);
    await repo.habits.markStaleExcept(conn, userId, keys);
    await repo.events.skill(conn, userId, 'recompute', {
      as_of: asOf,
      n_attempts: loaded.attempts.length,
      n_solved: loaded.solvedAttempts.length,
      n_pseudo_solved: loaded.pseudo.length,
      habit_keys: keys,
      live_keys: liveKeys
    }, MODEL_VERSION);
  });
  return { skill, habits, n_attempts: loaded.attempts.length, n_solved: loaded.solvedAttempts.length, model_version: MODEL_VERSION, ms: Date.now() - t0 };
}

module.exports = { recomputeStudentModel, loadAttempts, tleAcPairIds, problemsMapFor, pseudoAttempt, unixOf, chunks };
