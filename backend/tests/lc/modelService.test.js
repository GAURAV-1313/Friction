'use strict';
/**
 * modelService.recomputeStudentModel over a synthetic history: 22 submissions across 8 problems with a planted
 * live overflow habit (7 of 15 failures overflow-shaped, 5 of them recent), one TLE->AC pair within 300 s, one
 * unsolved problem and one solved-list-only problem. No DB: a scripted mock pool. No real student data.
 */
const modelService = require('../../src/lc/services/modelService');
const { loadSeed } = require('../../src/lc/domain/seed');
const { MODEL_VERSION } = require('../../src/lc/domain/constants');

const seed = loadSeed();
const USER = 'u-model-test';
const NOW = 1760000000;                 // 2025-10-09T07:33:20Z
const OLD = 1700000000;                 // ~694 days before NOW: outside the 180-day live window
const RECENT = NOW - 30 * 86400;        // inside the window
const MSG = { 10: 'Accepted', 11: 'Wrong Answer', 14: 'Time Limit Exceeded', 15: 'Runtime Error' };

function makeDb() {
  const rules = [];
  const calls = [];
  async function dispatch(who, sql, params) {
    calls.push({ who, sql, params });
    for (const r of rules) if (typeof r.m === 'string' ? sql.includes(r.m) : r.m.test(sql)) return [await r.fn(sql, params), undefined];
    if (/^\s*SELECT/i.test(sql)) return [[], undefined];
    return [{ affectedRows: 1, insertId: 0 }, undefined];
  }
  const conn = {
    query: jest.fn((sql, params) => dispatch('conn', sql, params)),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn()
  };
  const pool = { query: jest.fn((sql, params) => dispatch('pool', sql, params)), getConnection: jest.fn().mockResolvedValue(conn) };
  const db = {
    pool, conn, calls,
    on(m, fn) { rules.push({ m, fn: typeof fn === 'function' ? fn : () => fn }); return db; },
    find(m, who) { return calls.filter((c) => (!who || c.who === who) && (typeof m === 'string' ? c.sql.includes(m) : m.test(c.sql))); }
  };
  return db;
}

// ---- synthetic history -------------------------------------------------------------------------
function buildFixture() {
  let nextId = 1000;
  const rows = [];
  const ids = {};
  function sub(slug, ts, status, bucket, key) {
    const id = ++nextId;
    if (key) ids[key] = id;
    rows.push({
      user_id: USER, lc_submission_id: id, slug, status_code: status, status_msg: MSG[status], verdict_bucket: bucket, lang: 'cpp', ts,
      runtime_percentile: null, total_correct: null, total_testcases: null, has_details: status !== 10 && !/unknown/.test(bucket) ? 1 : 0, captured_via: 'sync', created_at: null
    });
    return id;
  }
  sub('two-sum', OLD, 11, 'wa_logic'); sub('two-sum', OLD + 600, 10, 'ac');
  sub('climbing-stairs', OLD + 1000, 15, 're_overflow'); sub('climbing-stairs', OLD + 1600, 10, 'ac');
  sub('house-robber', OLD + 2000, 11, 'wa_logic'); sub('house-robber', OLD + 2600, 15, 're_overflow'); sub('house-robber', OLD + 3200, 10, 'ac');
  sub('decode-ways', RECENT, 15, 're_overflow'); sub('decode-ways', RECENT + 600, 11, 'wa_edge_empty'); sub('decode-ways', RECENT + 1200, 10, 'ac');
  sub('min-cost-climbing-stairs', RECENT + 2000, 14, 'tle', 'tle'); sub('min-cost-climbing-stairs', RECENT + 2100, 10, 'ac', 'acAfterTle');
  sub('house-robber-ii', RECENT + 3000, 15, 're_overflow'); sub('house-robber-ii', RECENT + 3600, 15, 're_overflow'); sub('house-robber-ii', RECENT + 4200, 10, 'ac');
  sub('coin-change', RECENT + 5000, 11, 'wa_modulo'); sub('coin-change', RECENT + 5600, 11, 'wa_logic'); sub('coin-change', RECENT + 6200, 14, 'tle'); sub('coin-change', RECENT + 6800, 10, 'ac', 'ccAc');
  sub('unique-paths', RECENT + 7000, 15, 're_overflow'); sub('unique-paths', RECENT + 7600, 11, 'wa_unknown'); sub('unique-paths', RECENT + 8200, 11, 'wa_logic');
  rows.sort((a, b) => a.ts - b.ts || a.lc_submission_id - b.lc_submission_id);

  const solvedRow = (slug, over = {}) => ({ user_id: USER, slug, title: null, difficulty: null, tags: null, source: 'sync', solved_at: null, first_ac_ts: null, first_ac_submission_id: null, attempts_to_ac: null, fails_before_ac: null, assisted: 0, ...over });
  const solvedRows = [
    solvedRow('two-sum'), solvedRow('climbing-stairs'), solvedRow('house-robber', { title: 'House Robber' }), solvedRow('decode-ways'),
    solvedRow('min-cost-climbing-stairs'), solvedRow('house-robber-ii'), solvedRow('coin-change'),
    // solved on LeetCode (sync list) but no submissions stored yet: must still count as solved
    solvedRow('longest-increasing-subsequence', { solved_at: new Date((NOW - 5 * 86400) * 1000) })
  ];
  const codeRows = [
    { lc_submission_id: ids.tle, code: Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n') },
    { lc_submission_id: ids.acAfterTle, code: Array.from({ length: 10 }, (_, i) => (i === 9 ? 'changed' : `line${i}`)).join('\n') }
  ];
  return { rows, solvedRows, codeRows, ids };
}

function dbFor(fx) {
  return makeDb()
    .on('SELECT lc_submission_id, code FROM lc_submissions', fx.codeRows)
    .on('FROM lc_submissions WHERE user_id = ? ORDER BY', fx.rows)
    .on('FROM lc_solved WHERE user_id = ?', fx.solvedRows)
    .on('FROM lc_profiles', [{ user_id: USER, consent_code: 1, language: 'english' }]);
}

describe('loadAttempts', () => {
  it('builds attempts from metadata, reads code only for the TLE->AC pair, and adds pseudo attempts for solved-list-only rows', async () => {
    const fx = buildFixture();
    const db = dbFor(fx);
    const loaded = await modelService.loadAttempts(db.pool, USER, { seed });
    expect(loaded.attempts).toHaveLength(8);
    expect(loaded.attempts.filter((a) => a.solved)).toHaveLength(7);
    expect(loaded.pseudo.map((a) => a.slug)).toEqual(['longest-increasing-subsequence']);
    expect(loaded.solvedAttempts).toHaveLength(8);
    const codeQ = db.find('SELECT lc_submission_id, code FROM lc_submissions', 'pool');
    expect(codeQ).toHaveLength(1);
    expect(codeQ[0].params).toEqual([USER, [fx.ids.tle, fx.ids.acAfterTle]]);
    expect(loaded.bySlug.get('min-cost-climbing-stairs').fragile_flags).toEqual(['quick_after_tle']);
    const cc = loaded.bySlug.get('coin-change');
    expect(cc).toMatchObject({ solved: true, attempts_to_ac: 4, fails_before_ac: 3, difficulty: 'medium', title: 'Coin Change', first_ac_id: fx.ids.ccAc });
    expect(cc.fail_buckets).toEqual(['wa_modulo', 'wa_logic', 'tle']);
    expect(loaded.bySlug.get('house-robber').title).toBe('House Robber');
    expect(loaded.bySlug.get('unique-paths').solved).toBe(false);
    const lis = loaded.pseudo[0];
    expect(lis).toMatchObject({ solved: true, attempts_to_ac: 1, first_ac_ts: NOW - 5 * 86400, difficulty: 'medium' });
    expect(lis.tags).toContain('longest-increasing-subsequence');
    expect(db.pool.getConnection).not.toHaveBeenCalled();
  });

  it('skips the code query when withCode is false', async () => {
    const fx = buildFixture();
    const db = dbFor(fx);
    await modelService.loadAttempts(db.pool, USER, { seed, withCode: false });
    expect(db.find('SELECT lc_submission_id, code FROM lc_submissions')).toHaveLength(0);
  });

  it('tleAcPairIds only pairs a TLE immediately before the first AC within 300 s', () => {
    const rows = [
      { lc_submission_id: 1, slug: 'a', status_code: 14, ts: 100 }, { lc_submission_id: 2, slug: 'a', status_code: 10, ts: 350 },
      { lc_submission_id: 3, slug: 'b', status_code: 14, ts: 100 }, { lc_submission_id: 4, slug: 'b', status_code: 10, ts: 500 },
      { lc_submission_id: 5, slug: 'c', status_code: 11, ts: 100 }, { lc_submission_id: 6, slug: 'c', status_code: 10, ts: 150 }
    ];
    expect(modelService.tleAcPairIds(rows)).toEqual([1, 2]);
  });
});

describe('recomputeStudentModel', () => {
  it('writes skill summary, computed solved rows, habits (overflow live), stale marking and a recompute event in one transaction', async () => {
    const fx = buildFixture();
    const db = dbFor(fx);
    const res = await modelService.recomputeStudentModel(db.pool, USER, { seed, now: NOW });

    expect(res.model_version).toBe(MODEL_VERSION);
    expect(res.n_attempts).toBe(8);
    expect(res.n_solved).toBe(8);
    expect(typeof res.ms).toBe('number');
    expect(res.skill).toMatchObject({ solved: 8, band: 'beginner', computed_at: NOW, cold_start: 'thin' });
    expect(res.skill.counts).toEqual({ easy: 3, medium: 5, hard: 0 });
    expect(res.skill.dp.solved).toBe(7);
    expect(res.skill.tag_levels['longest-increasing-subsequence'].solved).toBe(1);

    const overflow = res.habits.find((h) => h.key === 'overflow');
    expect(overflow).toBeDefined();
    expect(overflow).toMatchObject({ category: 'overflow', tier: 'high', live: true });
    expect(overflow.counts).toMatchObject({ n: 7, of: 15, recent_n: 5, recent_of: 11 });
    const bucketHabit = res.habits.find((h) => h.key === 'bucket:dp.1d_linear:re_overflow');
    expect(bucketHabit).toBeDefined();
    expect(bucketHabit).toMatchObject({ category: 'bucket', subpattern: 'dp.1d_linear', bucket: 're_overflow', tier: 'high', live: true });
    expect(bucketHabit.counts).toMatchObject({ n: 5, of: 8 });

    // every write is on the transaction connection, never on the pool
    expect(db.find(/^\s*(INSERT|UPDATE|DELETE)/, 'pool')).toHaveLength(0);
    expect(db.conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
    expect(db.conn.rollback).not.toHaveBeenCalled();
    expect(db.conn.release).toHaveBeenCalledTimes(1);

    const prof = db.find('UPDATE lc_profiles SET', 'conn');
    expect(prof).toHaveLength(1);
    expect(prof[0].sql).toContain('skill_summary = ?, model_version = ?');
    expect(JSON.parse(prof[0].params[0])).toMatchObject({ solved: 8, band: 'beginner' });
    expect(prof[0].params[1]).toBe(MODEL_VERSION);
    expect(prof[0].params[2]).toBe(USER);

    const solvedIns = db.find('INSERT INTO lc_solved', 'conn');
    expect(solvedIns).toHaveLength(1);
    expect(solvedIns[0].sql).toContain('first_ac_ts = VALUES(first_ac_ts)');
    const solvedRows = solvedIns[0].params[0];
    expect(solvedRows).toHaveLength(7);
    expect(solvedRows.map((r) => r[1])).not.toContain('unique-paths');
    expect(solvedRows.map((r) => r[1])).not.toContain('longest-increasing-subsequence');
    const cc = solvedRows.find((r) => r[1] === 'coin-change');
    expect(cc).toEqual([USER, 'coin-change', 'Coin Change', 'medium', expect.any(String), 'attempt', RECENT + 6800, fx.ids.ccAc, 4, 3]);
    expect(JSON.parse(cc[4])).toContain('complete-knapsack');

    const habitIns = db.find('INSERT INTO lc_habits', 'conn');
    expect(habitIns).toHaveLength(1);
    expect(habitIns[0].sql).toContain("state = IF(state IN ('confirmed','dismissed'), state");
    const habitRows = habitIns[0].params[0];
    expect(habitRows.map((r) => r[1]).sort()).toEqual(res.habits.map((h) => h.key).sort());
    const ov = habitRows.find((r) => r[1] === 'overflow');
    expect(ov.slice(0, 7)).toEqual([USER, 'overflow', 'overflow', null, 're_overflow', 'high', 1]);
    expect(JSON.parse(ov[7])).toMatchObject({ n: 7, of: 15 });
    expect(ov[9]).toBe('auto');

    const stale = db.find("UPDATE lc_habits SET live = 0, state = 'stale'", 'conn');
    expect(stale).toHaveLength(1);
    expect(stale[0].sql).toContain('habit_key NOT IN (?)');
    expect(stale[0].params[0]).toBe(USER);
    expect([...stale[0].params[1]].sort()).toEqual(res.habits.map((h) => h.key).sort());

    const ev = db.find('INSERT INTO lc_skill_events', 'conn');
    expect(ev).toHaveLength(1);
    expect(ev[0].params[0]).toBe(USER);
    expect(ev[0].params[1]).toBe('recompute');
    const payload = JSON.parse(ev[0].params[2]);
    expect(payload).toMatchObject({ as_of: NOW, n_attempts: 8, n_solved: 8, n_pseudo_solved: 1 });
    expect(payload.habit_keys.sort()).toEqual(res.habits.map((h) => h.key).sort());
    expect(payload.live_keys).toContain('overflow');
    expect(ev[0].params[3]).toBe(MODEL_VERSION);
  });

  it('is deterministic for a fixed asOf', async () => {
    const a = await modelService.recomputeStudentModel(dbFor(buildFixture()).pool, USER, { seed, now: NOW });
    const b = await modelService.recomputeStudentModel(dbFor(buildFixture()).pool, USER, { seed, now: NOW });
    expect(JSON.stringify(a.skill)).toBe(JSON.stringify(b.skill));
    expect(JSON.stringify(a.habits)).toBe(JSON.stringify(b.habits));
  });

  it('demotes the overflow habit to stale when asOf moves past the live window', async () => {
    const res = await modelService.recomputeStudentModel(dbFor(buildFixture()).pool, USER, { seed, now: NOW + 200 * 86400 });
    const overflow = res.habits.find((h) => h.key === 'overflow');
    expect(overflow).toBeDefined();
    expect(overflow.live).toBe(false);
  });

  it('handles a user with no rows (marks everything stale, still writes the event)', async () => {
    const db = makeDb();
    const res = await modelService.recomputeStudentModel(db.pool, USER, { seed, now: NOW });
    expect(res.skill).toMatchObject({ solved: 0, band: 'beginner', cold_start: 'none' });
    expect(res.habits).toEqual([]);
    expect(db.find('INSERT INTO lc_habits')).toHaveLength(0);
    expect(db.find('INSERT INTO lc_solved')).toHaveLength(0);
    const stale = db.find("UPDATE lc_habits SET live = 0, state = 'stale'", 'conn');
    expect(stale).toHaveLength(1);
    expect(stale[0].sql).not.toContain('habit_key NOT IN');
    expect(stale[0].params).toEqual([USER]);
    expect(db.find('INSERT INTO lc_skill_events', 'conn')).toHaveLength(1);
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('rolls back the transaction when a write fails', async () => {
    const db = dbFor(buildFixture()).on('INSERT INTO lc_habits', () => { throw new Error('habits write failed'); });
    await expect(modelService.recomputeStudentModel(db.pool, USER, { seed, now: NOW })).rejects.toThrow('habits write failed');
    expect(db.conn.rollback).toHaveBeenCalledTimes(1);
    expect(db.conn.commit).not.toHaveBeenCalled();
    expect(db.conn.release).toHaveBeenCalledTimes(1);
  });
});
