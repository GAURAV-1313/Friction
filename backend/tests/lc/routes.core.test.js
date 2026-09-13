'use strict';
/**
 * Core routes through the real express app (createLcApp) on an ephemeral port with global fetch.
 * Auth: a JWT signed with backend/src/utils/jwt.js. DB: a scripted mock pool. No network, no MySQL.
 */
process.env.JWT_SECRET = 'lc-routes-test-secret';
process.env.JWT_ISSUER = 'friction-test';
process.env.JWT_AUDIENCE = 'friction-ext';

const { signAccessToken } = require('../../src/utils/jwt');
const { createLcApp } = require('../../src/lc/app');
const { loadConfig } = require('../../src/lc/config');
const { loadSeed } = require('../../src/lc/domain/seed');

const PILOT = 'u-pilot-0000-0000-0000-000000000001';
const OTHER = 'u-other-0000-0000-0000-000000000002';
const NOW_S = Math.floor(Date.now() / 1000);

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
    find(m, who) { return calls.filter((c) => (!who || c.who === who) && (typeof m === 'string' ? c.sql.includes(m) : m.test(c.sql))); },
    reset() { calls.length = 0; conn.commit.mockClear(); conn.rollback.mockClear(); }
  };
  return db;
}

const state = { consent: true, profile: null };
const PROFILE = {
  user_id: PILOT, leetcode_username: 'pilot_student', language: 'english', consent_code: 0, consent_at: null, sync_status: 'complete',
  sync_progress: { sync_id: 'sync-1', phase: 'complete', chunks: 7, submissions_seen: 1282, solved_count: 458, tag_counts: { array: 1 } },
  last_synced_at: new Date('2025-10-01T00:00:00Z'), skill_summary: { band: 'intermediate', solved: 458 }, model_version: 'lc-model-v1',
  hints_day: new Date().toISOString().slice(0, 10), hints_today: 3
};
const HABIT = { id: 7, user_id: PILOT, habit_key: 'overflow', category: 'overflow', subpattern: null, bucket: 're_overflow', tier: 'high', live: 1,
  counts: { n: 7, of: 15, recent_n: 5, recent_of: 11 }, evidence: { examples: ['decode-ways'] }, state: 'auto', reaction: null, last_seen_at: new Date() };
const SOLVED = [
  { user_id: PILOT, slug: 'climbing-stairs', title: 'Climbing Stairs', difficulty: 'easy', tags: ['math', 'dynamic-programming', 'memoization'], source: 'sync', solved_at: null, first_ac_ts: NOW_S - 20 * 86400, first_ac_submission_id: 501, attempts_to_ac: 1, fails_before_ac: 0, assisted: 0 },
  { user_id: PILOT, slug: 'unique-paths', title: 'Unique Paths', difficulty: 'medium', tags: ['math', 'dynamic-programming', 'combinatorics'], source: 'sync', solved_at: null, first_ac_ts: NOW_S - 40 * 86400, first_ac_submission_id: 502, attempts_to_ac: 2, fails_before_ac: 1, assisted: 0 }
];

// Rules match in order: DELETE first so the purge never hits a "FROM lc_<table>" SELECT rule.
const db = makeDb()
  .on('DELETE FROM', () => ({ affectedRows: 2 }))
  .on('FROM lc_profiles', () => (state.profile ? [state.profile] : []))
  .on('FROM lc_consents', () => (state.consent ? [{ user_id: PILOT, version: '1', accepted_at: new Date() }] : []))
  .on('FROM lc_solved', () => SOLVED)
  .on('MAX(lc_submission_id)', () => [{ m: 900, n: 12 }])
  .on(/FROM lc_habits WHERE user_id = \? AND id = \?/, (sql, params) => (Number(params[1]) === 7 ? [HABIT] : []))
  .on('FROM lc_habits', () => [HABIT]);

const config = loadConfig({ LC_PILOT_USER_IDS: `${PILOT}, someone-else`, LC_CONSENT_VERSION: '1', LC_DAILY_HINT_CAP: '60', LC_MIN_EXTENSION_VERSION: '1.0.0' });
let server;
let base;
let TOKEN;
let OTHER_TOKEN;
let logSpy;
let warnSpy;

beforeAll(async () => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  TOKEN = signAccessToken({ user_id: PILOT, email: 'pilot@example.test', name: 'Pilot Student' });
  OTHER_TOKEN = signAccessToken({ user_id: OTHER, email: 'other@example.test', name: 'Other' });
  const app = createLcApp({ pool: db.pool, llm: null, config, seed: loadSeed() });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  logSpy.mockRestore();
  warnSpy.mockRestore();
});
beforeEach(() => { state.consent = true; state.profile = PROFILE; db.reset(); });

function api(path, { method = 'GET', token = TOKEN, body, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  return fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}

describe('auth and allowlist', () => {
  it('401 without a token', async () => {
    const r = await api('/api/lc/me', { token: null });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'missing_token' });
  });

  it('401 with a garbage token', async () => {
    const r = await api('/api/lc/me', { token: 'not.a.jwt' });
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'invalid_token' });
  });

  it('403 pilot_closed for a valid token outside the allowlist', async () => {
    const r = await api('/api/lc/me', { token: OTHER_TOKEN });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'pilot_closed' });
    expect(db.calls).toHaveLength(0);
  });

  it('404 not_found for unknown paths, JSON shaped', async () => {
    const r = await api('/api/lc/nope');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
  });
});

describe('GET /api/lc/me', () => {
  it('returns the documented shape', async () => {
    const r = await api('/api/lc/me');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.user).toEqual({ user_id: PILOT, email: 'pilot@example.test', name: 'Pilot Student' });
    expect(body.profile).toMatchObject({ language: 'english', consent_code: false, leetcode_username: 'pilot_student', sync_status: 'complete', consent_version_accepted: '1', last_synced_at: '2025-10-01T00:00:00.000Z' });
    expect(body.profile.sync_progress).toMatchObject({ sync_id: 'sync-1', phase: 'complete', chunks: 7, submissions_seen: 1282 });
    expect(body.profile.sync_progress.tag_counts).toBeUndefined();
    expect(body.counts).toEqual({ solved: 2, submissions: 12, max_lc_submission_id: 900 });
    expect(body.skill_summary).toEqual({ band: 'intermediate', solved: 458 });
    expect(body.habits).toHaveLength(1);
    expect(body.habits[0]).toMatchObject({ id: 7, key: 'overflow', tier: 'high', live: true, state: 'auto' });
    expect(body.habits[0].statement).toBe('7 of your 15 failed submissions were integer overflow or missing-modulo errors, 5 of them in the last 6 months.');
    expect(body.hints).toEqual({ today: 3, cap: 60, resets_at: '00:00 UTC' });
    expect(body.model_version).toBe('lc-model-v1');
    expect(body.min_extension_version).toBe('1.0.0');
  });

  it('degrades gracefully when the user has no profile yet', async () => {
    state.profile = null;
    const r = await api('/api/lc/me');
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.profile).toMatchObject({ language: 'english', sync_status: 'never', consent_code: false, exists: false });
    expect(body.hints.today).toBe(0);
    expect(body.skill_summary).toBeNull();
    expect(db.find('INSERT')).toHaveLength(0);
  });
});

describe('profile and consent', () => {
  it('GET /profile', async () => {
    const r = await api('/api/lc/profile');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ language: 'english', leetcode_username: 'pilot_student', consent_version_required: '1' });
  });

  it('PUT /profile updates language in a transaction', async () => {
    const r = await api('/api/lc/profile', { method: 'PUT', body: { language: 'hinglish' } });
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
    const upd = db.find('UPDATE lc_profiles SET', 'conn');
    expect(upd).toHaveLength(1);
    expect(upd[0].sql).toContain('language = ?');
    expect(upd[0].params).toEqual(['hinglish', PILOT]);
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('PUT /profile consent true->false nulls stored code; true sets consent_at', async () => {
    state.profile = { ...PROFILE, consent_code: 1 };
    let r = await api('/api/lc/profile', { method: 'PUT', body: { consent_code: false } });
    expect(r.status).toBe(200);
    expect(db.find('UPDATE lc_submissions SET code = NULL', 'conn')).toHaveLength(1);
    db.reset();
    state.profile = PROFILE;
    r = await api('/api/lc/profile', { method: 'PUT', body: { consent_code: true, leetcode_username: 'new_name' } });
    expect(r.status).toBe(200);
    expect(db.find('UPDATE lc_submissions SET code = NULL')).toHaveLength(0);
    const upd = db.find('UPDATE lc_profiles SET', 'conn')[0];
    expect(upd.sql).toContain('consent_code = ?');
    expect(upd.sql).toContain('consent_at = ?');
    expect(upd.params[0]).toBe(1);
    expect(upd.params[1]).toBe('new_name');
    expect(upd.params[2]).toBeInstanceOf(Date);
  });

  it('PUT /profile validates', async () => {
    expect((await api('/api/lc/profile', { method: 'PUT', body: { language: 'french' } })).status).toBe(400);
    expect(await (await api('/api/lc/profile', { method: 'PUT', body: { consent_code: 'yes' } })).json()).toEqual({ error: 'invalid_consent_code' });
    expect(await (await api('/api/lc/profile', { method: 'PUT', body: {} })).json()).toEqual({ error: 'no_fields' });
    expect(await (await api('/api/lc/profile', { method: 'PUT', body: { leetcode_username: 'has space' } })).json()).toEqual({ error: 'invalid_leetcode_username' });
  });

  it('POST /consent records the acceptance', async () => {
    const r = await api('/api/lc/consent', { method: 'POST', body: { version: '1' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, version: '1', required_version: '1', satisfied: true });
    const ins = db.find('INSERT IGNORE INTO lc_consents', 'pool');
    expect(ins).toHaveLength(1);
    expect(ins[0].params).toEqual([PILOT, '1']);
    expect((await api('/api/lc/consent', { method: 'POST', body: { version: 'a version with spaces' } })).status).toBe(400);
  });

  it('DELETE /me purges every lc_ table in a transaction and reports counts', async () => {
    const r = await api('/api/lc/me', { method: 'DELETE' });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.deleted).toBe(true);
    expect(Object.keys(body.counts).sort()).toEqual(['lc_chat_messages', 'lc_chat_sessions', 'lc_client_events', 'lc_consents', 'lc_habits', 'lc_profiles', 'lc_skill_events', 'lc_solved', 'lc_submissions']);
    expect(body.counts.lc_profiles).toBe(2);
    expect(db.find('DELETE FROM', 'conn')).toHaveLength(9);
    expect(db.find('DELETE FROM', 'conn').every((c) => c.params[0] === PILOT)).toBe(true);
    expect(db.conn.commit).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/lc/sync', () => {
  it('413 payload_too_large for a body over 2 MB', async () => {
    const body = JSON.stringify({ sync_id: 'sync-1', phase: 'submissions', submissions: [], pad: 'x'.repeat(2200 * 1024) });
    const r = await api('/api/lc/sync', { method: 'POST', body });
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: 'payload_too_large' });
    expect(db.calls).toHaveLength(0);
  });

  it('400 bad_json for malformed JSON', async () => {
    const r = await api('/api/lc/sync', { method: 'POST', body: '{"sync_id": ' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'bad_json' });
  });

  it('403 consent_required without a consent row', async () => {
    state.consent = false;
    const r = await api('/api/lc/sync', { method: 'POST', body: { sync_id: 'sync-1', phase: 'solved', solved: [] } });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'consent_required', consent_version: '1' });
  });

  it('runs the solved phase end to end', async () => {
    const r = await api('/api/lc/sync', { method: 'POST', body: { sync_id: 'sync-2', phase: 'solved', leetcode_username: 'pilot_student', solved: [{ slug: 'coin-change', title: 'Coin Change', difficulty: 'Medium', tags: ['array'] }] } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, phase: 'solved', upserted: 1, next: 'submissions', total_submissions_known: 12 });
    expect(db.find('INSERT INTO lc_solved', 'conn')).toHaveLength(1);
    expect(db.find('INSERT INTO lc_problems', 'conn')).toHaveLength(1);
  });

  it('409 sync_id_mismatch for a submissions chunk from another sync', async () => {
    const r = await api('/api/lc/sync', { method: 'POST', body: { sync_id: 'sync-9', phase: 'submissions', submissions: [] } });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'sync_id_mismatch', active_sync_id: 'sync-1' });
  });
});

describe('problems and anchors', () => {
  it('PUT /problems/:slug strips HTML and clamps before the first-writer upsert', async () => {
    const r = await api('/api/lc/problems/coin-change', { method: 'PUT', body: {
      title: '<b>Coin</b> Change', frontend_id: 322, difficulty: 'Medium', topic_tags: [{ slug: 'array' }, 'Dynamic-Programming'], similar_slugs: ['climbing-stairs', 'Bad Slug'],
      hints: ['<p>Think about <i>subproblems</i></p>'], statement_excerpt: '<p>x</p>'.repeat(2000), constraints_text: '<li>1 &lt;= n &lt;= 10^4</li>'.repeat(200), is_paid: false
    } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, slug: 'coin-change', created: true, has_excerpt: true });
    const ins = db.find('INSERT INTO lc_problems', 'pool');
    expect(ins).toHaveLength(1);
    const p = ins[0].params;
    expect(p[0]).toBe('coin-change');
    expect(p[1]).toBe('Coin Change');
    expect(p[2]).toBe('322');
    expect(p[4]).toBe('medium');
    expect(JSON.parse(p[5])).toEqual(['array', 'dynamic-programming']);
    expect(JSON.parse(p[6])).toEqual(['climbing-stairs']);
    expect(JSON.parse(p[7])).toEqual(['Think about subproblems']);
    expect(p[8].length).toBeLessThanOrEqual(1500);
    expect(p[8]).not.toContain('<');
    expect(p[9].length).toBeLessThanOrEqual(1000);
    expect(p[9]).toContain('1 <= n <= 10^4');
    expect(p[9].split('\n').length).toBeGreaterThan(1); // one constraint per line survives stripping
    expect(p[11]).toBe(PILOT);
  });

  it('PUT /problems/:slug accepts the exact lc-client.problemMeta() shape (camelCase statement/constraints)', async () => {
    const meta = {
      slug: 'coin-change', questionId: '322', questionFrontendId: '322', title: 'Coin Change', difficulty: 'Medium', isPaidOnly: false, acRate: 45.1,
      topicTags: ['array', 'dynamic-programming', 'breadth-first-search'], similarQuestions: ['minimum-cost-for-tickets'], hints: ['Think about the smallest sub-amounts first.'],
      statementExcerpt: 'You are given an integer array coins and an integer amount.',
      constraintsText: '1 <= coins.length <= 12\n1 <= coins[i] <= 2^31 - 1\n0 <= amount <= 10^4'
    };
    const r = await api('/api/lc/problems/coin-change', { method: 'PUT', body: meta });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, slug: 'coin-change', has_excerpt: true, has_constraints: true, tags: ['array', 'dynamic-programming', 'breadth-first-search'] });
    const p = db.find('INSERT INTO lc_problems', 'pool')[0].params;
    expect(p[2]).toBe('322');
    expect(p[8]).toBe('You are given an integer array coins and an integer amount.');
    expect(p[9]).toBe('1 <= coins.length <= 12\n1 <= coins[i] <= 2^31 - 1\n0 <= amount <= 10^4');
  });

  it('426 update_required only when X-Anchor-Version is below the minimum', async () => {
    const low = await api('/api/lc/me', { headers: { 'x-anchor-version': '0.9.9' } });
    expect(low.status).toBe(426);
    expect(await low.json()).toEqual({ error: 'update_required', min_extension_version: '1.0.0' });
    expect((await api('/api/lc/me', { headers: { 'x-anchor-version': '1.0.0' } })).status).toBe(200);
    expect((await api('/api/lc/me', { headers: { 'x-anchor-version': '1.2' } })).status).toBe(200);
    expect((await api('/api/lc/me', { headers: { 'x-anchor-version': 'garbage' } })).status).toBe(200);
    expect((await api('/api/lc/me')).status).toBe(200);
  });

  it('PUT /problems/:slug rejects a bad slug and a missing title for an unknown problem', async () => {
    expect(await (await api('/api/lc/problems/Bad_Slug', { method: 'PUT', body: { title: 'x' } })).json()).toEqual({ error: 'invalid_slug' });
    expect(await (await api('/api/lc/problems/never-heard-of-it-zz', { method: 'PUT', body: {} })).json()).toEqual({ error: 'title_required' });
  });

  it('GET /anchors/:slug returns scored anchors from the solved list with rung gating', async () => {
    const r = await api('/api/lc/anchors/coin-change');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ slug: 'coin-change', title: 'Coin Change', difficulty: 'medium', family: 'dp', omitted_reason: null, allowed_rung: 1, unlock_reason: 'state_a_plan', submissions_here: 0, solved_here: false, model_version: 'lc-model-v1' });
    expect(body.subpatterns.map((s) => s.id)).toContain('dp.knapsack_unbounded');
    expect(body.anchors).toHaveLength(1);
    expect(body.anchors[0]).toMatchObject({ slug: 'climbing-stairs', title: 'Climbing Stairs', difficulty: 'easy', subpattern: 'dp.knapsack_unbounded', attempts_to_ac: 1, has_code: false });
    expect(body.anchors[0].score).toBeGreaterThanOrEqual(3);
    expect(body.anchors[0].why).toMatch(/same idea/);
    expect(db.find('SELECT lc_submission_id, code')).toHaveLength(0);
  });

  it('GET /anchors/:slug looks up stored code only with consent', async () => {
    state.profile = { ...PROFILE, consent_code: 1 };
    db.on('SELECT lc_submission_id, code FROM lc_submissions', () => [{ lc_submission_id: 501, code: 'SYNTHETIC' }]);
    const r = await api('/api/lc/anchors/coin-change');
    const body = await r.json();
    expect(body.anchors[0].has_code).toBe(true);
    expect(db.find('SELECT lc_submission_id, code')[0].params).toEqual([PILOT, [501]]);
  });

  it('GET /anchors/:slug 404s for an unknown problem and 400s for a bad slug', async () => {
    expect(await (await api('/api/lc/anchors/definitely-not-a-problem-zz')).json()).toEqual({ error: 'problem_unknown' });
    expect((await api('/api/lc/anchors/definitely-not-a-problem-zz')).status).toBe(404);
    expect(await (await api('/api/lc/anchors/Bad_Slug')).json()).toEqual({ error: 'invalid_slug' });
  });
});

describe('attempts, habits, client events', () => {
  it('POST /attempts records a verdict and recomputes', async () => {
    const r = await api('/api/lc/attempts', { method: 'POST', body: { submission_id: 77, title_slug: 'coin-change', captured_via: 'interceptor', status_code: 11, status_msg: 'Wrong Answer', lang: 'cpp', timestamp: NOW_S - 10 } });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, bucket: 'wa_unknown', tier: null, is_first_ac: false, assisted: false, allowed_rung_next: 3 });
    expect(typeof body.recompute_ms).toBe('number');
    expect(body.habits_changed).toEqual(['overflow']);
    expect(db.find('INSERT INTO lc_submissions', 'conn')).toHaveLength(1);
    expect(db.find('INSERT INTO lc_skill_events', 'conn').map((c) => c.params[1])).toEqual(['attempt', 'recompute']);
  });

  it('POST /attempts validates', async () => {
    const r = await api('/api/lc/attempts', { method: 'POST', body: { submission_id: 77, title_slug: 'coin-change', captured_via: 'sync', status_code: 11, timestamp: 5 } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid_captured_via' });
  });

  it('POST /habits/:id/feedback sets the reaction and logs an event', async () => {
    const r = await api('/api/lc/habits/7/feedback', { method: 'POST', body: { reaction: 'confirmed' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, id: 7, key: 'overflow', reaction: 'confirmed', state: 'confirmed' });
    const upd = db.find('UPDATE lc_habits SET reaction = ?', 'pool');
    expect(upd).toHaveLength(1);
    expect(upd[0].params).toEqual(['confirmed', 'confirmed', PILOT, 7]);
    const ev = db.find('INSERT INTO lc_skill_events', 'pool');
    expect(ev).toHaveLength(1);
    expect(ev[0].params[1]).toBe('habit_feedback');
    expect(JSON.parse(ev[0].params[2])).toMatchObject({ habit_id: 7, key: 'overflow', reaction: 'confirmed' });
  });

  it('POST /habits/:id/feedback 404s and validates', async () => {
    expect((await api('/api/lc/habits/8/feedback', { method: 'POST', body: { reaction: 'dismissed' } })).status).toBe(404);
    expect(await (await api('/api/lc/habits/7/feedback', { method: 'POST', body: { reaction: 'meh' } })).json()).toEqual({ error: 'invalid_reaction' });
    expect(await (await api('/api/lc/habits/abc/feedback', { method: 'POST', body: { reaction: 'confirmed' } })).json()).toEqual({ error: 'invalid_habit_id' });
  });

  it('POST /client-events stores and returns 202', async () => {
    const r = await api('/api/lc/client-events', { method: 'POST', body: { type: 'panel_open', ext_version: '1.0.0', payload: { slug: 'coin-change' } } });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ accepted: true });
    const ins = db.find('INSERT INTO lc_client_events', 'pool');
    expect(ins).toHaveLength(1);
    expect(ins[0].params).toEqual([PILOT, 'panel_open', JSON.stringify({ slug: 'coin-change' }), '1.0.0']);
  });

  it('POST /client-events validates type and payload size', async () => {
    expect(await (await api('/api/lc/client-events', { method: 'POST', body: { payload: {} } })).json()).toEqual({ error: 'invalid_type' });
    expect(await (await api('/api/lc/client-events', { method: 'POST', body: { type: 'x', payload: [1] } })).json()).toEqual({ error: 'invalid_payload' });
    const big = await api('/api/lc/client-events', { method: 'POST', body: { type: 'x', payload: { blob: 'y'.repeat(5000) } } });
    expect(big.status).toBe(400);
    expect(await big.json()).toEqual({ error: 'payload_too_large', max_bytes: 4096 });
  });
});
