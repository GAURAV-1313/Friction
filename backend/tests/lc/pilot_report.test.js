'use strict';
/**
 * pilot_report.render() over canned rows: no DB, no network. Fixture rows are synthetic; code-like strings are
 * markers that must never reach the output.
 */
const { render, parseArgs, queries, stats, helpers, LC_USER_TABLES } = require('../../src/lc/scripts/pilot_report');

const NOW = '2026-09-02T12:00:00Z';
const T = (h, m = 0, d = 2) => Date.UTC(2026, 8, d, h, m) / 1000; // unix seconds on 2026-09-<d>

function fixture() {
  const msg = (id, over) => ({
    id, session_id: 's-coin', slug: 'coin-change', rung: null, anchors: null, habits: null, contract: null, usage_json: null, guard_json: null,
    provider: 'gemini', model: 'gemini-2.5-flash', degraded: 0, feedback_thumb: null, feedback_reason: null, feedback_note: null, feedback_at: null,
    created_at: '2026-09-01T09:00:00Z', ...over
  });
  const m1 = msg('m1', {
    rung: 1, created_at: '2026-09-01T09:00:00Z',
    anchors: [{ slug: 'climbing-stairs', title: 'Climbing Stairs', why: 'same idea', used: true }, { slug: 'house-robber', title: 'House Robber', why: 'same family', used: false }],
    habits: [{ id: 1, key: 'overflow', statement: 'synthetic statement' }],
    usage_json: { input_tokens: 3000, output_tokens: 200, total_tokens: 3200, latency_ms: 1200 }, guard_json: { violations: [], action: 'accept' },
    feedback_thumb: 'up', feedback_reason: 'helped'
  });
  // JSON columns may also arrive as strings (mysql2 without JSON parsing); the report must cope.
  const m2 = msg('m2', {
    rung: 2, created_at: '2026-09-01T10:00:00Z',
    anchors: JSON.stringify([{ slug: 'climbing-stairs', title: 'Climbing Stairs', why: 'same idea', used: false }]),
    usage_json: JSON.stringify({ input_tokens: 3100, output_tokens: 250, total_tokens: 3350, latency_ms: 2400 }),
    guard_json: JSON.stringify({ violations: ['rung2_transition_leak'], action: 'retry' }),
    feedback_thumb: 'down', feedback_reason: 'too_much', feedback_note: 'gave away the transition'
  });
  const m3 = msg('m3', {
    session_id: 's-ladder', slug: 'word-ladder', rung: null, contract: { rung: 2, max_rung: 2 }, provider: 'anthropic', model: 'claude-opus-5', created_at: '2026-09-02T08:00:00Z',
    habits: [{ id: 1, key: 'overflow' }, { id: 2, key: 'bucket:graph.bfs:wa_logic' }],
    usage_json: { input_tokens: 4000, output_tokens: 300, total_tokens: 4300, latency_ms: 5000 }, guard_json: { violations: [], action: 'accept' },
    content: 'Before touching the queue: which state did your BFS mark visited, the word or the (word, depth) pair?'
  });
  const m4 = msg('m4', {
    rung: 3, created_at: '2026-09-02T09:00:00Z',
    anchors: [{ slug: 'climbing-stairs', used: true }, { slug: 'min-cost-climbing-stairs', title: 'Min Cost Climbing Stairs', used: true }],
    habits: [{ id: 1 }],
    usage_json: { input_tokens: 3500, output_tokens: 400, total_tokens: 3900, latency_ms: 1800 }, guard_json: { violations: [], action: 'accept' },
    feedback_thumb: 'down', feedback_reason: 'wrong',
    content: 'Your amounts go up to 10^4 and coins repeat; what is the largest value dp can hold before the sum wraps?'
  });
  const m5 = msg('m5', {
    rung: 4, created_at: '2026-09-02T10:30:00Z', degraded: 1, provider: null, model: null,
    guard_json: { violations: [{ rule: 'schema' }, { rule: 'code_at_rung' }], action: 'fallback' }
  });
  const assistantMessages = [m1, m2, m3, m4, m5];

  const ev = (type, created_at, payload = null, ext_version = '1.0.0') => ({ type, created_at, payload, ext_version });
  const clientEvents = [
    ev('submit_seen', '2026-09-01T09:05:00Z'), ev('verdict_seen', '2026-09-01T09:05:04Z'),
    ev('submit_seen', '2026-09-01T09:40:00Z'), ev('verdict_seen', '2026-09-01T09:40:03Z'),
    ...[8, 8, 9, 9, 10, 10].map((h, i) => ev('submit_seen', `2026-09-02T${String(h).padStart(2, '0')}:${String(10 + i).padStart(2, '0')}:00Z`)),
    ...[8, 9, 10, 10].map((h, i) => ev('verdict_seen', `2026-09-02T${String(h).padStart(2, '0')}:${String(30 + i).padStart(2, '0')}:00Z`)),
    ev('token_expired', '2026-09-01T07:00:00Z'), ev('token_expired', '2026-09-02T07:00:00Z'),
    ev('hint_timeout', '2026-09-02T09:20:00Z'),
    ev('banner_shown', '2026-09-01T08:00:00Z', { banner: 'waking' }), ev('banner_shown', '2026-09-02T07:30:00Z', { banner: 'waking' }), ev('banner_shown', '2026-09-02T07:31:00Z', JSON.stringify({ banner: 'logged_out' })),
    ev('sync_started', '2026-09-01T06:00:00Z', { resume: false }), ev('sync_error', '2026-09-01T06:03:00Z', { status: 429 }),
    ev('issue_report', '2026-09-02T10:00:00Z', { text: 'Panel went blank after sync finished', code: 'SYNTHETIC_CODE_MARKER' })
  ];
  const skillEvents = [
    { kind: 'sync', payload: { phase: 'solved', solved: 12 }, created_at: '2026-09-01T06:05:00Z' },
    { kind: 'sync', payload: JSON.stringify({ phase: 'finalize' }), created_at: '2026-09-01T06:09:00Z' },
    { kind: 'recompute', payload: null, created_at: '2026-09-01T06:09:01Z' },
    { kind: 'attempt', payload: null, created_at: '2026-09-02T08:50:05Z' },
    { kind: 'attempt', payload: null, created_at: '2026-09-02T09:30:05Z' }
  ];
  const habits = [
    { id: 1, habit_key: 'overflow', tier: 'high', live: 1, state: 'confirmed', reaction: 'confirmed' },
    { id: 2, habit_key: 'bucket:graph.bfs:wa_logic', tier: 'medium', live: 1, state: 'auto', reaction: null },
    { id: 3, habit_key: 'gap:dp.kadane', tier: 'medium', live: 0, state: 'dismissed', reaction: 'dismissed' },
    { id: 4, habit_key: 'bucket:dp.interval:wa_edge_empty', tier: 'medium', live: 0, state: 'stale', reaction: null }
  ];
  const submissions = [
    { lc_submission_id: 101, slug: 'coin-change', status_code: 15, status_msg: 'Runtime Error', verdict_bucket: 're_overflow', ts: T(8, 50), has_details: 1, captured_via: 'interceptor', created_at: '2026-09-02T08:50:05Z' },
    { lc_submission_id: 102, slug: 'coin-change', status_code: 10, status_msg: 'Accepted', verdict_bucket: null, ts: T(9, 30), has_details: 0, captured_via: 'interceptor', created_at: '2026-09-02T09:30:05Z' },
    { lc_submission_id: 103, slug: 'word-ladder', status_code: 11, status_msg: 'Wrong Answer', verdict_bucket: 'wa_logic', ts: T(20, 0, 1), has_details: 1, captured_via: 'manual', created_at: '2026-09-01T20:01:00Z' },
    { lc_submission_id: 104, slug: 'two-sum', status_code: 10, status_msg: 'Accepted', verdict_bucket: null, ts: Date.UTC(2026, 7, 25) / 1000, has_details: 0, captured_via: 'sync', created_at: '2026-09-01T06:07:00Z' }
  ];
  const userMessages = [
    { id: 'u1', session_id: 's-coin', content: 'I have no idea how to start', created_at: '2026-09-01T08:59:00Z' },
    { id: 'u3', session_id: 's-ladder', content: 'BFS gives wrong answer on the sample', created_at: '2026-09-02T07:59:00Z' },
    { id: 'u4', session_id: 's-coin', content: 'My dp overflows on the big case\n```cpp\nSYNTHETIC_STUDENT_CODE\n```', created_at: '2026-09-02T08:59:00Z' }
  ];
  return {
    user: { user_id: 'u-1', email: 'student@example.test', name: 'Pilot' },
    profile: { user_id: 'u-1', leetcode_username: 'pilot_student', language: 'english', consent_code: 1, sync_status: 'complete', last_synced_at: '2026-09-01T06:09:00Z', model_version: 'lc-model-v1', hints_day: '2026-09-02', hints_today: 3, created_at: '2026-08-30T12:00:00Z' },
    assistantMessages, habits, submissions, clientEvents, skillEvents,
    lastAssistantMessages: [m4, m3], userMessages, transcriptSubmissions: submissions.slice(0, 3),
    rowCounts: null
  };
}

describe('pilot_report.render', () => {
  const md = render(fixture(), { now: NOW, days: 14, last: 2 });

  test('has every section heading', () => {
    for (const h of ['# Anchor pilot report', '## Profile', '## Hints per day', '## Hints per rung', '## Feedback', '## Anchors', '## Habits', '## Verdicts', '## Drift (verdict_seen / submit_seen)', '## Sync', '## Provider', '## Guard', '## Client events', '## Issue reports', '## Last 2 transcripts']) {
      expect(md).toContain(`\n${h}\n`.replace(/^\n# /, '# '));
    }
    expect(md.startsWith('# Anchor pilot report\n')).toBe(true);
    expect(md).not.toContain('## Verify deleted');
  });

  test('header, window and profile', () => {
    expect(md).toContain('- user: `u-1` (s***@example.test)');
    expect(md).not.toContain('student@example.test');
    expect(md).toContain('- window: last 14 days (since 2026-08-19T12:00:00Z) · generated 2026-09-02T12:00:00Z');
    expect(md).toContain('- hints in window: 5');
    expect(md).toContain('| leetcode_username | pilot_student |');
    expect(md).toContain('| consent_code | yes |');
    expect(md).toContain('| hints_today | 3 (2026-09-02) |');
  });

  test('hints per day and per rung', () => {
    expect(md).toContain('| 2026-09-01 | 2 | 1 | 1 | 0 | 0 | 0 | 2 |');
    expect(md).toContain('| 2026-09-02 | 3 | 0 | 1 | 1 | 1 | 1 | 1 |');
    expect(md).toContain('| total | 5 | 1 | 2 | 1 | 1 | 1 | 3 |');
    expect(md).toContain('| 1 | 1 | 20% |');
    expect(md).toContain('| 2 | 2 | 40% |');
    expect(md).toContain('| unknown | 0 | 0% |');
  });

  test('feedback counts and share', () => {
    expect(md).toContain('- hints with feedback: 3 / 5 (60%)');
    expect(md).toContain('- thumbs: up 1 · down 2');
    expect(md).toContain('- reasons: helped 1 · too_much 1 · too_little 0 · wrong 1');
    expect(md).toContain('- notes: 1');
  });

  test('anchors offered vs cited', () => {
    expect(md).toContain('- hints with anchors: 3 / 5');
    expect(md).toContain('- offered: 5 · cited: 3 (60%)');
    expect(md).toContain('| climbing-stairs | Climbing Stairs | 3 | 2 |');
    expect(md).toContain('| house-robber | House Robber | 1 | 0 |');
    expect(md).toContain('| min-cost-climbing-stairs | Min Cost Climbing Stairs | 1 | 1 |');
  });

  test('habits shown vs reactions (id-only habit entries resolve to their key)', () => {
    expect(md).toContain('- hints with habits: 3 / 5 · habits shown: 4');
    expect(md).toContain('- habit rows: 4 · live: 2');
    expect(md).toContain('- states: auto 1 · confirmed 1 · dismissed 1 · stale 1');
    expect(md).toContain('- reactions: confirmed 1 · dismissed 1 · none 2');
    expect(md).toContain('| overflow | high | yes | confirmed | confirmed | 3 |');
    expect(md).toContain('| bucket:graph.bfs:wa_logic | medium | yes | auto | – | 1 |');
    expect(md).toContain('| gap:dp.kadane | medium | no | dismissed | dismissed | 0 |');
  });

  test('verdicts by captured_via and bucket', () => {
    expect(md).toContain('- submissions captured in window: 4 · accepted: 2 · with judge details: 2');
    expect(md).toContain('- captured_via: interceptor 2 · manual 1 · sync 1');
    expect(md).toContain('| ac | 2 |');
    expect(md).toContain('| re_overflow | 1 |');
    expect(md).toContain('| wa_logic | 1 |');
  });

  test('drift ratio per day and the 24 h flag', () => {
    expect(md).toContain('- last 24 h: submit_seen 6 · verdict_seen 4 · ratio 0.67 · **FLAG: ratio below 0.8 with ≥5 submits**');
    expect(md).toContain('| 2026-09-01 | 2 | 2 | 1.00 | – |');
    expect(md).toContain('| 2026-09-02 | 6 | 4 | 0.67 | FLAG |');
  });

  test('drift is not flagged under 5 submits or at ratio >= 0.8', () => {
    const f = fixture();
    f.clientEvents = f.clientEvents.filter((e) => e.type !== 'submit_seen' && e.type !== 'verdict_seen');
    f.clientEvents.push({ type: 'submit_seen', created_at: '2026-09-02T11:00:00Z' }, { type: 'submit_seen', created_at: '2026-09-02T11:01:00Z' });
    expect(render(f, { now: NOW })).toContain('- last 24 h: submit_seen 2 · verdict_seen 0 · ratio 0.00 · ok');
    f.clientEvents.push(...[1, 2, 3, 4].map((i) => ({ type: 'submit_seen', created_at: `2026-09-02T11:0${i}:30Z` })), ...[1, 2, 3, 4, 5].map((i) => ({ type: 'verdict_seen', created_at: `2026-09-02T11:0${i}:40Z` })));
    expect(render(f, { now: NOW })).toContain('- last 24 h: submit_seen 6 · verdict_seen 5 · ratio 0.83 · ok');
  });

  test('sync runs and client sync events', () => {
    expect(md).toContain('- sync runs (lc_skill_events kind=sync): 2 · last 2026-09-01T06:09:00Z');
    expect(md).toContain('- phases: solved 1 · finalize 1');
    expect(md).toContain('- skill events by kind: sync 2 · recompute 1 · attempt 2');
    expect(md).toContain('- client sync events: sync_started 1 · sync_error 1 · errors: 1');
  });

  test('provider latency percentiles and tokens', () => {
    expect(md).toContain('- all providers: p50 1800 ms · p95 5000 ms · hints with latency 4 / 5');
    expect(md).toContain('| gemini | gemini-2.5-flash | 3 | 0 | 1800 | 2400 | 1800 | 9600 | 850 | 10450 | 3483.3 |');
    expect(md).toContain('| anthropic | claude-opus-5 | 1 | 0 | 5000 | 5000 | 5000 | 4000 | 300 | 4300 | 4300 |');
    expect(md).toContain('| none | – | 1 | 1 | – | – | – | 0 | 0 | 0 | – |');
  });

  test('guard violations', () => {
    expect(md).toContain('- hints with violations: 2 / 5 · violations total: 3');
    expect(md).toContain('- by rule: rung2_transition_leak 1 · schema 1 · code_at_rung 1');
    expect(md).toContain('- by action: accept 3 · retry 1 · fallback 1');
  });

  test('client event counts', () => {
    expect(md).toContain('- token_expired: 2 · hint_timeout: 1 · banner_shown: 3 (waking 2 · logged_out 1)');
    expect(md).toContain('| submit_seen | 8 |');
    expect(md).toContain('| verdict_seen | 6 |');
    expect(md).toContain('| issue_report | 1 |');
  });

  test('issue reports print the text but never the attached code', () => {
    expect(md).toContain('- 2026-09-02T10:00:00Z (ext 1.0.0): Panel went blank after sync finished _[code attached, not shown]_');
    expect(md).not.toContain('SYNTHETIC_CODE_MARKER');
  });

  test('transcripts pair the student message, nearest earlier verdict, anchors, habits, feedback', () => {
    const i3 = md.indexOf('### 1. word-ladder · 2026-09-02T08:00:00Z · rung 2 · anthropic/claude-opus-5 · 5000 ms');
    const i4 = md.indexOf('### 2. coin-change · 2026-09-02T09:00:00Z · rung 3 · gemini/gemini-2.5-flash · 1800 ms');
    expect(i3).toBeGreaterThan(-1);
    expect(i4).toBeGreaterThan(i3);
    const t3 = md.slice(i3, i4); const t4 = md.slice(i4);
    expect(t3).toContain('- verdict: wa_logic (Wrong Answer, manual, 43200 s before)');
    expect(t3).toContain('- anchors: none');
    expect(t3).toContain('- habits: overflow, bucket:graph.bfs:wa_logic');
    expect(t3).toContain('- feedback: none');
    expect(t3).toContain('> **Student:** BFS gives wrong answer on the sample');
    expect(t3).toContain('> **Anchor:** Before touching the queue');
    expect(t4).toContain('- verdict: re_overflow (Runtime Error, interceptor, 600 s before)');
    expect(t4).toContain('- anchors: climbing-stairs (cited), min-cost-climbing-stairs (cited)');
    expect(t4).toContain('- habits: id:1');
    expect(t4).toContain('- feedback: down / wrong');
    expect(t4).toContain('- guard: 0 violations, accept');
    expect(t4).toContain('> **Student:** My dp overflows on the big case\n> [code omitted]');
    expect(md).not.toContain('SYNTHETIC_STUDENT_CODE');
  });

  test('transcript heading notes when fewer than requested exist', () => {
    expect(render(fixture(), { now: NOW, last: 20 })).toContain('## Last 2 transcripts (20 requested)');
  });

  test('--verify-deleted section reports remaining rows and ALL ZERO', () => {
    const f = fixture();
    f.rowCounts = Object.fromEntries(LC_USER_TABLES.map((t) => [t, t === 'lc_profiles' ? 1 : 0]));
    const notEmpty = render(f, { now: NOW });
    expect(notEmpty).toContain('## Verify deleted');
    expect(notEmpty).toContain('| lc_profiles | 1 |');
    expect(notEmpty).toContain('- result: NOT EMPTY (1 rows remain)');
    f.rowCounts = Object.fromEntries(LC_USER_TABLES.map((t) => [t, 0]));
    expect(render(f, { now: NOW })).toContain('- result: ALL ZERO');
  });

  test('empty rows render without throwing', () => {
    const out = render({}, { now: NOW });
    expect(out).toContain('- hints in window: 0');
    expect(out).toContain('_no lc_profiles row_');
    expect(out).toContain('| total | 0 | 0 | 0 | 0 | 0 | 0 | 0 |');
    expect(out).toContain('- last 24 h: submit_seen 0 · verdict_seen 0 · ratio – · ok');
    expect(out).toContain('## Last 0 transcripts');
    expect(render(null, { now: NOW })).toContain('# Anchor pilot report');
  });

  test('is deterministic for the same rows and now', () => {
    expect(render(fixture(), { now: NOW, days: 14, last: 2 })).toBe(md);
  });
});

describe('pilot_report stats helpers', () => {
  test('percentile is nearest-rank', () => {
    expect(helpers.percentile([1200, 2400, 1800], 50)).toBe(1800);
    expect(helpers.percentile([1200, 2400, 1800], 95)).toBe(2400);
    expect(helpers.percentile([], 50)).toBeNull();
    expect(helpers.percentile([5], 99)).toBe(5);
  });
  test('redactCode drops closed and dangling fences', () => {
    expect(helpers.redactCode('a\n```\nX\n```\nb')).toBe('a\n[code omitted]\nb');
    expect(helpers.redactCode('a ```cpp\nX')).toBe('a [code omitted]');
    expect(helpers.redactCode('x'.repeat(20), 5)).toBe('xxxxx…');
  });
  test('driftStats ignores unrelated events and events after now', () => {
    const d = stats.driftStats([{ type: 'submit_seen', created_at: '2026-09-02T13:00:00Z' }, { type: 'banner_shown', created_at: '2026-09-02T11:00:00Z' }], new Date(NOW));
    expect(d.last_24h).toEqual({ submit: 0, verdict: 0, ratio: null, flagged: false });
    expect(d.per_day).toEqual([{ day: '2026-09-02', submit: 1, verdict: 0, ratio: 0, flagged: false }]);
  });
});

describe('pilot_report CLI and SQL plumbing', () => {
  test('parseArgs defaults and flags', () => {
    expect(parseArgs([])).toEqual({ user: null, days: 14, last: 20, out: null, verifyDeleted: false, help: false });
    expect(parseArgs(['--user', 'u-1', '--days', '1', '--last', '5', '--out', 'x.md', '--verify-deleted'])).toEqual({ user: 'u-1', days: 1, last: 5, out: 'x.md', verifyDeleted: true, help: false });
    expect(parseArgs(['--days', 'nope', '--last', '-3'])).toMatchObject({ days: 14, last: 20 });
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  test('queries use parameterised SQL and never select code or prompt columns', async () => {
    const calls = [];
    const fake = { query: async (sql, params) => { calls.push({ sql, params }); return [[{ n: 0 }]]; } };
    await queries.resolveUser(fake, 'student@example.test');
    await queries.resolveUser(fake, 'u-1');
    await queries.rowCounts(fake, 'u-1');
    const since = new Date('2026-08-19T12:00:00Z');
    await queries.assistantMessages(fake, 'u-1', since);
    await queries.lastAssistantMessages(fake, 'u-1', 20);
    await queries.userMessagesForSessions(fake, 'u-1', ['s-1']);
    await queries.submissions(fake, 'u-1', since);
    await queries.submissionsForSlugs(fake, 'u-1', ['coin-change']);
    await queries.clientEvents(fake, 'u-1', since);
    await queries.skillEvents(fake, 'u-1', since);
    await queries.habits(fake, 'u-1');
    await queries.profile(fake, 'u-1');
    expect(calls[0].sql).toMatch(/WHERE email = \?/);
    expect(calls[1].sql).toMatch(/WHERE user_id = \?/);
    expect(calls.slice(2, 2 + LC_USER_TABLES.length).map((c) => c.sql)).toEqual(LC_USER_TABLES.map((t) => `SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`));
    for (const c of calls) {
      expect(c.sql).not.toMatch(/student@example\.test|u-1|coin-change|s-1/);
      expect(c.params[0]).toMatch(/^(u-1|student@example\.test)$/);
      expect(c.sql).not.toMatch(/\bcode\b|\bcode_hash\b|skill_summary|sync_progress|\bevidence\b|statement_excerpt/);
    }
    expect(await queries.userMessagesForSessions(fake, 'u-1', [])).toEqual([]);
    expect(await queries.submissionsForSlugs(fake, 'u-1', [])).toEqual([]);
    expect(await queries.lastAssistantMessages(fake, 'u-1', 0)).toEqual([]);
  });
});
