'use strict';
const { aggregate, baselines, difficultyMatchedBaseline, mean, median, r2 } = require('../../src/lc/domain/aggregate');
const { RECENT_N } = require('../../src/lc/domain/constants');

const att = (slug, o = {}) => ({ slug, solved: o.solved !== false, attempts_to_ac: o.solved === false ? null : (o.attempts_to_ac ?? 1), fail_buckets: o.fail_buckets || [], fragile_flags: o.fragile_flags || [], difficulty: o.difficulty || 'medium', first_ac_ts: o.first_ac_ts ?? 0 });

describe('aggregate (by hand)', () => {
  const items = [
    att('A', { attempts_to_ac: 1 }),
    att('B', { attempts_to_ac: 3, fail_buckets: ['wa_edge_empty', 'wa_logic'], fragile_flags: ['quick_after_tle'] }),
    att('C', { solved: false, fail_buckets: ['re_overflow', 'wa_unknown'] }),
    att('D', { attempts_to_ac: 2, fail_buckets: ['tle'] })
  ];
  const out = aggregate(items);

  test('counts', () => {
    expect(out).toMatchObject({ n_problems: 4, n_solved: 3, n_fails: 5, n_fails_with_details: 4, problems: ['A', 'B', 'C', 'D'] });
    expect(out.fail_hist).toEqual({ wa_edge_empty: 1, wa_logic: 1, re_overflow: 1, wa_unknown: 1, tle: 1 });
  });
  test('skews are over known buckets, shares over all fails', () => {
    expect(out.base_case_skew).toBe(0.25);   // wa_edge_empty / 4 known
    expect(out.transition_skew).toBe(0.25);  // wa_logic / 4 known
    expect(out.tle_share).toBe(0.2);
    expect(out.overflow_share).toBe(0.2);
    expect(out.re_share).toBe(0.2);
  });
  test('attempt statistics over solved items only', () => {
    expect(out.mean_attempts_to_ac).toBe(2);
    expect(out.median_attempts_to_ac).toBe(2);
    expect(out.first_try_rate).toBe(0.33);
    expect(out.fragile_ac).toBe(1);
    expect(out.fragile_flags).toEqual({ quick_after_tle: 1 });
  });
  test('empty input gives nulls, not NaN', () => {
    expect(aggregate([])).toEqual({ n_problems: 0, n_solved: 0, n_fails: 0, n_fails_with_details: 0, fail_hist: {}, base_case_skew: null, transition_skew: null, tle_share: null, overflow_share: null, re_share: null, mean_attempts_to_ac: null, median_attempts_to_ac: null, first_try_rate: null, fragile_ac: 0, fragile_flags: {}, problems: [] });
  });
  test('only-unknown fails: shares defined, skews null', () => {
    const o = aggregate([att('X', { solved: false, fail_buckets: ['wa_unknown', 're_unknown'] })]);
    expect(o).toMatchObject({ n_fails: 2, n_fails_with_details: 0, base_case_skew: null, transition_skew: null, tle_share: 0, re_share: 0.5 });
  });
  test('overflow-shaped counts wa_modulo and wa_bounds_overflow too', () => {
    const o = aggregate([att('X', { solved: false, fail_buckets: ['wa_modulo', 'wa_bounds_overflow', 're_overflow', 'wa_logic'] })]);
    expect(o.overflow_share).toBe(0.75);
    expect(o.transition_skew).toBe(0.75); // wa_modulo, wa_bounds_overflow, wa_logic are transition-shaped
  });
});

describe('baselines (trailing RECENT_N, difficulty-stratified)', () => {
  // 20 old easy solves at 5 attempts, then 100 recent: 40 easy@1, 40 medium@2, 20 hard@3.
  const items = [];
  for (let i = 0; i < 20; i++) items.push(att(`old${i}`, { difficulty: 'easy', attempts_to_ac: 5, first_ac_ts: 1000 + i }));
  for (let i = 0; i < 40; i++) items.push(att(`e${i}`, { difficulty: 'easy', attempts_to_ac: 1, first_ac_ts: 5000 + i }));
  for (let i = 0; i < 40; i++) items.push(att(`m${i}`, { difficulty: 'medium', attempts_to_ac: 2, first_ac_ts: 6000 + i }));
  for (let i = 0; i < 20; i++) items.push(att(`h${i}`, { difficulty: 'hard', attempts_to_ac: 3, first_ac_ts: 7000 + i }));
  items.push(att('unsolved', { solved: false, first_ac_ts: null }));

  test('RECENT_N is 100', () => { expect(RECENT_N).toBe(100); });
  test('recent window is the last 100 by first_ac_ts; lifetime includes the old ones', () => {
    const shuffled = items.slice().reverse();
    const b = baselines(shuffled);
    expect(b).toEqual({ n_solved: 120, lifetime_mean: 2.33, recent_mean: 1.8, recent_n: 100, by_difficulty: { easy: 1, medium: 2, hard: 3 } });
  });
  test('custom recentN and missing difficulties', () => {
    const b = baselines(items, 20);
    expect(b.recent_n).toBe(20);
    expect(b.by_difficulty).toEqual({ easy: null, medium: null, hard: 3 });
    expect(b.recent_mean).toBe(3);
  });
  test('empty input', () => {
    expect(baselines([])).toEqual({ n_solved: 0, lifetime_mean: null, recent_mean: null, recent_n: 0, by_difficulty: { easy: null, medium: null, hard: null } });
  });
});

describe('difficultyMatchedBaseline fallbacks', () => {
  const base = { recent_mean: 1.8, by_difficulty: { easy: 1, medium: 2, hard: null } };
  test('mean of the per-difficulty baselines of the items', () => {
    expect(difficultyMatchedBaseline([{ difficulty: 'easy' }, { difficulty: 'medium' }], base)).toBe(1.5);
    expect(difficultyMatchedBaseline([{ difficulty: 'medium' }, { difficulty: 'medium' }, { difficulty: 'easy' }], base)).toBeCloseTo(5 / 3, 10);
  });
  test('items whose difficulty has no baseline are skipped', () => {
    expect(difficultyMatchedBaseline([{ difficulty: 'hard' }, { difficulty: 'easy' }], base)).toBe(1);
    expect(difficultyMatchedBaseline([{ difficulty: null }, { difficulty: 'medium' }], base)).toBe(2);
  });
  test('falls back to recent_mean when no item difficulty is covered', () => {
    expect(difficultyMatchedBaseline([{ difficulty: 'hard' }], base)).toBe(1.8);
    expect(difficultyMatchedBaseline([], base)).toBe(1.8);
  });
  test('falls back to 1.5 without any baseline', () => {
    expect(difficultyMatchedBaseline([{ difficulty: 'hard' }], { recent_mean: null, by_difficulty: { easy: null, medium: null, hard: null } })).toBe(1.5);
    expect(difficultyMatchedBaseline([{ difficulty: 'easy' }], null)).toBe(1.5);
    expect(difficultyMatchedBaseline([{ difficulty: 'easy' }], {})).toBe(1.5);
  });
});

describe('helpers', () => {
  test('mean / median / r2', () => {
    expect(mean([])).toBeNull();
    expect(mean([1, 2, 6])).toBe(3);
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(r2(null)).toBeNull();
    expect(r2(undefined)).toBeNull();
    expect(r2(NaN)).toBeNull();
    expect(r2(1 / 3)).toBe(0.33);
    expect(r2(2.346)).toBe(2.35);
    expect(r2(0)).toBe(0);
  });
});
