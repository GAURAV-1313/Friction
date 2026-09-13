'use strict';
/**
 * syncService: the three sync phases against a scripted mock pool (no DB, no network).
 * Fixtures are synthetic: no real student code or data.
 */
const syncService = require('../../src/lc/services/syncService');
const modelService = require('../../src/lc/services/modelService');
const { loadSeed } = require('../../src/lc/domain/seed');
const { loadConfig } = require('../../src/lc/config');
const { sha256 } = require('../../src/lc/db/repo');

const seed = loadSeed();
const config = loadConfig({ LC_CONSENT_VERSION: '1' });
const USER = 'u-sync-test';
const NOW = new Date('2025-10-09T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const CONSENT = { user_id: USER, version: '1', accepted_at: NOW };

// Scripted mysql2-shaped pool: rules are matched in insertion order (substring or RegExp) and return the
// first element of the [rows, fields] tuple. Unmatched SELECTs return [], writes return { affectedRows: 1 }.
function makeDb() {
  const rules = [];
  const calls = [];
  async function dispatch(who, sql, params) {
    calls.push({ who, sql, params });
    for (const r of rules) if (typeof r.m === 'string' ? sql.includes(r.m) : r.m.test(sql)) return [await r.fn(sql, params), undefined];
    if (sql.includes('MAX(lc_submission_id)')) return [[{ m: null, n: 0 }], undefined];   // aggregate always yields one row
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

const profileRow = (over = {}) => ({
  user_id: USER, leetcode_username: null, language: 'english', consent_code: 0, consent_at: null, sync_status: 'never', sync_progress: null,
  last_synced_at: null, skill_summary: null, model_version: null, hints_day: null, hints_today: 0, ...over
});
const runningProgress = { sync_id: 'sync-1', phase: 'solved', started: NOW.toISOString(), chunks: 0, submissions_seen: 0, solved_count: 3, ext_version: '1.0.0' };

afterEach(() => jest.restoreAllMocks());

describe('ingestSync gates', () => {
  it('rejects when the sync kill switch is on', async () => {
    const db = makeDb().on('FROM lc_consents', [CONSENT]);
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'solved' }, { seed, config: loadConfig({ LC_KILL_SYNC: '1' }), now: NOW }))
      .rejects.toMatchObject({ status: 503, code: 'sync_paused' });
  });

  it('requires a consent row for the configured version', async () => {
    const db = makeDb();
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'solved' }, { seed, config, now: NOW }))
      .rejects.toMatchObject({ status: 403, code: 'consent_required', extra: { consent_version: '1' } });
    expect(db.find('FROM lc_consents', 'pool')[0].params).toEqual([USER, '1']);
  });

  it('validates phase and sync_id', async () => {
    const db = makeDb().on('FROM lc_consents', [CONSENT]);
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'bogus' }, { seed, config, now: NOW })).rejects.toMatchObject({ status: 400, code: 'invalid_phase' });
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'has spaces', phase: 'solved' }, { seed, config, now: NOW })).rejects.toMatchObject({ status: 400, code: 'invalid_sync_id' });
    await expect(syncService.ingestSync(db.pool, USER, null, { seed, config, now: NOW })).rejects.toMatchObject({ status: 400, code: 'invalid_body' });
  });

  it('caps row counts per request', async () => {
    const db = makeDb().on('FROM lc_consents', [CONSENT]).on('FROM lc_profiles', [profileRow({ sync_progress: runningProgress })]);
    const solved = Array.from({ length: 1001 }, (_, i) => ({ slug: `p-${i}`, title: 'P' }));
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'solved', solved }, { seed, config, now: NOW })).rejects.toMatchObject({ status: 400, code: 'too_many_rows' });
    const submissions = Array.from({ length: 201 }, (_, i) => ({ id: i + 1, slug: 'two-sum', status_code: 10, timestamp: 1 }));
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'submissions', submissions }, { seed, config, now: NOW })).rejects.toMatchObject({ status: 400, code: 'too_many_rows' });
  });
});

describe('phase solved', () => {
  it('starts a sync: profile partial with progress, solved rows normalised, minimal problem rows for unknown slugs', async () => {
    const db = makeDb()
      .on('FROM lc_consents', [CONSENT])
      .on('FROM lc_profiles', [profileRow()])
      .on('MAX(lc_submission_id)', [{ m: null, n: 0 }])
      .on('FROM lc_problems WHERE slug IN', [{ slug: 'two-sum' }]);
    const body = {
      sync_id: 'sync-1', phase: 'solved', leetcode_username: 'student_x', ext_version: '1.0.0',
      solved: [
        { slug: 'coin-change', title: 'Coin Change', frontend_id: 322, difficulty: 'Medium', tags: ['array', 'Dynamic-Programming', 'array'], paid: false },
        { slug: 'two-sum', title: 'Two Sum', frontend_id: '1', difficulty: 'EASY', tags: ['array', 'hash-table'] },
        { slug: 'Not A Slug', title: 'ignored' }
      ],
      recent_ac: [{ id: 5, slug: 'coin-change', timestamp: 1750000000 }, { id: 6, slug: 'coin-change', timestamp: 1750009999 }, { id: 7, slug: 'unique-paths', timestamp: 1750000500 }],
      tag_counts: { 'dynamic-programming': 40, array: 100, bad: 'x' }
    };
    const out = await syncService.ingestSync(db.pool, USER, body, { seed, config, now: NOW });
    expect(out).toMatchObject({ ok: true, phase: 'solved', sync_id: 'sync-1', upserted: 3, dropped: 1, total_submissions_known: 0, next: 'submissions' });

    const ins = db.find('INSERT INTO lc_solved', 'conn');
    expect(ins).toHaveLength(1);
    const values = ins[0].params[0];
    expect(values.map((v) => v[1]).sort()).toEqual(['coin-change', 'two-sum', 'unique-paths']);
    const cc = values.find((v) => v[1] === 'coin-change');
    expect(cc[0]).toBe(USER);
    expect(cc[2]).toBe('Coin Change');
    expect(cc[3]).toBe('medium');
    expect(JSON.parse(cc[4])).toEqual(['array', 'dynamic-programming']);
    expect(cc[5]).toBe('sync');
    expect(cc[6]).toEqual(new Date(1750000000 * 1000));
    const ts = values.find((v) => v[1] === 'two-sum');
    expect(ts[3]).toBe('easy');
    expect(ts[6]).toBeNull();
    const up = values.find((v) => v[1] === 'unique-paths');
    expect(up[2]).toBe('Unique Paths');
    expect(up[3]).toBe('medium');
    expect(up[6]).toEqual(new Date(1750000500 * 1000));

    const upd = db.find('UPDATE lc_profiles SET', 'conn');
    expect(upd).toHaveLength(1);
    expect(upd[0].sql).toContain('sync_status = ?');
    expect(upd[0].sql).toContain('sync_progress = ?');
    expect(upd[0].sql).toContain('leetcode_username = ?');
    expect(upd[0].params[0]).toBe('partial');
    expect(JSON.parse(upd[0].params[1])).toMatchObject({ sync_id: 'sync-1', phase: 'solved', chunks: 0, submissions_seen: 0, solved_count: 3, ext_version: '1.0.0', tag_counts: { 'dynamic-programming': 40, array: 100 } });
    expect(upd[0].params[2]).toBe('student_x');
    expect(upd[0].params[3]).toBe(USER);

    const probs = db.find('INSERT INTO lc_problems', 'conn');
    expect(probs.map((c) => c.params[0]).sort()).toEqual(['coin-change', 'unique-paths']);
    const ccProb = probs.find((c) => c.params[0] === 'coin-change').params;
    expect(ccProb.slice(1, 6)).toEqual(['Coin Change', '322', null, 'medium', JSON.stringify(['array', 'dynamic-programming'])]);
    expect(ccProb[10]).toBe(0);
    expect(ccProb[11]).toBe(USER);

    expect(db.find('INSERT IGNORE INTO lc_profiles', 'conn')).toHaveLength(1);
    expect(db.conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
    expect(db.conn.rollback).not.toHaveBeenCalled();
    expect(db.conn.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back when a write fails', async () => {
    const db = makeDb().on('FROM lc_consents', [CONSENT]).on('FROM lc_profiles', [profileRow()]).on('INSERT INTO lc_solved', () => { throw new Error('boom'); });
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'solved', solved: [{ slug: 'two-sum', title: 'Two Sum' }] }, { seed, config, now: NOW })).rejects.toThrow('boom');
    expect(db.conn.rollback).toHaveBeenCalledTimes(1);
    expect(db.conn.commit).not.toHaveBeenCalled();
  });
});

describe('phase submissions', () => {
  const body = () => ({
    sync_id: 'sync-1', phase: 'submissions', ext_version: '1.0.1',
    submissions: [
      { id: 11, slug: 'coin-change', status_code: 15, status_msg: 'Runtime Error', lang: 'cpp', timestamp: 1750000100,
        details: { error_text: 'Line 12: Char 30: runtime error: signed integer overflow: 2147483647 + 1 cannot be represented in type int', last_testcase: '[1,2,5]\n11', total_correct: 3, total_testcases: 10, runtime_percentile: null },
        code: 'SYNTHETIC_CODE_A' },
      { id: 12, slug: 'coin-change', status_code: 11, status_msg: 'Wrong Answer', lang: 'cpp', timestamp: 1750000200, code: 'SYNTHETIC_CODE_B' },
      { id: '13', slug: 'coin-change', status_msg: 'Accepted', lang: 'cpp', timestamp: 1750000300, details: { runtime_percentile: 91.25 } },
      { id: 13, slug: 'coin-change', status_code: 10, timestamp: 1750000300 },
      { id: 'nope', slug: 'coin-change', status_code: 10, timestamp: 1 },
      { id: 14, slug: 'coin-change', status_code: 10 }
    ]
  });

  it('maps rows, computes buckets and drops code without consent', async () => {
    const db = makeDb()
      .on('FROM lc_consents', [CONSENT])
      .on('FROM lc_profiles', [profileRow({ consent_code: 0, sync_status: 'partial', sync_progress: runningProgress })])
      .on('MAX(lc_submission_id)', [{ m: 13, n: 3 }]);
    const out = await syncService.ingestSync(db.pool, USER, body(), { seed, config, now: NOW });
    expect(out).toMatchObject({ ok: true, phase: 'submissions', sync_id: 'sync-1', upserted: 3, dropped: 3, code_stored: false, total_submissions_known: 3, next: 'finalize' });

    const ins = db.find('INSERT INTO lc_submissions', 'conn');
    expect(ins).toHaveLength(1);
    expect(ins[0].sql).toContain('ON DUPLICATE KEY UPDATE');
    const rows = ins[0].params[0];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r[1])).toEqual([11, 12, 13]);
    expect(rows.map((r) => r[3])).toEqual([15, 11, 10]);
    expect(rows.map((r) => r[5])).toEqual(['re_overflow', 'wa_unknown', 'ac']);
    expect(rows.map((r) => r[15])).toEqual([1, 0, 1]);
    expect(rows.every((r) => r[16] === null && r[17] === null)).toBe(true);
    expect(rows.every((r) => r[18] === 'sync')).toBe(true);
    expect(rows[0][12]).toContain('signed integer overflow');
    expect(rows[0][9]).toBe('[1,2,5]\n11');
    expect(rows[0][13]).toBe(3);
    expect(rows[0][14]).toBe(10);
    expect(rows[2][8]).toBe(91.25);
    expect(rows[2][4]).toBe('Accepted');

    const upd = db.find('UPDATE lc_profiles SET', 'conn');
    expect(upd).toHaveLength(1);
    expect(upd[0].params[0]).toBe('partial');
    expect(JSON.parse(upd[0].params[1])).toMatchObject({ sync_id: 'sync-1', phase: 'submissions', chunks: 1, submissions_seen: 3, solved_count: 3, ext_version: '1.0.1' });
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('keeps code (and hashes it) when the profile has consent', async () => {
    const db = makeDb()
      .on('FROM lc_consents', [CONSENT])
      .on('FROM lc_profiles', [profileRow({ consent_code: 1, sync_status: 'partial', sync_progress: runningProgress })]);
    const out = await syncService.ingestSync(db.pool, USER, body(), { seed, config, now: NOW });
    expect(out.code_stored).toBe(true);
    const rows = db.find('INSERT INTO lc_submissions', 'conn')[0].params[0];
    expect(rows[0][16]).toBe('SYNTHETIC_CODE_A');
    expect(rows[0][17]).toBe(sha256('SYNTHETIC_CODE_A'));
    expect(rows[1][16]).toBe('SYNTHETIC_CODE_B');
    expect(rows[2][16]).toBeNull();
    expect(rows[2][17]).toBeNull();
  });

  it('is a no-op-shaped request when the chunk is empty', async () => {
    const db = makeDb().on('FROM lc_consents', [CONSENT]).on('FROM lc_profiles', [profileRow({ sync_progress: runningProgress })]);
    const out = await syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'submissions', submissions: [] }, { seed, config, now: NOW });
    expect(out.upserted).toBe(0);
    expect(db.find('INSERT INTO lc_submissions')).toHaveLength(0);
    expect(JSON.parse(db.find('UPDATE lc_profiles SET', 'conn')[0].params[1]).chunks).toBe(1);
  });

  it('409s when the sync_id does not match the running sync', async () => {
    const db = makeDb().on('FROM lc_consents', [CONSENT]).on('FROM lc_profiles', [profileRow({ sync_progress: { ...runningProgress, sync_id: 'sync-0' } })]);
    await expect(syncService.ingestSync(db.pool, USER, body(), { seed, config, now: NOW })).rejects.toMatchObject({ status: 409, code: 'sync_id_mismatch', extra: { active_sync_id: 'sync-0' } });
    expect(db.find('INSERT INTO lc_submissions')).toHaveLength(0);
    expect(db.pool.getConnection).not.toHaveBeenCalled();
  });

  it('409s when no sync has been started', async () => {
    const db = makeDb().on('FROM lc_consents', [CONSENT]);
    await expect(syncService.ingestSync(db.pool, USER, body(), { seed, config, now: NOW })).rejects.toMatchObject({ status: 409, code: 'sync_id_mismatch', extra: { active_sync_id: null } });
  });
});

describe('phase finalize', () => {
  it('recomputes the model, completes the profile and records a sync event', async () => {
    const spy = jest.spyOn(modelService, 'recomputeStudentModel').mockResolvedValue({
      skill: { band: 'intermediate', solved: 3 }, habits: [{ key: 'overflow', live: true }, { key: 'gap:dp.lis', live: false }], n_attempts: 3, n_solved: 3, model_version: 'lc-model-v1', ms: 7
    });
    const db = makeDb()
      .on('FROM lc_consents', [CONSENT])
      .on('FROM lc_profiles', [profileRow({ sync_status: 'partial', sync_progress: { ...runningProgress, phase: 'submissions', chunks: 2, submissions_seen: 40 } })])
      .on('MAX(lc_submission_id)', [{ m: 13, n: 40 }]);
    const out = await syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'finalize' }, { seed, config, now: NOW });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(db.pool, USER, { seed, now: NOW_S });
    expect(out).toMatchObject({ ok: true, phase: 'finalize', upserted: 0, total_submissions_known: 40, max_lc_submission_id: 13, next: null, recompute: { n_attempts: 3, n_solved: 3, habits: 2, habits_live: 1, ms: 7, model_version: 'lc-model-v1' } });

    const upd = db.find('UPDATE lc_profiles SET', 'conn');
    expect(upd).toHaveLength(1);
    expect(upd[0].sql).toContain('sync_status = ?, last_synced_at = ?, sync_progress = ?');
    expect(upd[0].params[0]).toBe('complete');
    expect(upd[0].params[1]).toBe(NOW);
    expect(JSON.parse(upd[0].params[2])).toMatchObject({ sync_id: 'sync-1', phase: 'complete', chunks: 2, submissions_seen: 40, finished: NOW.toISOString() });

    const ev = db.find('INSERT INTO lc_skill_events', 'conn');
    expect(ev).toHaveLength(1);
    expect(ev[0].params[0]).toBe(USER);
    expect(ev[0].params[1]).toBe('sync');
    expect(JSON.parse(ev[0].params[2])).toMatchObject({ sync_id: 'sync-1', chunks: 2, submissions_seen: 40, n_attempts: 3, n_solved: 3, live_keys: ['overflow'], recompute_ms: 7 });
    expect(ev[0].params[3]).toBe('lc-model-v1');
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('409s on a stale sync_id and never recomputes', async () => {
    const spy = jest.spyOn(modelService, 'recomputeStudentModel').mockResolvedValue({ skill: {}, habits: [], n_attempts: 0, n_solved: 0, ms: 0 });
    const db = makeDb().on('FROM lc_consents', [CONSENT]).on('FROM lc_profiles', [profileRow({ sync_progress: { ...runningProgress, sync_id: 'sync-9' } })]);
    await expect(syncService.ingestSync(db.pool, USER, { sync_id: 'sync-1', phase: 'finalize' }, { seed, config, now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('normalizers', () => {
  it('normalizeSubmissionRow derives status from the display text and buckets WA with details', () => {
    const r = syncService.normalizeSubmissionRow({ id: 1, slug: 'two-sum', status_msg: 'Wrong Answer', timestamp: 5, details: { last_testcase: '[2,7,11,15]\n9', expected_output: '[0,1]', code_output: '[1,0]' } }, false);
    expect(r).toMatchObject({ lc_submission_id: 1, status_code: 11, verdict_bucket: 'wa_logic', has_details: true, code: null, captured_via: 'sync' });
    expect(syncService.normalizeSubmissionRow({ id: 1, slug: 'two-sum', status_code: 10 }, true)).toBeNull();
    expect(syncService.normalizeSubmissionRow({ id: 1, slug: 'Two Sum', status_code: 10, timestamp: 5 }, true)).toBeNull();
    // 0 must be rejected, never clamped up to 1 (that would collide with a real submission id)
    expect(syncService.normalizeSubmissionRow({ id: 0, slug: 'two-sum', status_code: 10, timestamp: 5 }, true)).toBeNull();
    expect(syncService.normalizeSubmissionRow({ id: 1, slug: 'two-sum', status_code: 10, timestamp: 0 }, true)).toBeNull();
  });

  it('normalizeSolvedRow lowercases difficulty and falls back to the catalog', () => {
    const r = syncService.normalizeSolvedRow({ slug: 'coin-change', difficulty: 'MEDIUM' }, seed);
    expect(r).toMatchObject({ slug: 'coin-change', title: 'Coin Change', difficulty: 'medium', frontend_id: '322' });
    expect(r.tags).toContain('dynamic-programming');
    expect(syncService.normalizeSolvedRow({ slug: 'nope nope' }, seed)).toBeNull();
  });
});
