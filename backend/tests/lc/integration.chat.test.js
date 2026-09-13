'use strict';
/**
 * Integration: chatService.handleChat through the REAL contextBuilder, anchorService, modelService, policy, habits,
 * promptBuilder, guard and fallback. Only the pool (scripted SQL mock) and the LLM are fake. Synthetic rows only.
 */
const chatService = require('../../src/lc/services/chatService');
const { loadSeed } = require('../../src/lc/domain/seed');
const { validateReply } = require('../../src/lc/services/llm/schema');

const USER = 'u-pilot-0000-0000-0000-000000000001';
const NOW_S = 1_800_000_000;
const SLUG = 'coin-change';

const PROFILE = { user_id: USER, language: 'english', consent_code: 0, sync_status: 'complete', model_version: 'lc-model-v1', hints_day: null, hints_today: 0,
  skill_summary: { band: 'intermediate', solved: 120, counts: { easy: 40, medium: 70, hard: 10 }, dp: { label: 'dynamic programming', level: 'solid', solved: 30, hard: 2, sample: [] }, graph: { label: 'graphs', level: 'learning', solved: 8, hard: 0, sample: [] }, strengths: [{ tag: 'binary-search', solved: 20 }], gaps: ['graph'] } };
const SESSION = { id: 'sess-1', user_id: USER, slug: SLUG, plan_text: null, turn_count: 0, max_rung: 0, is_contest: 0 };
const PROBLEM = { slug: SLUG, title: 'Coin Change', frontend_id: '322', difficulty: 'medium', topic_tags: ['array', 'dynamic-programming', 'breadth-first-search'], hints: ['Think about the smallest sub-amounts first.'], statement_excerpt: 'You are given coins and an amount. Return the fewest coins that make up that amount, or -1.', constraints_text: '1 <= coins.length <= 12\n1 <= coins[i] <= 2^31 - 1\n0 <= amount <= 10^4' };
const SOLVED = [
  { user_id: USER, slug: 'climbing-stairs', title: 'Climbing Stairs', difficulty: 'easy', tags: ['math', 'dynamic-programming', 'memoization'], source: 'sync', solved_at: null, first_ac_ts: NOW_S - 20 * 86400, first_ac_submission_id: 501, attempts_to_ac: 1, fails_before_ac: 0, assisted: 0 },
  { user_id: USER, slug: 'unique-paths', title: 'Unique Paths', difficulty: 'medium', tags: ['math', 'dynamic-programming', 'combinatorics'], source: 'sync', solved_at: null, first_ac_ts: NOW_S - 40 * 86400, first_ac_submission_id: 502, attempts_to_ac: 2, fails_before_ac: 1, assisted: 0 }
];
const HABIT = { id: 7, user_id: USER, habit_key: 'overflow', category: 'overflow', subpattern: null, bucket: 're_overflow', tier: 'high', live: 1, counts: { n: 7, of: 15, recent_n: 5, recent_of: 11 }, evidence: { examples: ['decode-ways'] }, state: 'auto', reaction: null };

function makeDb() {
  const rules = []; const calls = [];
  async function dispatch(who, sql, params) {
    calls.push({ who, sql, params });
    for (const r of rules) if (typeof r.m === 'string' ? sql.includes(r.m) : r.m.test(sql)) return [await r.fn(sql, params), undefined];
    if (/^\s*SELECT/i.test(sql)) return [[], undefined];
    return [{ affectedRows: 1, insertId: 0 }, undefined];
  }
  const conn = { query: jest.fn((s, p) => dispatch('conn', s, p)), beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn() };
  const pool = { query: jest.fn((s, p) => dispatch('pool', s, p)), getConnection: jest.fn(async () => conn) };
  const db = { pool, conn, calls, on(m, fn) { rules.push({ m, fn: typeof fn === 'function' ? fn : () => fn }); return db; }, find(m, who) { return calls.filter((c) => (!who || c.who === who) && (typeof m === 'string' ? c.sql.includes(m) : m.test(c.sql))); }, reset() { calls.length = 0; conn.commit.mockClear(); conn.rollback.mockClear(); } };
  return db;
}

const state = { profile: PROFILE, problem: PROBLEM, latest: null, here: [] };
const db = makeDb()
  .on('FROM lc_profiles', () => (state.profile ? [state.profile] : []))
  .on('FROM lc_chat_sessions', () => [SESSION])
  .on(/FROM lc_problems WHERE slug = \?/, () => (state.problem ? [state.problem] : []))
  .on(/FROM lc_problems WHERE slug IN/, () => [])
  .on(/FROM lc_submissions WHERE user_id = \? AND slug = \? ORDER BY ts DESC/, () => (state.latest ? [state.latest] : []))
  .on(/FROM lc_submissions WHERE user_id = \? AND slug = \?/, () => state.here)
  .on('FROM lc_submissions WHERE user_id = ? ORDER BY ts', () => [])
  .on('FROM lc_solved', () => SOLVED)
  .on('FROM lc_habits', () => [HABIT])
  .on('FROM lc_chat_messages', () => [])
  .on('hints_today', () => ({ affectedRows: 1 }));

const REPLY_R1 = 'Start from the smallest amount you can build and ask what one extra coin adds to it. Which amount would you write down first?';
const parsed = (over = {}) => ({ reply: REPLY_R1, rung: 1, anchors_used: ['climbing-stairs'], habits_used: [], asks_question: true, self_check: 'state first', ...over });
function fakeLlm(...replies) {
  const generate = jest.fn(async () => { const p = replies.shift(); return { parsed: p, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, provider: 'fake', model: 'fake-1', latency_ms: 12 }; });
  return { provider: 'fake', model: 'fake-1', generate };
}
// messages.insert param order (repo.js): id, session_id, user_id, role, content, rung, anchors, habits, contract, usage_json, guard_json, provider, model, degraded
function assistantRow() {
  const p = db.find('INSERT INTO lc_chat_messages', 'conn').find((c) => c.params[3] === 'assistant').params;
  return { content: p[4], rung: p[5], anchors: JSON.parse(p[6]), habits: JSON.parse(p[7]), contract: JSON.parse(p[8]), usage: JSON.parse(p[9]), guard: JSON.parse(p[10]), provider: p[11], model: p[12], degraded: p[13] };
}
const schemaOf = (row) => ({ reply: row.content, rung: row.rung, anchors_used: row.anchors.filter((a) => a.cited).map((a) => a.slug), habits_used: row.habits.filter((h) => h.used).map((h) => h.key), asks_question: true, self_check: 'x' });

const seed = loadSeed();
const config = { maxRung: 4, dailyHintCap: 60, killLlm: false, provider: 'fake' };
const run = (llm, body, cfg = config) => chatService.handleChat(db.pool, llm, cfg, USER, { title_slug: SLUG, message: 'I have no idea where to start', requested_rung: 1, is_contest: false, ...body }, { seed, now: NOW_S });

beforeEach(() => { db.reset(); jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { jest.restoreAllMocks(); });

describe('handleChat end to end with the real prompt builder, guard and fallback', () => {
  it('accepts a guard-clean rung-1 reply and persists a schema-valid assistant row in one transaction', async () => {
    const llm = fakeLlm(parsed());
    const out = await run(llm);
    expect(out).toMatchObject({ reply: REPLY_R1, rung: 1, allowed_rung_next: 1, unlock_reason: 'state_a_plan', degraded: false, provider: 'fake' });
    expect(out.anchors).toEqual([{ slug: 'climbing-stairs', title: 'Climbing Stairs', why: expect.stringMatching(/^same idea/) }]);
    expect(out.habits_shown).toEqual([]);

    expect(llm.generate).toHaveBeenCalledTimes(1);
    const prompt = llm.generate.mock.calls[0][0];
    expect(prompt.system).toContain('RULES');
    expect(prompt.history).toEqual([]);
    expect(prompt.user).toContain('CURRENT PROBLEM');
    expect(prompt.user).toContain('OFFERED_ANCHORS: climbing-stairs (Climbing Stairs)');
    expect(prompt.user).toContain('STUDENT MESSAGE');
    expect(prompt.user).not.toMatch(/^tags:/m); // hidden at rung 1
    expect(prompt.user).not.toContain('[object Object]'); // contextBuilder.buildStudent renders strengths as strings
    expect(prompt.user).toContain('strengths: binary-search (20)');

    expect(db.conn.commit).toHaveBeenCalledTimes(1);
    expect(db.conn.rollback).not.toHaveBeenCalled();
    expect(db.find('INSERT INTO lc_chat_messages', 'conn')).toHaveLength(2);
    const row = assistantRow();
    expect(row).toMatchObject({ content: REPLY_R1, rung: 1, provider: 'fake', model: 'fake-1', degraded: 0 });
    expect(row.anchors).toEqual([{ slug: 'climbing-stairs', title: 'Climbing Stairs', why: expect.stringMatching(/^same idea/), solved_on: expect.any(String), cited: true }]);
    expect(row.contract).toMatchObject({ rung: 1, max_rung: 1, code_allowed: 'none', unlock_reason: 'state_a_plan' });
    expect(row.usage).toEqual({ input_tokens: 100, output_tokens: 20, total_tokens: 120, calls: 1, latency_ms: 12 });
    expect(row.guard).toEqual({ action: 'accept', retried: false, violations: [] });
    expect(validateReply(schemaOf(row))).toEqual({ ok: true, errors: [] });
    expect(db.find('UPDATE lc_chat_sessions', 'conn')).toHaveLength(1);
  });

  it('a fenced block at rung 1 makes the real guard retry once with REVISION REQUIRED, then accepts pass 2', async () => {
    const leaky = parsed({ reply: 'Try this:\n```cpp\nfor (int a = 1; a <= amount; a++) dp[a] = min(dp[a], dp[a - c] + 1);\n```\nWhich amount would you write down first?' });
    const llm = fakeLlm(leaky, parsed());
    const out = await run(llm, { message: 'show me' });
    expect(llm.generate).toHaveBeenCalledTimes(2);
    expect(llm.generate.mock.calls[1][0].user).toContain('REVISION REQUIRED: Your previous reply broke these rules: code_at_low_rung');
    expect(out.degraded).toBe(false);
    const row = assistantRow();
    expect(row.content).toBe(REPLY_R1);
    expect(row.guard).toMatchObject({ action: 'accept', retried: true, pass2_violations: [] });
    expect(row.guard.violations.map((v) => v.rule)).toEqual(['code_at_low_rung', 'code_at_low_rung']);
    expect(row.usage).toMatchObject({ calls: 2, total_tokens: 240, latency_ms: 24 });
    expect(validateReply(schemaOf(row))).toEqual({ ok: true, errors: [] });
  });

  it('LC_KILL_LLM persists the real templated reply: degraded, provider template, schema-valid, ends with a question', async () => {
    const llm = fakeLlm(parsed());
    const out = await run(llm, { message: 'again' }, { ...config, killLlm: true });
    expect(llm.generate).not.toHaveBeenCalled();
    expect(out).toMatchObject({ rung: 1, degraded: true, provider: 'template' });
    expect(out.reply.trim().endsWith('?')).toBe(true);
    const row = assistantRow();
    expect(row).toMatchObject({ provider: 'template', model: null, degraded: 1 });
    expect(row.guard).toEqual({ action: 'fallback', retried: false, violations: [], reason: 'kill_switch' });
    expect(row.usage).toBeNull();
    expect(validateReply(schemaOf(row))).toEqual({ ok: true, errors: [] });
  });

  it('the plan chip key no_idea leaves rung 2 locked while the label alias for a real plan unlocks it', async () => {
    const noIdea = await run(fakeLlm(parsed()), { plan: 'no_idea' });
    expect(noIdea).toMatchObject({ rung: 1, allowed_rung_next: 1, unlock_reason: 'state_a_plan' });
    const label = await run(fakeLlm(parsed()), { plan: 'Have a plan, it fails' });
    expect(label).toMatchObject({ allowed_rung_next: 2, unlock_reason: 'submit_once' });
    const upd = db.find('UPDATE lc_chat_sessions', 'conn');
    expect(upd[upd.length - 1].params).toContain('I have a plan but it fails.');
  });

  it('an unoffered solved title in the reply is rewritten to "a classic problem" by the real guard', async () => {
    const reply = parsed({ reply: 'Remember Unique Paths: you built the answer for small grids first. Which amount would you write down first?' });
    const out = await run(fakeLlm(reply));
    expect(out.reply).not.toContain('Unique Paths');
    expect(out.reply).toContain('a classic problem');
    const row = assistantRow();
    expect(row.guard.violations.map((v) => v.rule)).toContain('unoffered_title');
    expect(row.guard.action).toBe('accept');
  });
});
