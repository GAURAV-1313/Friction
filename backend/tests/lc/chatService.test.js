'use strict';
/**
 * chatService tests: no DB, no network. Parallel modules (promptBuilder, guard, fallback, anchorService, llm)
 * are mocked; repo functions are spied; the pool is a fake with a fake transaction connection.
 * Fixtures are synthetic (no real student code).
 */
jest.mock('../../src/lc/domain/promptBuilder', () => ({ buildPrompt: jest.fn((ctx) => ({ system: 'SYS', history: ctx.history, user: `USER:${ctx.message}` })) }), { virtual: true });
jest.mock('../../src/lc/domain/guard', () => ({ guardReply: jest.fn() }), { virtual: true });
jest.mock('../../src/lc/domain/fallback', () => ({ templatedReply: jest.fn((ctx) => ({ reply: `TEMPLATE r${ctx.contract.rung}: what is your state?`, rung: ctx.contract.rung, anchors_used: [], habits_used: [], asks_question: true, self_check: 'template' })) }), { virtual: true });
jest.mock('../../src/lc/services/anchorService', () => ({ getAnchorsForSlug: jest.fn() }), { virtual: true });
jest.mock('../../src/lc/services/llm', () => {
  class LlmError extends Error { constructor(code, message) { super(message || code); this.name = 'LlmError'; this.code = code; } }
  return { createLlmClient: jest.fn(), LlmError };
}, { virtual: true });

const repo = require('../../src/lc/db/repo');
const anchorService = require('../../src/lc/services/anchorService');
const { buildPrompt } = require('../../src/lc/domain/promptBuilder');
const { guardReply } = require('../../src/lc/domain/guard');
const { templatedReply } = require('../../src/lc/domain/fallback');
const { LlmError } = require('../../src/lc/services/llm');
const { familiesOf } = require('../../src/lc/domain/seed');
const chatService = require('../../src/lc/services/chatService');

const NOW = 1_800_000_000;
const USER = 'user-0000-0000-0000-000000000001';
const SLUG = 'target-problem';
const SECRET_CODE = 'class Solution { int secretMarker42; };';

const conn = { query: jest.fn(async () => [[]]), beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn() };
const pool = { query: jest.fn(async () => [[]]), getConnection: jest.fn(async () => conn) };
const config = { maxRung: 4, dailyHintCap: 60, killLlm: false, provider: 'gemini' };

const seed = {
  subLabel: new Map([['dp.interval', 'Interval DP']]),
  subpatternsOf: (slug) => (slug === SLUG ? [{ id: 'dp.interval', primary: true, family: 'dp' }] : []),
  primarySub: () => null,
  problemFromCatalog: () => null,
  familiesOf
};

const profile = (over = {}) => ({ user_id: USER, language: 'english', consent_code: 1, skill_summary: { band: 'intermediate', solved: 120, counts: { easy: 40, medium: 70, hard: 10 }, dp: { level: 'solid', solved: 30 }, graph: { level: 'learning', solved: 8 }, strengths: [] }, ...over });
const problemRow = () => ({ slug: SLUG, title: 'Target Problem', frontend_id: '1234', difficulty: 'medium', topic_tags: ['dynamic-programming'], hints: [], statement_excerpt: 'Given...', constraints_text: '1 <= n <= 10^5' });
const session = (over = {}) => ({ id: 'sess-1', user_id: USER, slug: SLUG, plan_text: null, turn_count: 2, max_rung: 1, ...over });
const anchors = () => ({ anchors: [
  { slug: 'anchor-one', title: 'Anchor One', difficulty: 'medium', score: 5, why: 'same idea: Interval DP', solved_on: '2026-05-01', attempts_to_ac: 2, first_ac_submission_id: 111 },
  { slug: 'anchor-two', title: 'Anchor Two', difficulty: 'easy', score: 3.5, why: 'shares a tag', solved_on: '2026-03-01', attempts_to_ac: 1, first_ac_submission_id: 222 }
], omitted_reason: null });
const habitRows = () => [{ id: 7, habit_key: 'bucket:dp.interval:wa_edge_empty', category: 'bucket', subpattern: 'dp.interval', bucket: 'wa_edge_empty', tier: 'medium', live: 1, counts: { n: 4, of: 6, share: 0.67, recent_n: 3 }, evidence: {}, state: 'auto' }];

const llmReply = (over = {}) => ({ reply: 'What state does your dp carry? Try naming it.', rung: 2, anchors_used: ['anchor-one'], habits_used: ['bucket:dp.interval:wa_edge_empty'], asks_question: true, self_check: 'state', ...over });
const gen = (parsed, over = {}) => ({ parsed, usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, provider: 'gemini', model: 'gemini-2.5-flash', latency_ms: 300, ...over });
const accept = (parsed, over = {}) => ({ reply: parsed.reply, anchors_used: parsed.anchors_used, habits_used: parsed.habits_used, violations: [], action: 'accept', ...over });

function makeLlm(...results) {
  const generate = jest.fn();
  for (const r of results) { if (r instanceof Error) generate.mockRejectedValueOnce(r); else generate.mockResolvedValueOnce(r); }
  return { provider: 'gemini', model: 'gemini-2.5-flash', generate };
}

let insertedIds;
function spies({ prof = profile(), sess = session(), here = [], latest = null, habits = habitRows(), history = [], allowed = true } = {}) {
  insertedIds = 0;
  jest.spyOn(repo.profiles, 'get').mockResolvedValue(prof);
  jest.spyOn(repo.profiles, 'incrementHintsAtomic').mockResolvedValue(allowed);
  jest.spyOn(repo.sessions, 'getOrCreate').mockResolvedValue(sess);
  jest.spyOn(repo.sessions, 'update').mockResolvedValue(undefined);
  jest.spyOn(repo.problems, 'get').mockResolvedValue(problemRow());
  jest.spyOn(repo.submissions, 'listForSlug').mockResolvedValue(here);
  jest.spyOn(repo.submissions, 'latestForSlug').mockResolvedValue(latest);
  jest.spyOn(repo.submissions, 'codeByIds').mockResolvedValue(new Map([[111, 'anchor code line 1\nline 2']]));
  jest.spyOn(repo.habits, 'listForUser').mockResolvedValue(habits);
  jest.spyOn(repo.messages, 'lastN').mockResolvedValue(history);
  jest.spyOn(repo.messages, 'insert').mockImplementation(async () => `msg-${++insertedIds}`);
  jest.spyOn(repo.messages, 'listForSession').mockResolvedValue([]);
  jest.spyOn(repo.messages, 'setFeedback').mockResolvedValue(true);
  anchorService.getAnchorsForSlug.mockResolvedValue(anchors());
}

// plan raises max_rung to 2; requested_rung 2 asks for it (the policy keeps the floor otherwise).
const body = (over = {}) => ({ title_slug: SLUG, message: 'I am stuck on the transition', plan: 'dp over intervals', requested_rung: 2, code: SECRET_CODE, lang: 'cpp', ...over });
const run = (llm, b = body(), cfg = config) => chatService.handleChat(pool, llm, cfg, USER, b, { seed, now: NOW });
const rowsByRole = () => Object.fromEntries(repo.messages.insert.mock.calls.map((c) => [c[1].role, c[1]]));

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  anchorService.getAnchorsForSlug.mockReset();
  buildPrompt.mockClear();
  guardReply.mockReset();
  templatedReply.mockClear();
  conn.beginTransaction.mockClear(); conn.commit.mockClear(); conn.rollback.mockClear(); conn.release.mockClear();
});

describe('handleChat: validation and gates', () => {
  it('400 on bad bodies', async () => {
    spies();
    const llm = makeLlm();
    await expect(run(llm, null)).rejects.toMatchObject({ status: 400, code: 'bad_request', extra: { field: 'body' } });
    await expect(run(llm, body({ title_slug: 'Bad Slug!' }))).rejects.toMatchObject({ status: 400, extra: { field: 'title_slug' } });
    await expect(run(llm, body({ message: '   ' }))).rejects.toMatchObject({ status: 400, extra: { field: 'message' } });
    await expect(run(llm, body({ message: 'x'.repeat(2001) }))).rejects.toMatchObject({ status: 400, extra: { field: 'message' } });
    await expect(run(llm, body({ requested_rung: 5 }))).rejects.toMatchObject({ status: 400, extra: { field: 'requested_rung' } });
    await expect(run(llm, body({ requested_rung: 'two' }))).rejects.toMatchObject({ status: 400, extra: { field: 'requested_rung' } });
    await expect(run(llm, body({ code: 42 }))).rejects.toMatchObject({ status: 400, extra: { field: 'code' } });
    expect(llm.generate).not.toHaveBeenCalled();
    expect(repo.messages.insert).not.toHaveBeenCalled();
  });

  it('409 not_synced when there is no profile or no skill_summary', async () => {
    spies({ prof: null });
    await expect(run(makeLlm())).rejects.toMatchObject({ status: 409, code: 'not_synced' });
    spies({ prof: profile({ skill_summary: null }) });
    await expect(run(makeLlm())).rejects.toMatchObject({ status: 409, code: 'not_synced' });
    expect(repo.sessions.getOrCreate).not.toHaveBeenCalled();
  });

  it('403 contest_mode before any session is created', async () => {
    spies();
    const llm = makeLlm();
    await expect(run(llm, body({ is_contest: true }))).rejects.toMatchObject({ status: 403, code: 'contest_mode' });
    expect(repo.sessions.getOrCreate).not.toHaveBeenCalled();
    expect(repo.profiles.incrementHintsAtomic).not.toHaveBeenCalled();
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it('429 daily_cap when the atomic increment refuses, before the LLM is called', async () => {
    spies({ allowed: false });
    const llm = makeLlm(gen(llmReply()));
    await expect(run(llm, body(), { ...config, dailyHintCap: 2 })).rejects.toMatchObject({ status: 429, code: 'daily_cap', extra: { cap: 2 } });
    expect(repo.profiles.incrementHintsAtomic).toHaveBeenCalledWith(pool, USER, 2);
    expect(llm.generate).not.toHaveBeenCalled();
    expect(repo.messages.insert).not.toHaveBeenCalled();
  });
});

describe('handleChat: happy path', () => {
  it('accepts a guarded LLM reply and persists both rows in one transaction', async () => {
    spies();
    const parsed = llmReply();
    guardReply.mockReturnValueOnce(accept(parsed));
    const llm = makeLlm(gen(parsed));
    const out = await run(llm);

    expect(out).toEqual({
      message_id: 'msg-2',
      reply: parsed.reply,
      rung: 2,
      anchors: [{ slug: 'anchor-one', title: 'Anchor One', why: 'same idea: Interval DP' }, { slug: 'anchor-two', title: 'Anchor Two', why: 'shares a tag' }],
      habits_shown: [{ id: 7, key: 'bucket:dp.interval:wa_edge_empty', statement: expect.stringMatching(/^On Interval DP problems, 4 of your 6 failures/) }],
      allowed_rung_next: 2,
      unlock_reason: 'submit_once',
      degraded: false,
      provider: 'gemini'
    });
    expect(llm.generate).toHaveBeenCalledTimes(1);
    expect(llm.generate).toHaveBeenCalledWith({ system: 'SYS', history: [], user: 'USER:I am stuck on the transition' });
    expect(guardReply).toHaveBeenCalledWith(parsed, expect.objectContaining({ message: 'I am stuck on the transition', current_code: SECRET_CODE }), { pass: 1 });
    expect(buildPrompt.mock.calls[0][0].current_code).toBe(SECRET_CODE);

    // Transaction: both inserts and the session update on the connection, then commit.
    expect(pool.getConnection).toHaveBeenCalled();
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(repo.messages.insert).toHaveBeenCalledTimes(2);
    expect(repo.messages.insert.mock.calls[0][0]).toBe(conn);
    expect(repo.sessions.update).toHaveBeenCalledWith(conn, 'sess-1', { turn_count: 3, max_rung: 2, plan_text: 'dp over intervals' });

    const rows = rowsByRole();
    expect(rows.user).toEqual(expect.objectContaining({ session_id: 'sess-1', user_id: USER, role: 'user', content: 'I am stuck on the transition' }));
    expect(rows.user.contract).toEqual(expect.objectContaining({ rung: 2 }));
    expect(rows.assistant).toEqual(expect.objectContaining({ role: 'assistant', content: parsed.reply, rung: 2, provider: 'gemini', model: 'gemini-2.5-flash', degraded: false }));
    expect(rows.assistant.anchors).toEqual([
      { slug: 'anchor-one', title: 'Anchor One', why: 'same idea: Interval DP', solved_on: '2026-05-01', cited: true },
      { slug: 'anchor-two', title: 'Anchor Two', why: 'shares a tag', solved_on: '2026-03-01', cited: false }
    ]);
    expect(rows.assistant.habits).toEqual([expect.objectContaining({ id: 7, key: 'bucket:dp.interval:wa_edge_empty', tier: 'medium', used: true })]);
    expect(rows.assistant.contract).toEqual(expect.objectContaining({ rung: 2, max_rung: 2, unlock_reason: 'submit_once' }));
    expect(rows.assistant.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, total_tokens: 120, calls: 1 });
    expect(typeof rows.assistant.usage.latency_ms).toBe('number');
    expect(rows.assistant.guard).toEqual({ action: 'accept', retried: false, violations: [] });

    // body.code is never persisted or logged.
    const persisted = JSON.stringify(repo.messages.insert.mock.calls.map((c) => c[1]));
    expect(persisted).not.toContain('secretMarker42');
    expect(persisted).not.toContain('anchor code line 1');
    const logged = console.log.mock.calls.concat(console.error.mock.calls).map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('secretMarker42');
    expect(logged).not.toContain(parsed.reply);
  });

  it('does not touch plan_text when the body has no plan; rung never exceeds the session max', async () => {
    spies({ sess: session({ plan_text: 'stored plan', max_rung: 3 }) });
    const parsed = llmReply();
    guardReply.mockReturnValueOnce(accept(parsed));
    await run(makeLlm(gen(parsed)), body({ plan: undefined }));
    expect(repo.sessions.update).toHaveBeenCalledWith(conn, 'sess-1', { turn_count: 3, max_rung: 3 });
  });

  it('a plan chip is stored as its sentence and no_idea clears it', async () => {
    spies({ sess: session({ plan_text: 'stored plan' }) });
    guardReply.mockReturnValue(accept(llmReply()));
    await run(makeLlm(gen(llmReply()), gen(llmReply())), body({ plan: 'no_idea' }));
    expect(repo.sessions.update).toHaveBeenLastCalledWith(conn, 'sess-1', expect.objectContaining({ plan_text: null }));
    await run(makeLlm(gen(llmReply())), body({ plan: 'wrong_on_edge' }));
    expect(repo.sessions.update).toHaveBeenLastCalledWith(conn, 'sess-1', expect.objectContaining({ plan_text: 'My approach is wrong on an edge case.' }));
  });

  it('filters anchors_used/habits_used to the offered lists', async () => {
    spies();
    const parsed = llmReply({ anchors_used: ['anchor-two', 'not-offered'], habits_used: ['ghost'] });
    guardReply.mockReturnValueOnce(accept(parsed));
    await run(makeLlm(gen(parsed)));
    const rows = rowsByRole();
    expect(rows.assistant.anchors.map((a) => a.cited)).toEqual([false, true]);
    expect(rows.assistant.habits[0].used).toBe(false);
  });

  it('accepts a guard that returns the reply as an object', async () => {
    spies();
    const parsed = llmReply();
    guardReply.mockReturnValueOnce({ reply: { ...parsed, reply: 'Rewritten by guard?' }, anchors_used: [], habits_used: [], violations: ['unoffered_anchor'], action: 'accept' });
    const out = await run(makeLlm(gen(parsed)));
    expect(out.reply).toBe('Rewritten by guard?');
    expect(rowsByRole().assistant.guard).toEqual({ action: 'accept', retried: false, violations: ['unoffered_anchor'] });
  });
});

describe('handleChat: plan inference, persistence and the lc.chat log line', () => {
  const TYPED = 'I think I need a dp over ranges but I cannot define the state';
  const chatLog = () => JSON.parse(console.log.mock.calls.map((c) => c[0]).filter((s) => typeof s === 'string' && s.includes('"lc.chat"')).pop());
  const send = (b) => { guardReply.mockReturnValue(accept(llmReply())); return run(makeLlm(gen(llmReply())), b); };

  it('persists an inferred plan once, when there is no chip and no stored plan', async () => {
    spies({ sess: session({ plan_text: null }) });
    await send(body({ plan: undefined, message: TYPED }));
    expect(repo.sessions.update).toHaveBeenCalledWith(conn, 'sess-1', { turn_count: 3, max_rung: 2, plan_text: TYPED });
    expect(chatLog()).toMatchObject({ evt: 'lc.chat', rung: 2, plan_source: 'inferred', rung4_path: null });
  });

  it('a no-plan utterance infers nothing and writes no plan_text', async () => {
    spies({ sess: session({ plan_text: null }) });
    await send(body({ plan: undefined, message: 'I have no idea where to start', requested_rung: 1 }));
    expect(repo.sessions.update).toHaveBeenCalledWith(conn, 'sess-1', { turn_count: 3, max_rung: 1 });
    expect(chatLog()).toMatchObject({ rung: 1, plan_source: null });
  });

  it('inference never overwrites a stored session plan', async () => {
    spies({ sess: session({ plan_text: 'stored plan' }) });
    await send(body({ plan: undefined, message: TYPED }));
    expect(repo.sessions.update).toHaveBeenCalledWith(conn, 'sess-1', { turn_count: 3, max_rung: 2 });
    expect(chatLog()).toMatchObject({ plan_source: 'session' });
  });

  it('an explicit plan still wins and is logged as the chip path', async () => {
    spies({ sess: session({ plan_text: null }) });
    await send(body({ plan: 'wrong_on_edge', message: TYPED }));
    expect(repo.sessions.update).toHaveBeenCalledWith(conn, 'sess-1', expect.objectContaining({ plan_text: 'My approach is wrong on an edge case.' }));
    expect(chatLog()).toMatchObject({ plan_source: 'chip' });
  });

  it('requested_rung 4 is logged as the gate path whether or not it is granted', async () => {
    spies({ sess: session({ plan_text: null }) });
    await send(body({ plan: undefined, message: TYPED, requested_rung: 4 }));
    expect(chatLog()).toMatchObject({ rung: 2, rung4_path: 'gate_form' }); // requested, clamped by decideRung
    spies({ sess: session({ plan_text: null, turn_count: 6 }), here: [{ status_code: 10 }, { status_code: 11 }] });
    await send(body({ plan: undefined, message: TYPED, requested_rung: 4 }));
    expect(chatLog()).toMatchObject({ rung: 4, rung4_path: 'gate_form', plan_source: 'inferred' });
  });

  it('the log line still carries no student text', async () => {
    spies({ sess: session({ plan_text: null }) });
    await send(body({ plan: undefined, message: TYPED }));
    const logged = console.log.mock.calls.concat(console.error.mock.calls).map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain(TYPED);
    expect(logged).not.toContain('secretMarker42');
  });
});

describe('handleChat: guard retry and fallback', () => {
  it('retry: calls llm.generate exactly twice with the revision appended, then accepts pass 2', async () => {
    spies();
    const first = llmReply({ reply: 'Use dp[i][j] = min(...) over all k' });
    const second = llmReply({ reply: 'Which interval endpoints define your state?' });
    guardReply.mockReturnValueOnce({ reply: first.reply, anchors_used: [], habits_used: [], violations: ['code_at_rung_2'], action: 'retry', retry_instructions: 'Remove the code and end with one question.' });
    guardReply.mockReturnValueOnce(accept(second));
    const llm = makeLlm(gen(first), gen(second, { latency_ms: 200 }));
    const out = await run(llm);

    expect(llm.generate).toHaveBeenCalledTimes(2);
    expect(llm.generate.mock.calls[0][0]).toEqual({ system: 'SYS', history: [], user: 'USER:I am stuck on the transition' });
    expect(llm.generate.mock.calls[1][0]).toEqual({ system: 'SYS', history: [], user: 'USER:I am stuck on the transition\n\nREVISION REQUIRED: Remove the code and end with one question.' });
    expect(guardReply).toHaveBeenCalledTimes(2);
    expect(guardReply.mock.calls[0][2]).toEqual({ pass: 1 });
    expect(guardReply.mock.calls[1][2]).toEqual({ pass: 2 });
    expect(out.reply).toBe(second.reply);
    expect(out.degraded).toBe(false);
    const row = rowsByRole().assistant;
    expect(row.guard).toEqual({ action: 'accept', retried: true, violations: ['code_at_rung_2'], pass2_violations: [] });
    expect(row.usage).toMatchObject({ input_tokens: 200, output_tokens: 40, total_tokens: 240, calls: 2 });
    expect(templatedReply).not.toHaveBeenCalled();
  });

  it('retry then still-retry at pass 2: accept-and-flag, never a third call', async () => {
    spies();
    const parsed = llmReply();
    guardReply.mockReturnValueOnce({ reply: parsed.reply, anchors_used: [], habits_used: [], violations: ['v1'], action: 'retry', retry_instructions: 'fix v1' });
    guardReply.mockReturnValueOnce({ reply: 'Still a bit off but usable?', anchors_used: [], habits_used: [], violations: ['v2'], action: 'retry', retry_instructions: 'fix v2' });
    const llm = makeLlm(gen(parsed), gen(parsed));
    const out = await run(llm);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    expect(out.reply).toBe('Still a bit off but usable?');
    expect(out.degraded).toBe(false);
    expect(rowsByRole().assistant.guard).toEqual(expect.objectContaining({ action: 'accept_flagged', retried: true, violations: ['v1', 'v2'] }));
  });

  it('guard fallback: templated reply, degraded, provider template', async () => {
    spies();
    const parsed = llmReply();
    guardReply.mockReturnValueOnce({ reply: parsed.reply, anchors_used: [], habits_used: [], violations: ['leaked_solution'], action: 'fallback' });
    const llm = makeLlm(gen(parsed));
    const out = await run(llm);
    expect(out.reply).toBe('TEMPLATE r2: what is your state?');
    expect(out.degraded).toBe(true);
    expect(out.provider).toBe('template');
    expect(templatedReply).toHaveBeenCalledTimes(1);
    const row = rowsByRole().assistant;
    expect(row).toEqual(expect.objectContaining({ provider: 'template', model: null, degraded: true, content: 'TEMPLATE r2: what is your state?' }));
    expect(row.guard).toEqual({ action: 'fallback', retried: false, violations: ['leaked_solution'], reason: 'guard' });
    expect(row.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, total_tokens: 120, calls: 1 });
  });

  it('guard fallback after a retry: templated, retried flagged', async () => {
    spies();
    const parsed = llmReply();
    guardReply.mockReturnValueOnce({ reply: parsed.reply, anchors_used: [], habits_used: [], violations: ['v1'], action: 'retry', retry_instructions: 'fix' });
    guardReply.mockReturnValueOnce({ reply: parsed.reply, anchors_used: [], habits_used: [], violations: ['v2'], action: 'fallback' });
    const llm = makeLlm(gen(parsed), gen(parsed));
    const out = await run(llm);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    expect(out.degraded).toBe(true);
    expect(rowsByRole().assistant.guard).toEqual({ action: 'fallback', retried: true, violations: ['v1', 'v2'], reason: 'guard' });
  });

  it('LlmError on the first call: templated reply, degraded, reason carries the code', async () => {
    spies();
    const llm = makeLlm(new LlmError('timeout', 'gemini timed out'));
    const out = await run(llm);
    expect(out.degraded).toBe(true);
    expect(out.provider).toBe('template');
    expect(out.reply).toBe('TEMPLATE r2: what is your state?');
    expect(guardReply).not.toHaveBeenCalled();
    expect(rowsByRole().assistant.guard).toEqual({ action: 'fallback', retried: false, violations: [], reason: 'llm_timeout' });
    expect(repo.messages.insert).toHaveBeenCalledTimes(2);
  });

  it('LlmError refusal is a template too; LlmError on the retry call as well', async () => {
    spies();
    const refused = await run(makeLlm(new LlmError('refusal')));
    expect(refused.degraded).toBe(true);
    expect(rowsByRole().assistant.guard.reason).toBe('llm_refusal');

    spies();
    const parsed = llmReply();
    guardReply.mockReturnValueOnce({ reply: parsed.reply, anchors_used: [], habits_used: [], violations: ['v1'], action: 'retry', retry_instructions: 'fix' });
    const llm = makeLlm(gen(parsed), new LlmError('http', '503'));
    const out = await run(llm);
    expect(llm.generate).toHaveBeenCalledTimes(2);
    expect(out.degraded).toBe(true);
    expect(rowsByRole().assistant.guard).toEqual({ action: 'fallback', retried: true, violations: ['v1'], reason: 'llm_http' });
  });

  it('an unexpected error from the provider still degrades instead of failing the request', async () => {
    spies();
    const out = await run(makeLlm(new TypeError('boom')));
    expect(out.degraded).toBe(true);
    expect(rowsByRole().assistant.guard.reason).toBe('llm_unexpected');
  });

  it('a persistence failure rolls back and propagates', async () => {
    spies();
    guardReply.mockReturnValueOnce(accept(llmReply()));
    repo.sessions.update.mockRejectedValueOnce(new Error('db down'));
    await expect(run(makeLlm(gen(llmReply())))).rejects.toThrow('db down');
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
  });
});

describe('handleChat: kill switch and missing client', () => {
  it('LC_KILL_LLM: templated reply, degraded, no LLM call, still counted against the cap', async () => {
    spies();
    const llm = makeLlm(gen(llmReply()));
    const out = await run(llm, body(), { ...config, killLlm: true });
    expect(out).toEqual(expect.objectContaining({ reply: 'TEMPLATE r2: what is your state?', rung: 2, degraded: true, provider: 'template' }));
    expect(llm.generate).not.toHaveBeenCalled();
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(repo.profiles.incrementHintsAtomic).toHaveBeenCalledTimes(1);
    const row = rowsByRole().assistant;
    expect(row.guard).toEqual({ action: 'fallback', retried: false, violations: [], reason: 'kill_switch' });
    expect(row.usage).toBeNull();
    expect(templatedReply).toHaveBeenCalledWith(expect.objectContaining({ contract: expect.objectContaining({ rung: 2 }) }));
  });

  it('no llm client: templated reply with reason no_llm', async () => {
    spies();
    const out = await run(null);
    expect(out.degraded).toBe(true);
    expect(rowsByRole().assistant.guard.reason).toBe('no_llm');
  });
});

describe('getChatHistory', () => {
  it('returns session null and no messages when there is no session', async () => {
    spies();
    pool.query.mockResolvedValueOnce([[]]);
    expect(await chatService.getChatHistory(pool, USER, SLUG)).toEqual({ session: null, messages: [] });
    expect(repo.messages.listForSession).not.toHaveBeenCalled();
    expect(repo.sessions.getOrCreate).not.toHaveBeenCalled();
  });

  it('returns the session summary and the last 50 messages', async () => {
    spies();
    pool.query.mockResolvedValueOnce([[{ id: 'sess-1', slug: SLUG, plan_text: 'p', turn_count: 4, max_rung: 3 }]]);
    repo.messages.listForSession.mockResolvedValueOnce([{ id: 'm1', role: 'assistant', content: 'hi?' }]);
    const out = await chatService.getChatHistory(pool, USER, SLUG);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('FROM lc_chat_sessions'), [USER, SLUG]);
    expect(out).toEqual({ session: { id: 'sess-1', turn_count: 4, plan_text: 'p', max_rung: 3 }, messages: [{ id: 'm1', role: 'assistant', content: 'hi?' }] });
    expect(repo.messages.listForSession).toHaveBeenCalledWith(pool, 'sess-1', 50);
  });

  it('400 on a bad slug', async () => {
    await expect(chatService.getChatHistory(pool, USER, 'Nope!')).rejects.toMatchObject({ status: 400 });
  });
});

describe('setMessageFeedback', () => {
  it('validates and forwards to the repo', async () => {
    spies();
    expect(await chatService.setMessageFeedback(pool, USER, 'msg-9', { thumb: 'down', reason: 'too_much', note: 'gave it away' })).toEqual({ ok: true });
    expect(repo.messages.setFeedback).toHaveBeenCalledWith(pool, USER, 'msg-9', { thumb: 'down', reason: 'too_much', note: 'gave it away' });
    expect(await chatService.setMessageFeedback(pool, USER, 'msg-9', { thumb: 'up' })).toEqual({ ok: true });
    expect(repo.messages.setFeedback).toHaveBeenLastCalledWith(pool, USER, 'msg-9', { thumb: 'up', reason: null, note: null });
  });

  it('rejects bad thumbs, reasons, notes and ids', async () => {
    spies();
    await expect(chatService.setMessageFeedback(pool, USER, 'msg-9', { thumb: 'sideways' })).rejects.toMatchObject({ status: 400, extra: { field: 'thumb' } });
    await expect(chatService.setMessageFeedback(pool, USER, 'msg-9', { thumb: 'up', reason: 'meh' })).rejects.toMatchObject({ status: 400, extra: { field: 'reason' } });
    await expect(chatService.setMessageFeedback(pool, USER, 'msg-9', { thumb: 'up', note: 'n'.repeat(501) })).rejects.toMatchObject({ status: 400, extra: { field: 'note' } });
    await expect(chatService.setMessageFeedback(pool, USER, '', { thumb: 'up' })).rejects.toMatchObject({ status: 400, extra: { field: 'id' } });
    expect(repo.messages.setFeedback).not.toHaveBeenCalled();
  });

  it('404 when the message is not the user\'s assistant message', async () => {
    spies();
    repo.messages.setFeedback.mockResolvedValueOnce(false);
    await expect(chatService.setMessageFeedback(pool, USER, 'msg-x', { thumb: 'up' })).rejects.toMatchObject({ status: 404, code: 'message_not_found' });
  });
});
