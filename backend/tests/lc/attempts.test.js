'use strict';
const { buildAttempts, similarity, normalizeSubmission } = require('../../src/lc/domain/attempts');
const { aggregate } = require('../../src/lc/domain/aggregate');
const { loadSeed } = require('../../src/lc/domain/seed');
const { buildFixture, codeLookupFor, PLANTED } = require('./fixtures/buildFixture');
const S = require('./fixtures/snippets');

const MSG = { 10: 'Accepted', 11: 'Wrong Answer', 14: 'Time Limit Exceeded', 15: 'Runtime Error', 20: 'Compile Error' };
// DB-shaped row without details (detail columns omitted, see buildFixture.js for why).
const row = (id, slug, status_code, ts, extra = {}) => ({ lc_submission_id: id, slug, status_code, status_msg: MSG[status_code], lang: 'cpp', ts, has_details: 0, runtime_percentile: null, ...extra });
const edge = { has_details: 1, last_testcase: '[]', expected_output: '0', code_output: '-1', error_text: '' };
const problems = new Map([['p', { title: 'Problem P', difficulty: 'Hard', tags: ['array', 'dynamic-programming'] }], ['q', { title: 'Problem Q', difficulty: 'easy', tags: ['math'] }]]);

describe('buildAttempts basics', () => {
  test('one attempt per problem with counts derived from the sequence up to the first AC', () => {
    const subs = [row(1, 'p', 11, 100, edge), row(2, 'p', 14, 200), row(3, 'p', 10, 300, { runtime_percentile: 77.5 })];
    const [a] = buildAttempts(subs, problems, null);
    expect(a).toMatchObject({
      slug: 'p', title: 'Problem P', difficulty: 'hard', tags: ['array', 'dynamic-programming'], families: [], subpatterns: [], primary: null,
      n_submissions: 3, first_ts: 100, first_ac_ts: 300, first_ac_id: 3, attempts_to_ac: 3, solved: true, fails_before_ac: 2,
      fail_buckets: ['wa_edge_empty', 'tle'], time_to_ac_s: 200, fragile_flags: []
    });
    expect(a.sequence).toEqual([
      { id: 1, ts: 100, status: 11, statusDisplay: 'Wrong Answer', lang: 'cpp', bucket: 'wa_edge_empty', hasDetails: true, runtimePercentile: null },
      { id: 2, ts: 200, status: 14, statusDisplay: 'Time Limit Exceeded', lang: 'cpp', bucket: 'tle', hasDetails: false, runtimePercentile: null },
      { id: 3, ts: 300, status: 10, statusDisplay: 'Accepted', lang: 'cpp', bucket: 'ac', hasDetails: false, runtimePercentile: 77.5 }
    ]);
  });

  test('submissions after the first AC never count as fails', () => {
    const subs = [row(1, 'p', 11, 100), row(2, 'p', 10, 200), row(3, 'p', 11, 300), row(4, 'p', 10, 400)];
    const [a] = buildAttempts(subs, problems, null);
    expect(a).toMatchObject({ attempts_to_ac: 2, fails_before_ac: 1, fail_buckets: ['wa_unknown'], n_submissions: 4, first_ac_id: 2 });
  });

  test('unsolved problem: every non-AC row is a fail and AC fields are null', () => {
    const subs = [row(1, 'p', 11, 100), row(2, 'p', 15, 200)];
    const [a] = buildAttempts(subs, problems, null);
    expect(a).toMatchObject({ solved: false, attempts_to_ac: null, first_ac_ts: null, first_ac_id: null, time_to_ac_s: null, fails_before_ac: 2, fail_buckets: ['wa_unknown', 're_unknown'], n_submissions: 2 });
  });

  test('pending wire rows and rows without a slug or id are dropped', () => {
    const subs = [
      { id: 1, titleSlug: 'p', statusDisplay: 'Accepted', timestamp: 100, isPending: 'Pending' },
      { id: 2, titleSlug: 'p', statusDisplay: 'Wrong Answer', timestamp: 90, isPending: 'Not Pending' },
      row(3, undefined, 10, 300),
      { slug: 'p', status_code: 10, ts: 400 }
    ];
    const [a] = buildAttempts(subs, problems, null);
    expect(buildAttempts(subs, problems, null)).toHaveLength(1);
    expect(a.sequence.map((s) => s.id)).toEqual([2]);
    expect(a.solved).toBe(false);
  });

  test('empty and null inputs give an empty list', () => {
    expect(buildAttempts([], problems, null)).toEqual([]);
    expect(buildAttempts(null, problems, null)).toEqual([]);
  });
});

describe('ordering', () => {
  test('sequence is chronological (ts, then id) regardless of input order', () => {
    const subs = [row(5, 'p', 10, 300), row(2, 'p', 11, 100), row(9, 'p', 14, 200), row(3, 'p', 11, 100)];
    const [a] = buildAttempts(subs, problems, null);
    expect(a.sequence.map((s) => s.id)).toEqual([2, 3, 9, 5]);
    expect(a.attempts_to_ac).toBe(4);
  });

  test('attempts are oldest-first by first submission, ties broken by slug', () => {
    const subs = [row(1, 'q', 10, 500), row(2, 'p', 11, 100), row(3, 'p', 10, 900), row(4, 'b', 10, 100), row(5, 'a', 10, 100)];
    const out = buildAttempts(subs, problems, null);
    expect(out.map((a) => a.slug)).toEqual(['a', 'b', 'p', 'q']);
  });
});

describe('quick_after_tle', () => {
  const pair = (gapS, prevStatus = 14) => [row(1, 'p', prevStatus, 1000), row(2, 'p', 10, 1000 + gapS)];
  const lookup = (map) => (id) => map[id] || null;

  test('flagged when the AC follows a TLE within 300 s with near-identical code', () => {
    const [a] = buildAttempts(pair(200), problems, null, { codeLookup: lookup({ 1: S.TLE_SLIDING_WINDOW_NAIVE, 2: S.AC_SLIDING_WINDOW_SIMILAR }) });
    expect(a.fragile_flags).toEqual(['quick_after_tle']);
  });
  test('identical code is flagged', () => {
    const [a] = buildAttempts(pair(299), problems, null, { codeLookup: lookup({ 1: S.TLE_KTH_LARGEST_NAIVE, 2: S.TLE_KTH_LARGEST_NAIVE }) });
    expect(a.fragile_flags).toEqual(['quick_after_tle']);
  });
  test('not flagged when the code is different (similarity <= 0.8)', () => {
    const [a] = buildAttempts(pair(200), problems, null, { codeLookup: lookup({ 1: S.TLE_KTH_LARGEST_NAIVE, 2: S.AC_KTH_LARGEST_DIFFERENT }) });
    expect(a.fragile_flags).toEqual([]);
  });
  test('not flagged at or beyond 300 s', () => {
    const [a] = buildAttempts(pair(300), problems, null, { codeLookup: lookup({ 1: S.TLE_SLIDING_WINDOW_NAIVE, 2: S.AC_SLIDING_WINDOW_SIMILAR }) });
    expect(a.fragile_flags).toEqual([]);
  });
  test('not flagged when the previous submission was a WA, not a TLE', () => {
    const [a] = buildAttempts(pair(200, 11), problems, null, { codeLookup: lookup({ 1: S.TLE_SLIDING_WINDOW_NAIVE, 2: S.AC_SLIDING_WINDOW_SIMILAR }) });
    expect(a.fragile_flags).toEqual([]);
  });
  test('not flagged when the TLE is not the immediately preceding submission', () => {
    const subs = [row(1, 'p', 14, 1000), row(2, 'p', 11, 1100), row(3, 'p', 10, 1200)];
    const [a] = buildAttempts(subs, problems, null, { codeLookup: () => S.TLE_SLIDING_WINDOW_NAIVE });
    expect(a.fragile_flags).toEqual([]);
  });
  test('not flagged without code for either side (consent off)', () => {
    expect(buildAttempts(pair(200), problems, null)[0].fragile_flags).toEqual([]);
    expect(buildAttempts(pair(200), problems, null, { codeLookup: lookup({ 1: S.TLE_SLIDING_WINDOW_NAIVE }) })[0].fragile_flags).toEqual([]);
  });
  test('the only code lookups are for the TLE -> AC pair', () => {
    const asked = [];
    buildAttempts([row(1, 'p', 11, 100), row(2, 'p', 14, 1000), row(3, 'p', 10, 1100)], problems, null, { codeLookup: (id) => { asked.push(id); return null; } });
    expect(asked.sort()).toEqual([2, 3]);
  });
});

describe('no low_percentile flag, ever', () => {
  test('a bottom-percentile AC carries no fragile flag', () => {
    const subs = [row(1, 'p', 10, 100, { runtime_percentile: 0.5 }), row(2, 'q', 14, 100), row(3, 'q', 10, 200, { runtime_percentile: 1 })];
    const out = buildAttempts(subs, problems, null, { codeLookup: () => S.TLE_KTH_LARGEST_NAIVE });
    for (const a of out) expect(a.fragile_flags).not.toContain('low_percentile');
    expect(out.find((a) => a.slug === 'q').fragile_flags).toEqual(['quick_after_tle']);
    expect(Object.keys(aggregate(out).fragile_flags)).toEqual(['quick_after_tle']);
    expect(out[0].sequence[0].runtimePercentile).toBe(0.5); // still carried as data
  });
});

describe('problem metadata and seed enrichment', () => {
  test('problemsBySlug wins, difficulty is normalised, topic_tags alias honoured', () => {
    const map = new Map([['p', { title: 'T', difficulty: 'MEDIUM', topic_tags: ['string'] }]]);
    const [a] = buildAttempts([row(1, 'p', 10, 1)], map, null);
    expect(a).toMatchObject({ title: 'T', difficulty: 'medium', tags: ['string'] });
  });
  test('falls back to the seed catalog, then to the bare slug', () => {
    const seed = loadSeed();
    const [cc, zz] = buildAttempts([row(1, 'coin-change', 10, 1), row(2, 'zz-not-a-problem', 10, 2)], new Map(), seed);
    expect(cc).toMatchObject({ title: 'Coin Change', difficulty: 'medium', families: ['dp', 'graph'] }); // LeetCode tags coin-change with breadth-first-search too
    expect(cc.tags).toContain('knapsack-problem');
    expect(cc.primary).toMatchObject({ id: 'dp.knapsack_unbounded', primary: true, family: 'dp' });
    expect(cc.subpatterns.map((m) => m.id)).toContain('dp.knapsack_unbounded');
    expect(zz).toMatchObject({ title: 'zz-not-a-problem', difficulty: null, tags: [], families: [], subpatterns: [], primary: null });
  });
  test('without a seed, families/subpatterns/primary are empty', () => {
    const [a] = buildAttempts([row(1, 'coin-change', 10, 1)], new Map([['coin-change', { tags: ['dynamic-programming'] }]]), null);
    expect(a).toMatchObject({ families: [], subpatterns: [], primary: null, title: 'coin-change' });
  });
});

describe('normalizeSubmission', () => {
  test('wire shape maps to the internal shape', () => {
    const n = normalizeSubmission({ id: '42', titleSlug: 'p', title: 'P', statusDisplay: 'Wrong Answer', timestamp: '1700000000', lang: 'cpp', isPending: 'Not Pending', runtimePercentile: 12.5 });
    expect(n).toEqual({ id: 42, slug: 'p', title: 'P', ts: 1700000000, status: 11, statusDisplay: 'Wrong Answer', lang: 'cpp', bucket: 'wa_unknown', hasDetails: false, runtimePercentile: 12.5, pending: false });
  });
  test('DB row with details is bucketed from its own columns', () => {
    const n = normalizeSubmission({ lc_submission_id: 7, slug: 'p', status_code: 15, status_msg: 'Runtime Error', ts: 5, has_details: 1, last_testcase: '[1,2]', expected_output: '', code_output: '', error_text: 'runtime error: signed integer overflow: 1 + 2147483647 cannot be represented in type int' });
    expect(n).toMatchObject({ id: 7, status: 15, bucket: 're_overflow', hasDetails: true });
  });
  test('a stored verdict_bucket takes precedence over recomputation', () => {
    expect(normalizeSubmission({ lc_submission_id: 1, slug: 'p', status_code: 11, verdict_bucket: 'wa_logic' }).bucket).toBe('wa_logic');
  });
  test('missing slug/id and pending flags are surfaced, not thrown', () => {
    expect(normalizeSubmission({ status_code: 10 })).toMatchObject({ id: null, slug: null, ts: 0 });
    expect(normalizeSubmission({ id: 1, titleSlug: 'p', isPending: 'Pending' }).pending).toBe(true);
  });
});

describe('similarity', () => {
  test('identical -> 1, empty -> 0, whitespace-insensitive per line', () => {
    expect(similarity('a\nb', 'a\nb')).toBe(1);
    expect(similarity('', 'a')).toBe(0);
    expect(similarity('a', '')).toBe(0);
    expect(similarity(null, undefined)).toBe(0);
    expect(similarity('  a  \n\n b', 'a\nb\n')).toBe(1);
  });
  test('fixture snippet pairs sit on the intended sides of 0.8', () => {
    expect(similarity(S.TLE_SLIDING_WINDOW_NAIVE, S.AC_SLIDING_WINDOW_SIMILAR)).toBeCloseTo(12 / 13, 10);
    expect(similarity(S.TLE_KTH_LARGEST_NAIVE, S.AC_KTH_LARGEST_DIFFERENT)).toBeCloseTo(5 / 12, 10);
  });
});

describe('fixture goldens', () => {
  const fx = buildFixture();
  const attempts = buildAttempts(fx.submissions, fx.problemsBySlug, fx.seedObj, { codeLookup: codeLookupFor(fx.submissions) });
  const by = new Map(attempts.map((a) => [a.slug, a]));

  test('39 problems, 38 solved, one unsolved overflow problem', () => {
    expect(attempts).toHaveLength(39);
    expect(attempts.filter((a) => a.solved)).toHaveLength(38);
    expect(by.get(PLANTED.overflow_unsolved[0])).toMatchObject({ solved: false, fail_buckets: ['re_overflow', 're_overflow'] });
  });
  test('exactly one quick_after_tle, on the planted slug; the different-code pair is unflagged', () => {
    const flagged = attempts.filter((a) => a.fragile_flags.length);
    expect(flagged.map((a) => a.slug)).toEqual([PLANTED.quick_after_tle]);
    expect(by.get(PLANTED.quick_after_tle)).toMatchObject({ attempts_to_ac: 2, fail_buckets: ['tle'], time_to_ac_s: 200, fragile_flags: ['quick_after_tle'] });
    expect(by.get(PLANTED.slow_after_tle)).toMatchObject({ attempts_to_ac: 2, fail_buckets: ['tle'], time_to_ac_s: 200, fragile_flags: [] });
  });
  test('planted groups have the intended shapes', () => {
    for (const slug of PLANTED.interval) {
      const a = by.get(slug);
      expect(a.solved).toBe(true);
      expect(a.fail_buckets.filter((b) => b === 'wa_edge_empty').length).toBeGreaterThanOrEqual(2);
      expect(a.primary.id).toBe('dp.interval');
    }
    for (const slug of PLANTED.kadane) {
      const a = by.get(slug);
      expect(a.attempts_to_ac).toBeGreaterThanOrEqual(4);
      expect(a.attempts_to_ac).toBeLessThanOrEqual(6);
      expect(a.primary.id).toBe('dp.kadane_max_subarray');
    }
    for (const slug of PLANTED.overflow_solved) expect(by.get(slug)).toMatchObject({ attempts_to_ac: 3, fail_buckets: ['re_overflow', 're_overflow'] });
    for (const [sub, slugs] of Object.entries(PLANTED.first_try)) for (const slug of slugs) {
      expect(by.get(slug)).toMatchObject({ attempts_to_ac: 1, fail_buckets: [] });
      expect(by.get(slug).subpatterns.map((m) => m.id)).toContain(sub);
    }
  });
  test('no low_percentile anywhere', () => {
    expect(attempts.some((a) => a.fragile_flags.includes('low_percentile'))).toBe(false);
  });
  test('deterministic: rebuilding the fixture yields identical attempts', () => {
    const fx2 = buildFixture();
    const again = buildAttempts(fx2.submissions, fx2.problemsBySlug, fx2.seedObj, { codeLookup: codeLookupFor(fx2.submissions) });
    expect(JSON.stringify(again)).toBe(JSON.stringify(attempts));
  });
  test('a different seed changes the fixture but keeps the invariants', () => {
    const fx2 = buildFixture({ seed: 42 });
    expect(JSON.stringify(fx2.submissions)).not.toBe(JSON.stringify(fx.submissions));
    const again = buildAttempts(fx2.submissions, fx2.problemsBySlug, fx2.seedObj, { codeLookup: codeLookupFor(fx2.submissions) });
    expect(again.filter((a) => a.fragile_flags.length).map((a) => a.slug)).toEqual([PLANTED.quick_after_tle]);
    expect(again.filter((a) => a.solved)).toHaveLength(38);
  });
  test('rows are DB-shaped and ids increase with time', () => {
    for (const r of fx.submissions) {
      expect(r).toMatchObject({ lc_submission_id: expect.any(Number), slug: expect.any(String), status_code: expect.any(Number), status_msg: expect.any(String), lang: 'cpp', ts: expect.any(Number) });
      expect([0, 1]).toContain(r.has_details);
      if (r.has_details) expect(r).toEqual(expect.objectContaining({ last_testcase: expect.any(String), expected_output: expect.any(String), code_output: expect.any(String), error_text: expect.any(String) }));
    }
    for (let i = 1; i < fx.submissions.length; i++) {
      expect(fx.submissions[i].lc_submission_id).toBe(fx.submissions[i - 1].lc_submission_id + 1);
      expect(fx.submissions[i].ts).toBeGreaterThanOrEqual(fx.submissions[i - 1].ts);
    }
    expect(fx.submissions.filter((r) => r.code !== undefined)).toHaveLength(4);
  });
});
