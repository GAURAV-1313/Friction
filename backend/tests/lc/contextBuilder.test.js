'use strict';
/**
 * contextBuilder tests: no DB, no network. repo functions are spied; anchorService is mocked.
 * Fixtures are synthetic (no real student code).
 */
jest.mock('../../src/lc/services/anchorService', () => ({ getAnchorsForSlug: jest.fn() }), { virtual: true });

const repo = require('../../src/lc/db/repo');
const anchorService = require('../../src/lc/services/anchorService');
const { familiesOf } = require('../../src/lc/domain/seed');
const { HttpError } = require('../../src/lc/middleware/errors');
const cb = require('../../src/lc/services/contextBuilder');

const NOW = 1_800_000_000; // fixed "now" (seconds)
const USER = 'user-0000-0000-0000-000000000001';
const SLUG = 'target-problem';
const pool = { query: jest.fn(async () => [[]]) };
const config = { maxRung: 4 };

const seed = {
  subLabel: new Map([['dp.interval', 'Interval DP'], ['graph.dijkstra', 'Dijkstra']]),
  subpatternsOf: (slug) => (slug === SLUG ? [{ id: 'dp.interval', primary: true, family: 'dp' }] : []),
  primarySub: () => null,
  problemFromCatalog: (slug) => (slug === 'catalog-only' ? { slug, title: 'Catalog Only', frontendId: '4242', difficulty: 'Hard', paid: false, tags: ['dynamic-programming', 'graph'] } : null),
  familiesOf
};

const profile = () => ({ user_id: USER, language: 'english', consent_code: 1, skill_summary: { band: 'intermediate', solved: 120, counts: { easy: 40, medium: 70, hard: 10 }, dp: { label: 'dynamic programming', level: 'solid', solved: 30, hard: 2, sample: ['A'] }, graph: { label: 'graphs', level: 'learning', solved: 8, hard: 0, sample: [] }, strengths: [{ tag: 'binary-search', solved: 20 }], gaps: ['graph'] } });
const problemRow = () => ({ slug: SLUG, title: 'Target Problem', frontend_id: '1234', difficulty: 'medium', topic_tags: ['dynamic-programming', 'array'], hints: ['Think about intervals'], statement_excerpt: 'Given an array...', constraints_text: '1 <= n <= 10^5\n1 <= nums[i] <= 10^9' });
const session = (over = {}) => ({ id: 'sess-1', user_id: USER, slug: SLUG, plan_text: null, turn_count: 0, max_rung: 0, ...over });
const SYNTH_CODE = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
const anchorList = () => ({ slug: SLUG, family: 'dp', subpatterns: ['dp.interval'], omitted_reason: null, anchors: [
  { slug: 'anchor-one', title: 'Recall One', difficulty: 'medium', score: 5.2, why: 'same idea: Interval DP', solved_on: '2026-05-01', attempts_to_ac: 2, first_ac_submission_id: 111 },
  { slug: 'anchor-two', title: 'Recall Two', difficulty: 'easy', score: 3.5, why: 'shares LeetCode\'s memoization tag', solved_on: '2026-03-01', attempts_to_ac: 1, first_ac_submission_id: 222 },
  { slug: 'anchor-three', title: 'Recall Three', difficulty: 'hard', score: 3.1, why: 'same idea: Interval DP', solved_on: '2025-01-01', attempts_to_ac: 4, first_ac_submission_id: 333 },
  { slug: 'anchor-four', title: 'Recall Four', difficulty: 'hard', score: 3.0, why: 'same idea: Interval DP', solved_on: '2024-01-01', attempts_to_ac: 1, first_ac_submission_id: 444 }
] });

function spies({ problem = problemRow(), here = [], latest = null, habits = [], history = [], codes = new Map() } = {}) {
  jest.spyOn(repo.problems, 'get').mockResolvedValue(problem);
  jest.spyOn(repo.sessions, 'getOrCreate').mockResolvedValue(session());
  jest.spyOn(repo.submissions, 'listForSlug').mockResolvedValue(here);
  jest.spyOn(repo.submissions, 'latestForSlug').mockResolvedValue(latest);
  jest.spyOn(repo.submissions, 'codeByIds').mockResolvedValue(codes);
  jest.spyOn(repo.habits, 'listForUser').mockResolvedValue(habits);
  jest.spyOn(repo.messages, 'lastN').mockResolvedValue(history);
  anchorService.getAnchorsForSlug.mockResolvedValue(anchorList());
}

const build = (over = {}) => cb.buildChatContext(pool, { userId: USER, slug: SLUG, body: { message: 'help me', ...(over.body || {}) }, profile: over.profile || profile(), session: over.session || session(), seed, config, now: NOW });

const failingLatest = (over = {}) => ({ user_id: USER, lc_submission_id: 900, slug: SLUG, status_code: 11, status_msg: 'Wrong Answer', verdict_bucket: 'wa_logic', lang: 'cpp', ts: NOW - 120, has_details: 1, last_testcase: 'x'.repeat(500), expected_output: 'e'.repeat(300), code_output: 'g'.repeat(300), error_text: 'r'.repeat(600), total_correct: 30, total_testcases: 43, code: 'never-shown', ...over });

beforeEach(() => { jest.restoreAllMocks(); anchorService.getAnchorsForSlug.mockReset(); });

describe('buildChatContext: shape', () => {
  it('builds the README ctx from stored rows', async () => {
    spies();
    const ctx = await build();
    expect(ctx.language).toBe('english');
    expect(ctx.consent_code).toBe(true);
    expect(ctx.problem).toEqual(expect.objectContaining({ slug: SLUG, title: 'Target Problem', frontend_id: '1234', difficulty: 'medium', family: 'dp', tags: ['dynamic-programming', 'array'], statement: 'Given an array...', leetcode_hints: ['Think about intervals'] }));
    expect(ctx.problem.constraints).toEqual(['1 <= n <= 10^5', '1 <= nums[i] <= 10^9']);
    expect(ctx.student).toEqual(expect.objectContaining({ band: 'intermediate', solved: 120, counts: { easy: 40, medium: 70, hard: 10 } }));
    expect(ctx.student.dp.level).toBe('solid');
    expect(ctx.anchors).toHaveLength(3);
    expect(ctx.anchors.map((a) => a.slug)).toEqual(['anchor-one', 'anchor-two', 'anchor-three']);
    expect(ctx.anchors[0]).toEqual(expect.objectContaining({ title: 'Recall One', why: 'same idea: Interval DP', solved_on: '2026-05-01', attempts_to_ac: 2, code_excerpt: null }));
    expect(ctx.habits).toEqual([]);
    expect(ctx.verdict).toBeNull();
    expect(ctx.plan).toBeNull();
    expect(ctx.current_code).toBeNull();
    expect(ctx.lang).toBeNull();
    expect(ctx.history).toEqual([]);
    expect(ctx.message).toBe('help me');
    expect(ctx.offered).toEqual({ anchors: ['anchor-one', 'anchor-two', 'anchor-three'], habits: [] });
    expect(ctx.session).toEqual({ id: 'sess-1', turn_count: 0, max_rung: 0 });
    expect(anchorService.getAnchorsForSlug).toHaveBeenCalledWith(pool, USER, SLUG, expect.objectContaining({ seed, config, now: NOW }));
  });

  it('uses hinglish when the profile says so and renders habit statements in it', async () => {
    spies({ habits: [{ id: 7, habit_key: 'bucket:dp.interval:wa_edge_empty', category: 'bucket', subpattern: 'dp.interval', bucket: 'wa_edge_empty', tier: 'medium', live: 1, counts: { n: 4, of: 6, share: 0.67, recent_n: 3 }, evidence: {}, state: 'auto' }] });
    const ctx = await build({ profile: { ...profile(), language: 'hinglish' } });
    expect(ctx.language).toBe('hinglish');
    expect(ctx.habits).toHaveLength(1);
    expect(ctx.habits[0]).toEqual(expect.objectContaining({ id: 7, key: 'bucket:dp.interval:wa_edge_empty', tier: 'medium' }));
    expect(ctx.habits[0].statement).toMatch(/Interval DP problems pe tumhare 6 failures mein se 4/);
    expect(ctx.offered.habits).toEqual(['bucket:dp.interval:wa_edge_empty']);
  });

  it('falls back to the catalog when the problem row is missing', async () => {
    spies({ problem: null });
    const ctx = await cb.buildChatContext(pool, { userId: USER, slug: 'catalog-only', body: { message: 'hi' }, profile: profile(), session: session({ slug: 'catalog-only' }), seed, config, now: NOW });
    expect(ctx.problem).toEqual(expect.objectContaining({ title: 'Catalog Only', frontend_id: '4242', difficulty: 'hard', family: 'dp', families: ['dp', 'graph'], statement: null, constraints: [], leetcode_hints: [] }));
  });

  it('409 problem_not_cached when neither row nor catalog knows the slug', async () => {
    spies({ problem: null });
    await expect(cb.buildChatContext(pool, { userId: USER, slug: 'unknown-slug', body: { message: 'hi' }, profile: profile(), session: session(), seed, config, now: NOW })).rejects.toMatchObject({ status: 409, code: 'problem_not_cached' });
  });

  it('409 not_synced when the profile has no skill_summary', async () => {
    spies();
    await expect(build({ profile: { ...profile(), skill_summary: null } })).rejects.toMatchObject({ status: 409, code: 'not_synced' });
    await expect(cb.buildChatContext(pool, { userId: USER, slug: SLUG, body: { message: 'hi' }, profile: null, session: session(), seed, config, now: NOW })).rejects.toBeInstanceOf(HttpError);
  });

  it('403 contest_mode when the body flags a contest', async () => {
    spies();
    await expect(build({ body: { is_contest: true } })).rejects.toMatchObject({ status: 403, code: 'contest_mode' });
  });

  it('looks the session up when the caller does not pass one', async () => {
    spies();
    const ctx = await cb.buildChatContext(pool, { userId: USER, slug: SLUG, body: { message: 'hi' }, profile: profile(), seed, config, now: NOW });
    expect(repo.sessions.getOrCreate).toHaveBeenCalledWith(pool, USER, SLUG);
    expect(ctx.session.id).toBe('sess-1');
  });
});

describe('buildChatContext: contract from decideRung', () => {
  it('fresh session, no plan: rung 1, unlock state_a_plan', async () => {
    spies();
    const ctx = await build();
    expect(ctx.contract).toEqual(expect.objectContaining({ locked: false, rung: 1, max_rung: 1, floor: 1, diagnostic_focus: null, code_allowed: 'none', must_end_with_question: true, unlock_reason: 'state_a_plan', allowed_rung_next: 1 }));
  });

  it('a stated plan unlocks rung 2; requested rung above max is clamped', async () => {
    spies();
    const ctx = await build({ body: { plan: 'dp over intervals', requested_rung: 4 } });
    expect(ctx.contract.rung).toBe(2);
    expect(ctx.contract.max_rung).toBe(2);
    expect(ctx.contract.unlock_reason).toBe('submit_once');
  });

  it('without a requested rung the rung stays at the floor even when a plan raised the max', async () => {
    spies();
    const ctx = await build({ body: { plan: 'dp over intervals' } });
    expect(ctx.contract.rung).toBe(1);
    expect(ctx.contract.max_rung).toBe(2);
    expect(ctx.contract.allowed_rung_next).toBe(2);
  });

  it('a fresh failure here floors the rung at 3 with the bucket as diagnostic focus', async () => {
    const latest = failingLatest();
    spies({ here: [latest], latest });
    const ctx = await build();
    expect(ctx.contract).toEqual(expect.objectContaining({ rung: 3, max_rung: 3, floor: 3, diagnostic_focus: 'wa_logic', unlock_reason: 'ask_for_rung_4' }));
  });

  it('an old failure does not floor the rung', async () => {
    const latest = failingLatest({ ts: NOW - 7200 });
    spies({ here: [latest], latest });
    const ctx = await build();
    expect(ctx.contract.floor).toBe(1);
    expect(ctx.contract.rung).toBe(1);
    expect(ctx.contract.max_rung).toBe(3);
    expect(ctx.verdict.age_s).toBe(7200);
  });

  it('a latest AC never counts as a failure', async () => {
    const latest = failingLatest({ status_code: 10, status_msg: 'Accepted', verdict_bucket: 'ac', ts: NOW - 10 });
    spies({ here: [latest], latest });
    const ctx = await build();
    expect(ctx.contract.floor).toBe(1);
    expect(ctx.contract.diagnostic_focus).toBeNull();
    expect(ctx.verdict.status).toBe('Accepted');
    expect(ctx.verdict.tier).toBeNull();
  });

  it('honours config.maxRung and rung-4 readiness', async () => {
    const latest = failingLatest({ ts: NOW - 7200 });
    spies({ here: [latest, { ...latest, lc_submission_id: 901 }], latest });
    const ctx = await build({ body: { requested_rung: 4 } });
    expect(ctx.contract.rung).toBe(4);
    expect(ctx.contract.code_allowed).toBe('blanked_pseudocode');
    const capped = await cb.buildChatContext(pool, { userId: USER, slug: SLUG, body: { message: 'x', requested_rung: 4 }, profile: profile(), session: session(), seed, config: { maxRung: 3 }, now: NOW });
    expect(capped.contract.rung).toBe(3);
  });

  it('turn count from the session drives the ladder', async () => {
    spies();
    const ctx = await build({ session: session({ turn_count: 5 }) });
    expect(ctx.contract.max_rung).toBe(3);
    expect(ctx.contract.allowed_rung_next).toBe(4);
    expect(ctx.session.turn_count).toBe(5);
  });
});

describe('buildChatContext: code excerpt gating', () => {
  it('rung >= 3 with consent: first 40 lines of the first-AC code per anchor', async () => {
    const latest = failingLatest();
    const codes = new Map([[111, SYNTH_CODE], [333, 'short one\nline two']]);
    spies({ here: [latest], latest, codes });
    const ctx = await build();
    expect(ctx.contract.rung).toBe(3);
    expect(repo.submissions.codeByIds).toHaveBeenCalledWith(pool, USER, [111, 222, 333]);
    expect(ctx.anchors[0].code_excerpt.split('\n')).toHaveLength(40);
    expect(ctx.anchors[0].code_excerpt.startsWith('line 1\n')).toBe(true);
    expect(ctx.anchors[0].code_excerpt.endsWith('line 40')).toBe(true);
    expect(ctx.anchors[1].code_excerpt).toBeNull();
    expect(ctx.anchors[2].code_excerpt).toBe('short one\nline two');
  });

  it('rung < 3: no code is read at all', async () => {
    spies({ codes: new Map([[111, SYNTH_CODE]]) });
    const ctx = await build({ body: { plan: 'have a plan', requested_rung: 2 } });
    expect(ctx.contract.rung).toBe(2);
    expect(repo.submissions.codeByIds).not.toHaveBeenCalled();
    expect(ctx.anchors.every((a) => a.code_excerpt === null)).toBe(true);
  });

  it('rung >= 3 without consent: no code is read', async () => {
    const latest = failingLatest();
    spies({ here: [latest], latest, codes: new Map([[111, SYNTH_CODE]]) });
    const ctx = await build({ profile: { ...profile(), consent_code: 0 } });
    expect(ctx.contract.rung).toBe(3);
    expect(ctx.consent_code).toBe(false);
    expect(repo.submissions.codeByIds).not.toHaveBeenCalled();
    expect(ctx.anchors.every((a) => a.code_excerpt === null)).toBe(true);
  });
});

describe('buildChatContext: verdict', () => {
  it('maps and truncates the latest submission', async () => {
    const latest = failingLatest();
    spies({ here: [latest], latest });
    const ctx = await build();
    expect(ctx.verdict).toEqual(expect.objectContaining({ status: 'Wrong Answer', status_code: 11, bucket: 'wa_logic', tier: 'medium', passed: '30/43', age_s: 120 }));
    expect(ctx.verdict.lastTestcase).toHaveLength(300);
    expect(ctx.verdict.expected).toHaveLength(200);
    expect(ctx.verdict.got).toHaveLength(200);
    expect(ctx.verdict.error).toHaveLength(400);
    expect(JSON.stringify(ctx.verdict)).not.toContain('never-shown');
  });

  it('derives the bucket from details when the row has none, and "?/?" when counts are missing', async () => {
    const latest = failingLatest({ verdict_bucket: null, status_code: 15, status_msg: 'Runtime Error', error_text: 'runtime error: signed integer overflow: 2147483647 + 1', total_correct: null, total_testcases: null });
    spies({ here: [latest], latest });
    const ctx = await build();
    expect(ctx.verdict.bucket).toBe('re_overflow');
    expect(ctx.verdict.tier).toBe('high');
    expect(ctx.verdict.passed).toBe('?/?');
  });

  it('labels the status from the code when status_msg is missing', () => {
    const v = cb.buildVerdict({ status_code: 14, ts: NOW - 5, has_details: 0 }, NOW);
    expect(v.status).toBe('Time Limit Exceeded');
    expect(v.bucket).toBe('tle');
    expect(v.tier).toBe('high');
    expect(v.lastTestcase).toBe('');
    expect(cb.buildVerdict(null, NOW)).toBeNull();
  });
});

describe('buildChatContext: history, plan, code, lang, message', () => {
  it('maps the last 10 messages to {role, text}', async () => {
    spies({ history: [{ role: 'user', content: 'first', rung: null, created_at: 'x' }, { role: 'assistant', content: 'reply one?', rung: 1, created_at: 'y' }] });
    const ctx = await build();
    expect(repo.messages.lastN).toHaveBeenCalledWith(pool, 'sess-1', 10);
    expect(ctx.history).toEqual([{ role: 'user', text: 'first' }, { role: 'assistant', text: 'reply one?' }]);
  });

  it('plan chips map to sentences; no_idea states no plan; free text is clamped to 500', async () => {
    expect(cb.resolvePlan('too_slow', null)).toBe(cb.PLAN_CHIPS.too_slow);
    expect(cb.resolvePlan('have_plan_fails', null)).toBe(cb.PLAN_CHIPS.have_plan_fails);
    expect(cb.resolvePlan('wrong_on_edge', null)).toBe(cb.PLAN_CHIPS.wrong_on_edge);
    expect(cb.resolvePlan('no_idea', 'old plan')).toBeNull();
    expect(cb.resolvePlan(undefined, 'old plan')).toBe('old plan');
    expect(cb.resolvePlan('   ', 'old plan')).toBeNull();
    expect(cb.resolvePlan('p'.repeat(800), null)).toHaveLength(500);
    spies();
    const chip = await build({ body: { plan: 'too_slow', requested_rung: 2 } });
    expect(chip.plan).toBe('My approach works but it is too slow.');
    expect(chip.contract.rung).toBe(2);
    const noIdea = await build({ body: { plan: 'no_idea', requested_rung: 2 }, session: session({ plan_text: 'stored plan' }) });
    expect(noIdea.plan).toBeNull();
    expect(noIdea.contract.rung).toBe(1);
    expect(noIdea.contract.max_rung).toBe(1);
    const stored = await build({ session: session({ plan_text: 'stored plan' }) });
    expect(stored.plan).toBe('stored plan');
    expect(stored.contract.max_rung).toBe(2);
  });

  it('the typed message is the plan channel: substantive text unlocks rung 2, a no-plan utterance does not', async () => {
    // The plan chips are gone from the panel; resolvePlan's third branch is what keeps rung 2 reachable.
    expect(cb.resolvePlan(undefined, null, 'I think I need a dp over ranges but I cannot define the state')).toBe('I think I need a dp over ranges but I cannot define the state');
    expect(cb.resolvePlan(undefined, null, 'I have no idea where to start')).toBeNull();
    expect(cb.resolvePlan(undefined, 'old plan', 'I think I need a dp over ranges but I cannot define the state')).toBe('old plan');
    expect(cb.resolvePlan('no_idea', null, 'I think I need a dp over ranges but I cannot define the state')).toBeNull();

    spies();
    const typed = await build({ body: { message: 'I think I need a dp over ranges but I cannot define the state', requested_rung: 2 } });
    expect(typed.plan).toBe('I think I need a dp over ranges but I cannot define the state');
    expect(typed.contract).toEqual(expect.objectContaining({ rung: 2, max_rung: 2, unlock_reason: 'submit_once' }));

    const noIdea = await build({ body: { message: 'I have no idea where to start', requested_rung: 2 } });
    expect(noIdea.plan).toBeNull();
    expect(noIdea.contract).toEqual(expect.objectContaining({ rung: 1, max_rung: 1, unlock_reason: 'state_a_plan' }));

    const tapped = await build({ body: { message: 'That run failed — what broke?', requested_rung: 2 } });
    expect(tapped.plan).toBeNull(); // the affordance slot's own sentence never buys a rung

    const stored = await build({ body: { message: 'I have no idea where to start' }, session: session({ plan_text: 'stored plan' }) });
    expect(stored.plan).toBe('stored plan'); // a stored plan is never re-locked by a thin message
  });

  it('current_code keeps at most 150 lines and lang is clamped; message is clamped to 2000', async () => {
    spies();
    const code = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
    const ctx = await build({ body: { code, lang: ' cpp ', message: 'm'.repeat(2500) } });
    expect(ctx.current_code.split('\n')).toHaveLength(150);
    expect(ctx.lang).toBe('cpp');
    expect(ctx.message).toHaveLength(2000);
    expect(cb.clampCode('')).toBeNull();
    expect(cb.clampCode(null)).toBeNull();
    expect(cb.excerptOf('   ')).toBeNull();
  });
});
