'use strict';
/**
 * attemptService.recordAttempt: idempotent upsert, first-AC detection, assisted flag, consent-gated code,
 * habits_changed vs the previous habit rows. The recompute is spied so the service is tested in isolation.
 */
const attemptService = require('../../src/lc/services/attemptService');
const modelService = require('../../src/lc/services/modelService');
const { loadSeed } = require('../../src/lc/domain/seed');
const { loadConfig } = require('../../src/lc/config');
const { sha256 } = require('../../src/lc/db/repo');

const seed = loadSeed();
const config = loadConfig({});
const USER = 'u-attempt-test';
const NOW = new Date('2025-10-09T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

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

const subRow = (id, status, ts, over = {}) => ({ user_id: USER, lc_submission_id: id, slug: 'coin-change', status_code: status, status_msg: null, verdict_bucket: null, lang: 'cpp', ts, has_details: 0, captured_via: 'sync', ...over });
const profileRow = (over = {}) => ({ user_id: USER, language: 'english', consent_code: 0, sync_status: 'complete', sync_progress: null, skill_summary: null, model_version: 'lc-model-v1', ...over });

function dbWith({ consent = 0, existing = [], habits = [], sessions = [] } = {}) {
  return makeDb()
    .on('FROM lc_profiles', [profileRow({ consent_code: consent })])
    .on('FROM lc_submissions WHERE user_id = ? AND slug = ?', existing)
    .on('FROM lc_habits', habits)
    .on('FROM lc_chat_sessions', sessions);
}

const acBody = (over = {}) => ({ submission_id: 51, title_slug: 'coin-change', captured_via: 'interceptor', status_code: 10, status_msg: 'Accepted', lang: 'cpp', timestamp: NOW_S - 30, runtime_percentile: 87.5, code: 'SYNTHETIC_CODE', ...over });

let recomputeSpy;
beforeEach(() => {
  recomputeSpy = jest.spyOn(modelService, 'recomputeStudentModel').mockResolvedValue({
    skill: { solved: 1 }, habits: [{ key: 'overflow', live: true }], n_attempts: 1, n_solved: 1, model_version: 'lc-model-v1', ms: 3
  });
});
afterEach(() => jest.restoreAllMocks());

describe('recordAttempt: first AC', () => {
  it('detects the first AC, writes the solved row unassisted, drops code without consent and reports habit changes', async () => {
    const db = dbWith({ consent: 0, existing: [subRow(50, 11, NOW_S - 600)], habits: [{ id: 1, habit_key: 'overflow', live: 0, state: 'stale' }] });
    const out = await attemptService.recordAttempt(db.pool, USER, acBody(), { seed, config, now: NOW });
    expect(out).toMatchObject({ ok: true, submission_id: 51, slug: 'coin-change', bucket: 'ac', tier: null, is_first_ac: true, assisted: false, already_known: false, solved_here: true, submissions_here: 2, habits_changed: ['overflow'], recompute_ms: 3, allowed_rung_next: 4, unlock_reason: 'ask_for_rung_4', model_version: 'lc-model-v1' });

    const ins = db.find('INSERT INTO lc_submissions', 'conn');
    expect(ins).toHaveLength(1);
    expect(ins[0].sql).toContain('ON DUPLICATE KEY UPDATE');
    const row = ins[0].params[0][0];
    expect(row.slice(0, 8)).toEqual([USER, 51, 'coin-change', 10, 'Accepted', 'ac', 'cpp', NOW_S - 30]);
    expect(row[8]).toBe(87.5);
    expect(row[15]).toBe(0);
    expect(row[16]).toBeNull();
    expect(row[17]).toBeNull();
    expect(row[18]).toBe('interceptor');

    const solved = db.find('INSERT INTO lc_solved', 'conn');
    expect(solved).toHaveLength(1);
    expect(solved[0].params[0][0]).toEqual([USER, 'coin-change', 'Coin Change', 'medium', expect.any(String), 'attempt', NOW_S - 30, 51, 2, 1]);
    const assisted = db.find('UPDATE lc_solved SET assisted = ?', 'conn');
    expect(assisted).toHaveLength(1);
    expect(assisted[0].params).toEqual([0, USER, 'coin-change']);

    const ev = db.find('INSERT INTO lc_skill_events', 'conn');
    expect(ev).toHaveLength(1);
    expect(ev[0].params[1]).toBe('attempt');
    expect(JSON.parse(ev[0].params[2])).toMatchObject({ id: 51, slug: 'coin-change', status_code: 10, bucket: 'ac', captured_via: 'interceptor', is_first_ac: true, assisted: false, already_known: false, has_code: false });

    expect(recomputeSpy).toHaveBeenCalledTimes(1);
    expect(recomputeSpy).toHaveBeenCalledWith(db.pool, USER, { seed, now: NOW_S });
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
    expect(db.conn.rollback).not.toHaveBeenCalled();
    expect(db.find('INSERT IGNORE INTO lc_profiles', 'pool')).toHaveLength(1);
  });

  it('marks the first AC assisted when the chat session for that slug has turns', async () => {
    const db = dbWith({ existing: [], sessions: [{ id: 's1', slug: 'coin-change', turn_count: 2, max_rung: 2 }, { id: 's2', slug: 'two-sum', turn_count: 9 }] });
    const out = await attemptService.recordAttempt(db.pool, USER, acBody(), { seed, config, now: NOW });
    expect(out).toMatchObject({ is_first_ac: true, assisted: true, submissions_here: 1, allowed_rung_next: 3 });
    expect(db.find('UPDATE lc_solved SET assisted = ?', 'conn')[0].params).toEqual([1, USER, 'coin-change']);
    expect(JSON.parse(db.find('INSERT INTO lc_skill_events', 'conn')[0].params[2]).assisted).toBe(true);
  });

  it('is not the first AC when an earlier AC exists, and never touches lc_solved then', async () => {
    const db = dbWith({ existing: [subRow(40, 10, NOW_S - 9000), subRow(50, 11, NOW_S - 600)], sessions: [{ id: 's1', slug: 'coin-change', turn_count: 5 }] });
    const out = await attemptService.recordAttempt(db.pool, USER, acBody(), { seed, config, now: NOW });
    expect(out).toMatchObject({ is_first_ac: false, assisted: false, solved_here: true, submissions_here: 3, allowed_rung_next: 4 });
    expect(db.find('INSERT INTO lc_solved')).toHaveLength(0);
    expect(db.find('UPDATE lc_solved')).toHaveLength(0);
    expect(db.find('INSERT INTO lc_submissions', 'conn')).toHaveLength(1);
  });

  it('is idempotent: a re-sent verdict is upserted again (fill-if-null) and flagged already_known', async () => {
    const db = dbWith({ existing: [subRow(50, 11, NOW_S - 600), subRow(51, 10, NOW_S - 30)], habits: [{ id: 1, habit_key: 'overflow', live: 1, state: 'auto' }] });
    const out = await attemptService.recordAttempt(db.pool, USER, acBody(), { seed, config, now: NOW });
    expect(out).toMatchObject({ already_known: true, is_first_ac: true, submissions_here: 2, habits_changed: [] });
    expect(db.find('INSERT INTO lc_submissions', 'conn')).toHaveLength(1);
    expect(db.find('UPDATE lc_solved SET assisted = ?', 'conn')[0].params).toEqual([0, USER, 'coin-change']);
  });

  it('stores code and its hash only with consent', async () => {
    const db = dbWith({ consent: 1 });
    await attemptService.recordAttempt(db.pool, USER, acBody(), { seed, config, now: NOW });
    const row = db.find('INSERT INTO lc_submissions', 'conn')[0].params[0][0];
    expect(row[16]).toBe('SYNTHETIC_CODE');
    expect(row[17]).toBe(sha256('SYNTHETIC_CODE'));
    expect(JSON.parse(db.find('INSERT INTO lc_skill_events', 'conn')[0].params[2]).has_code).toBe(true);
  });
});

describe('recordAttempt: failures', () => {
  it('buckets a WA with judge details and never writes lc_solved', async () => {
    const db = dbWith({ habits: [{ id: 1, habit_key: 'overflow', live: 1, state: 'auto' }] });
    const body = acBody({ status_code: 11, status_msg: 'Wrong Answer', last_testcase: '[1,2,3]\n7', expected_output: '2', code_output: '3', total_correct: 12, total_testcases: 40, code: undefined });
    const out = await attemptService.recordAttempt(db.pool, USER, body, { seed, config, now: NOW });
    expect(out).toMatchObject({ bucket: 'wa_logic', tier: 'medium', is_first_ac: false, assisted: false, solved_here: false, submissions_here: 1, allowed_rung_next: 3, habits_changed: [] });
    const row = db.find('INSERT INTO lc_submissions', 'conn')[0].params[0][0];
    expect(row[3]).toBe(11);
    expect(row[5]).toBe('wa_logic');
    expect(row.slice(9, 16)).toEqual(['[1,2,3]\n7', '2', '3', null, 12, 40, 1]);
    expect(db.find('INSERT INTO lc_solved')).toHaveLength(0);
    expect(db.find('UPDATE lc_solved')).toHaveLength(0);
  });

  it('buckets a C++ overflow runtime error as re_overflow (tier high)', async () => {
    const db = dbWith();
    const body = acBody({ status_code: 15, status_msg: 'Runtime Error', error_text: 'Line 9: Char 22: runtime error: signed integer overflow: 1073741824 * 2 cannot be represented in type int', code: undefined });
    const out = await attemptService.recordAttempt(db.pool, USER, body, { seed, config, now: NOW });
    expect(out).toMatchObject({ bucket: 're_overflow', tier: 'high', is_first_ac: false });
  });

  it('derives the status code from the display text when status_code is absent', async () => {
    const db = dbWith();
    const out = await attemptService.recordAttempt(db.pool, USER, acBody({ status_code: undefined, status_msg: 'Time Limit Exceeded', code: undefined }), { seed, config, now: NOW });
    expect(out.bucket).toBe('tle');
    expect(db.find('INSERT INTO lc_submissions', 'conn')[0].params[0][0][3]).toBe(14);
  });

  it('reports habits that went stale as changed', async () => {
    recomputeSpy.mockResolvedValue({ skill: {}, habits: [{ key: 'gap:dp.lis', live: true }], n_attempts: 1, n_solved: 0, ms: 1 });
    const db = dbWith({ habits: [{ id: 1, habit_key: 'overflow', live: 1, state: 'auto' }, { id: 2, habit_key: 'gap:dp.lis', live: 1, state: 'confirmed' }] });
    const out = await attemptService.recordAttempt(db.pool, USER, acBody({ status_code: 14, status_msg: 'Time Limit Exceeded' }), { seed, config, now: NOW });
    expect(out.habits_changed).toEqual(['overflow']);
  });

  it('records manual captures with captured_via manual', async () => {
    const db = dbWith();
    await attemptService.recordAttempt(db.pool, USER, acBody({ captured_via: 'manual', status_code: 20, status_msg: 'Compile Error' }), { seed, config, now: NOW });
    const row = db.find('INSERT INTO lc_submissions', 'conn')[0].params[0][0];
    expect(row[18]).toBe('manual');
    expect(row[5]).toBe('ce');
  });
});

describe('recordAttempt: validation', () => {
  const cases = [
    ['invalid_submission_id', { submission_id: 0 }],
    ['invalid_submission_id', { submission_id: 'abc' }],
    ['invalid_slug', { title_slug: 'Coin Change' }],
    ['invalid_captured_via', { captured_via: 'sync' }],
    ['invalid_status', { status_code: undefined, status_msg: undefined }],
    ['invalid_timestamp', { timestamp: 0 }]
  ];
  it.each(cases)('rejects %s', async (code, over) => {
    const db = dbWith();
    await expect(attemptService.recordAttempt(db.pool, USER, acBody(over), { seed, config, now: NOW })).rejects.toMatchObject({ status: 400, code });
    expect(db.pool.query).not.toHaveBeenCalled();
    expect(recomputeSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-object body', async () => {
    await expect(attemptService.recordAttempt(dbWith().pool, USER, null, { seed, config, now: NOW })).rejects.toMatchObject({ status: 400, code: 'invalid_body' });
  });
});
