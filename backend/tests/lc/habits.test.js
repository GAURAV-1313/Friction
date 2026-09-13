'use strict';
const { computeHabits, renderStatement, selectRelevantHabits, BIG_CONSTRAINT } = require('../../src/lc/domain/habits');
const { WINDOW_S } = require('../../src/lc/domain/constants');
const { buildAttempts } = require('../../src/lc/domain/attempts');
const { buildFixture, codeLookupFor, FIXTURE_NOW, PLANTED } = require('./fixtures/buildFixture');

const NOW = 1789171200;
const DAY = 86400;
const RECENT = NOW - 30 * DAY;
const STALE = NOW - 400 * DAY;

// Synthetic attempt: `fails` is a list of buckets before the AC (or all fails when unsolved).
let seq = 0;
function att({ slug, subs = [], fails = [], solved = true, ts = RECENT, difficulty = 'medium' }) {
  const sequence = fails.map((bucket, i) => ({ id: ++seq, ts: ts + i * 60, status: bucket === 'tle' ? 14 : bucket.startsWith('re_') ? 15 : 11, bucket }));
  if (solved) sequence.push({ id: ++seq, ts: ts + fails.length * 60, status: 10, bucket: 'ac' });
  return { slug, difficulty, subpatterns: subs.map((id) => ({ id, primary: true })), solved, first_ac_ts: solved ? ts + fails.length * 60 : null, attempts_to_ac: solved ? fails.length + 1 : null, sequence };
}
const keys = (hs) => hs.map((h) => h.key);
const habitsOf = (attempts) => computeHabits({ attempts, asOf: NOW, seed: null });

describe('overflow habit thresholds', () => {
  const filler = (n, bucket = 'wa_logic', ts = RECENT) => Array.from({ length: n }, (_, i) => att({ slug: `f${bucket}${ts}${i}`, fails: [bucket], ts: ts - i * DAY }));
  test('needs at least 5 overflow-shaped fails', () => {
    expect(keys(habitsOf([...filler(4, 're_overflow'), ...filler(5)]))).not.toContain('overflow');
    expect(keys(habitsOf([...filler(5, 're_overflow'), ...filler(5)]))).toContain('overflow');
  });
  test('needs at least 8% of all fails', () => {
    expect(keys(habitsOf([...filler(5, 're_overflow'), ...filler(58)]))).not.toContain('overflow'); // 5/63 = 0.079 -> no
    expect(keys(habitsOf([...filler(5, 're_overflow'), ...filler(57)]))).toContain('overflow');   // 5/62 = 0.081 -> yes
  });
  test('wa_modulo and wa_bounds_overflow are overflow-shaped too; tier high; live needs 3 recent', () => {
    const stale = habitsOf([...filler(3, 'wa_modulo', STALE), ...filler(2, 'wa_bounds_overflow', STALE), ...filler(5)]);
    const h = stale.find((x) => x.key === 'overflow');
    expect(h).toMatchObject({ category: 'overflow', subpattern: null, bucket: 're_overflow', tier: 'high', live: false, statement_template: 'overflow' });
    expect(h.counts).toEqual({ n: 5, of: 10, recent_n: 0, recent_of: 5 });
    const live = habitsOf([...filler(3, 're_overflow'), ...filler(2, 're_overflow', STALE), ...filler(5)]).find((x) => x.key === 'overflow');
    expect(live.live).toBe(true);
    expect(live.counts).toEqual({ n: 5, of: 10, recent_n: 3, recent_of: 8 });
    expect(live.evidence.examples.length).toBeLessThanOrEqual(3);
  });
});

describe('bucket habit thresholds', () => {
  const inSub = (fails, ts = RECENT, slug = 's') => att({ slug, subs: ['dp.x'], fails, ts });
  const baseline = Array.from({ length: 6 }, (_, i) => att({ slug: `b${i}`, fails: [], ts: RECENT - i * DAY }));
  test('needs 5 known-bucket fail events in the sub-pattern and a 60% share', () => {
    expect(keys(habitsOf([inSub(['tle', 'tle', 'wa_logic', 'wa_logic']), ...baseline]))).not.toContain('bucket:dp.x:tle');
    const h = habitsOf([inSub(['tle', 'tle', 'tle', 'wa_logic', 'wa_logic']), ...baseline]).find((x) => x.key === 'bucket:dp.x:tle');
    expect(h).toMatchObject({ category: 'bucket', subpattern: 'dp.x', bucket: 'tle', tier: 'high', live: true, statement_template: 'bucket' });
    expect(h.counts).toEqual({ n: 3, of: 5, share: 0.6, recent_n: 3 });
    expect(keys(habitsOf([inSub(['tle', 'tle', 'wa_logic', 'wa_logic', 're_index']), ...baseline])).some((k) => k.startsWith('bucket:'))).toBe(false);
  });
  test('unknown buckets are not fail events for the skew; live needs 3 recent events of that bucket', () => {
    expect(keys(habitsOf([inSub(['wa_unknown', 'wa_unknown', 'wa_unknown', 'wa_unknown', 'wa_unknown', 'wa_logic', 'wa_logic']), ...baseline])).some((k) => k.startsWith('bucket:'))).toBe(false);
    const stale = habitsOf([inSub(['wa_logic', 'wa_logic', 'wa_logic', 'wa_logic', 'tle'], STALE), ...baseline]).find((x) => x.key === 'bucket:dp.x:wa_logic');
    expect(stale).toMatchObject({ live: false, tier: 'medium' });
    expect(stale.counts.recent_n).toBe(0);
    const mixed = habitsOf([inSub(['wa_logic', 'wa_logic'], STALE), inSub(['wa_logic', 'wa_logic', 'tle'], RECENT, 's2'), ...baseline]).find((x) => x.key === 'bucket:dp.x:wa_logic');
    expect(mixed.live).toBe(false); // only 2 recent wa_logic
  });
  test('buckets without a calibration tier never form a habit; mle_state forms a tier-low habit', () => {
    expect(keys(habitsOf([inSub(['re_other', 're_other', 're_other', 're_other', 're_other']), ...baseline])).some((k) => k.startsWith('bucket:'))).toBe(false);
    const low = habitsOf([inSub(['mle_state', 'mle_state', 'mle_state', 'mle_state', 'mle_state']), ...baseline]).find((x) => x.key === 'bucket:dp.x:mle_state');
    expect(low).toMatchObject({ tier: 'low', live: true });
  });
  test('ties between buckets resolve alphabetically', () => {
    const h = habitsOf([inSub(['tle', 'tle', 'tle', 're_index', 're_index', 're_index']), ...baseline]);
    expect(keys(h).some((k) => k.startsWith('bucket:'))).toBe(false); // 3/6 = 0.5 < 0.6, but the sorted top would be re_index
  });
});

describe('gap habit thresholds', () => {
  const others = (n, attempts = 1) => Array.from({ length: n }, (_, i) => att({ slug: `o${i}`, fails: Array(attempts - 1).fill('wa_logic'), ts: RECENT - i * DAY }));
  const subItems = (n, attempts, ts = RECENT) => Array.from({ length: n }, (_, i) => att({ slug: `g${i}`, subs: ['dp.g'], fails: Array(attempts - 1).fill('wa_logic'), ts: ts - i * DAY }));
  test('needs 4 solved items in the sub-pattern and mean/expected >= 1.5', () => {
    expect(keys(habitsOf([...subItems(3, 3), ...others(8)]))).not.toContain('gap:dp.g');
    const h = habitsOf([...subItems(4, 3), ...others(8)]).find((x) => x.key === 'gap:dp.g');
    // medium baseline = (4*3 + 8*1)/12 = 1.67; 3/1.67 = 1.8
    expect(h).toMatchObject({ category: 'gap', subpattern: 'dp.g', bucket: null, tier: 'medium', live: true, statement_template: 'gap' });
    expect(h.counts).toEqual({ n: 4, mean_attempts: 3, expected: 1.67, recent_n: 4, recent_mean: 3, ratio: 1.8 });
    expect(h.evidence.examples).toHaveLength(3);
  });
  test('no gap when the sub-pattern is not slower than the baseline', () => {
    expect(keys(habitsOf([...subItems(4, 2), ...others(8, 2)]))).not.toContain('gap:dp.g');
  });
  test('stale when fewer than 2 recent solves; recent window is 180 days', () => {
    expect(WINDOW_S).toBe(180 * DAY);
    const stale = habitsOf([...subItems(4, 3, STALE), ...others(8)]).find((x) => x.key === 'gap:dp.g');
    expect(stale).toMatchObject({ live: false });
    expect(stale.counts).toMatchObject({ recent_n: 0, recent_mean: null });
    const one = habitsOf([...subItems(3, 3, STALE), ...subItems(1, 3).map((a) => ({ ...a, slug: 'g-recent' })), ...others(8)]).find((x) => x.key === 'gap:dp.g');
    expect(one.live).toBe(false);
  });
});

describe('asOf and determinism', () => {
  test('events at or after asOf are invisible', () => {
    const attempts = [att({ slug: 'a', fails: ['re_overflow', 're_overflow', 're_overflow', 're_overflow', 're_overflow'], ts: NOW + 10 }), att({ slug: 'b', fails: ['wa_logic'], ts: RECENT })];
    expect(keys(computeHabits({ attempts, asOf: NOW, seed: null }))).toEqual([]);
    expect(keys(computeHabits({ attempts, asOf: NOW + 1000, seed: null }))).toEqual(['overflow']);
  });
  test('habit keys are stable and sorted by sub-pattern', () => {
    const attempts = [
      att({ slug: 'z', subs: ['graph.z'], fails: ['tle', 'tle', 'tle', 'tle', 'tle'] }),
      att({ slug: 'a', subs: ['dp.a'], fails: ['tle', 'tle', 'tle', 'tle', 'tle'] }),
      ...Array.from({ length: 6 }, (_, i) => att({ slug: `b${i}`, fails: [] }))
    ];
    expect(keys(habitsOf(attempts))).toEqual(['bucket:dp.a:tle', 'bucket:graph.z:tle']);
    expect(JSON.stringify(habitsOf(attempts))).toBe(JSON.stringify(habitsOf(attempts.slice().reverse())));
  });
});

describe('selectRelevantHabits', () => {
  const H = {
    bucket: { key: 'bucket:dp.i:wa_edge_empty', category: 'bucket', subpattern: 'dp.i', bucket: 'wa_edge_empty', tier: 'medium', live: true },
    gap: { key: 'gap:dp.i', category: 'gap', subpattern: 'dp.i', bucket: null, tier: 'medium', live: true },
    other: { key: 'bucket:dp.k:tle', category: 'bucket', subpattern: 'dp.k', bucket: 'tle', tier: 'high', live: true },
    stale: { key: 'gap:dp.s', category: 'gap', subpattern: 'dp.s', bucket: null, tier: 'medium', live: false },
    low: { key: 'bucket:dp.i:mle_state', category: 'bucket', subpattern: 'dp.i', bucket: 'mle_state', tier: 'low', live: true },
    overflow: { key: 'overflow', category: 'overflow', subpattern: null, bucket: 're_overflow', tier: 'high', live: true }
  };
  const all = Object.values(H);
  const big = { constraints_text: '1 <= n <= 10^5, 1 <= nums[i] <= 10^9', statement_excerpt: '' };
  const small = { constraints_text: '1 <= n <= 50', statement_excerpt: 'Return the minimum cost.' };

  test('at most two, best first, ties by key', () => {
    const sel = selectRelevantHabits(all, ['dp.i'], big);
    expect(sel).toHaveLength(2);
    expect(keys(sel)).toEqual(['bucket:dp.i:wa_edge_empty', 'gap:dp.i']);
  });
  test('never stale, never dismissed, never tier low', () => {
    const sel = selectRelevantHabits(all, ['dp.i', 'dp.s'], small, { states: { 'bucket:dp.i:wa_edge_empty': 'dismissed' } });
    expect(keys(sel)).not.toContain('gap:dp.s');
    expect(keys(sel)).not.toContain('bucket:dp.i:wa_edge_empty');
    expect(keys(sel)).not.toContain('bucket:dp.i:mle_state');
    expect(keys(sel)[0]).toBe('gap:dp.i');
    expect(keys(selectRelevantHabits(all, ['dp.s'], small, { states: { 'gap:dp.s': 'confirmed' } }))).not.toContain('gap:dp.s'); // live=false wins over confirmed
    expect(keys(selectRelevantHabits(all, ['dp.i'], small, { states: { 'gap:dp.i': 'stale' } }))).not.toContain('gap:dp.i');
  });
  test('confirmed adds +1 and reorders', () => {
    expect(keys(selectRelevantHabits(all, ['dp.i'], small, { states: { 'gap:dp.i': 'confirmed' } }))).toEqual(['gap:dp.i', 'bucket:dp.i:wa_edge_empty']);
  });
  test('overflow is selected when the constraints suggest big values, but ranks below a sub-pattern match', () => {
    expect(keys(selectRelevantHabits([H.overflow, H.gap], ['dp.i'], big))).toEqual(['gap:dp.i', 'overflow']);
    expect(keys(selectRelevantHabits([H.overflow], [], { constraints_text: '', statement_excerpt: 'answer modulo 10^9 + 7' }))).toEqual(['overflow']);
  });
  // Relevance is required before any bonus counts: same sub-pattern, or the overflow habit on a big-constraint problem.
  test('overflow is NOT selected without big-constraint text', () => {
    expect(keys(selectRelevantHabits([H.overflow, H.gap], ['dp.i'], small))).toEqual(['gap:dp.i']);
  });
  test('a tier-high bucket habit of an unrelated sub-pattern is NOT selected', () => {
    expect(keys(selectRelevantHabits([H.other], ['dp.i'], small))).toEqual([]);
  });
  test('null-safe inputs', () => {
    expect(selectRelevantHabits([], null, null)).toEqual([]);
    expect(keys(selectRelevantHabits([H.gap], undefined, undefined))).toEqual([]);
  });
  test('BIG_CONSTRAINT recognises the usual phrasings', () => {
    for (const s of ['10^9', '1e9', '10 ^ 9', '1000000007', 'modulo', 'mod 1e9+7', '10^18', 'return it mod']) expect(BIG_CONSTRAINT.test(s)).toBe(true);
    for (const s of ['1 <= n <= 1000', 'model', 'modern art', '10^5']) expect(BIG_CONSTRAINT.test(s)).toBe(false);
  });
});

describe('renderStatement', () => {
  const seed = { subLabel: new Map([['dp.i', 'Interval DP']]) };
  test('overflow EN / HI, with and without the recent clause', () => {
    const h = { statement_template: 'overflow', counts: { n: 6, of: 45, recent_n: 6, recent_of: 23 } };
    expect(renderStatement(h, 'en', seed)).toBe('6 of your 45 failed submissions were integer overflow or missing-modulo errors, 6 of them in the last 6 months.');
    expect(renderStatement(h, 'hinglish', seed)).toBe('Tumhare 45 failed submissions mein se 6 integer overflow ya missing-modulo errors the, 6 pichhle 6 mahine mein.');
    const old = { statement_template: 'overflow', counts: { n: 5, of: 40, recent_n: 0, recent_of: 3 } };
    expect(renderStatement(old, 'en', seed)).toBe('5 of your 40 failed submissions were integer overflow or missing-modulo errors.');
    expect(renderStatement(old, 'hinglish', seed)).toBe('Tumhare 40 failed submissions mein se 5 integer overflow ya missing-modulo errors the.');
  });
  test('gap EN / HI use the seed label, fall back to the id', () => {
    const h = { statement_template: 'gap', subpattern: 'dp.i', counts: { n: 5, mean_attempts: 5.4, expected: 2.35, recent_n: 2, recent_mean: 4 } };
    expect(renderStatement(h, 'en', seed)).toBe('Interval DP: 5 solved at 5.4 attempts on average versus your usual 2.35 (last 6 months: 2 solved at 4).');
    expect(renderStatement(h, 'hinglish', seed)).toBe('Interval DP: 5 solve kiye, average 5.4 attempts vs tumhare usual 2.35 (pichhle 6 mahine: 2 solved, 4 attempts).');
    const stale = { ...h, counts: { ...h.counts, recent_n: 0, recent_mean: null } };
    expect(renderStatement(stale, 'en', null)).toBe('dp.i: 5 solved at 5.4 attempts on average versus your usual 2.35.');
  });
  test('bucket EN / HI translate the bucket into words', () => {
    const h = { statement_template: 'bucket', subpattern: 'dp.i', bucket: 'wa_edge_empty', counts: { n: 14, of: 15 } };
    expect(renderStatement(h, 'en', seed)).toBe('On Interval DP problems, 14 of your 15 failures were a wrong answer on a tiny input.');
    expect(renderStatement(h, 'hinglish', seed)).toBe('Interval DP problems pe tumhare 15 failures mein se 14 chhote input pe wrong answer the.');
    expect(renderStatement({ ...h, bucket: 'tle' }, 'en', seed)).toBe('On Interval DP problems, 14 of your 15 failures were a time limit.');
    expect(renderStatement({ ...h, bucket: 'weird' }, 'en', seed)).toBe('On Interval DP problems, 14 of your 15 failures were weird.');
    expect(renderStatement({ ...h, bucket: 're_overflow' }, 'hinglish', seed)).toBe('Interval DP problems pe tumhare 15 failures mein se 14 integer overflow the.');
  });
  test('any language other than hinglish renders English', () => {
    const h = { statement_template: 'overflow', counts: { n: 5, of: 40, recent_n: 0 } };
    expect(renderStatement(h, undefined, seed)).toBe(renderStatement(h, 'en', seed));
    expect(renderStatement(h, 'fr', seed)).toBe(renderStatement(h, 'en', seed));
  });
});

describe('fixture goldens', () => {
  const fx = buildFixture();
  const attempts = buildAttempts(fx.submissions, fx.problemsBySlug, fx.seedObj, { codeLookup: codeLookupFor(fx.submissions) });
  const habits = computeHabits({ attempts, asOf: FIXTURE_NOW, seed: fx.seedObj });
  const by = new Map(habits.map((h) => [h.key, h]));

  test('exactly the planted habits (plus the documented interval gap side effect), in a stable order', () => {
    expect(keys(habits)).toEqual(['overflow', 'gap:dp.interval', 'bucket:dp.interval:wa_edge_empty', 'gap:dp.kadane_max_subarray']);
  });
  test('overflow habit is live, tier high, with the planted counts', () => {
    expect(by.get('overflow')).toMatchObject({ live: true, tier: 'high', bucket: 're_overflow', counts: { n: 6, of: 45, recent_n: 6, recent_of: 23 } });
    expect(by.get('overflow').evidence.examples).toEqual(['reverse-integer', 'divide-two-integers', 'multiply-strings']);
  });
  test('interval base-case bucket habit is live with tier medium', () => {
    const h = by.get('bucket:dp.interval:wa_edge_empty');
    expect(h).toMatchObject({ live: true, tier: 'medium', bucket: 'wa_edge_empty', subpattern: 'dp.interval', counts: { n: 14, of: 15, share: 0.93, recent_n: 14 } });
    for (const s of h.evidence.examples) expect(PLANTED.interval).toContain(s);
  });
  test('Kadane gap is present but stale', () => {
    const h = by.get('gap:dp.kadane_max_subarray');
    expect(h).toMatchObject({ live: false, tier: 'medium', counts: { n: 5, mean_attempts: 5.4, expected: 2.35, recent_n: 0, recent_mean: null, ratio: 2.3 } });
    for (const s of h.evidence.examples) expect(PLANTED.kadane).toContain(s);
  });
  test('invariants hold for other seeds', () => {
    for (const seed of [1, 3, 42, 99]) {
      const f = buildFixture({ seed });
      const hs = computeHabits({ attempts: buildAttempts(f.submissions, f.problemsBySlug, f.seedObj, { codeLookup: codeLookupFor(f.submissions) }), asOf: FIXTURE_NOW, seed: f.seedObj });
      const m = new Map(hs.map((h) => [h.key, h]));
      expect(keys(hs)).toEqual(['overflow', 'gap:dp.interval', 'bucket:dp.interval:wa_edge_empty', 'gap:dp.kadane_max_subarray']);
      expect(m.get('overflow').live).toBe(true);
      expect(m.get('bucket:dp.interval:wa_edge_empty')).toMatchObject({ live: true, tier: 'medium' });
      expect(m.get('bucket:dp.interval:wa_edge_empty').counts.share).toBeGreaterThanOrEqual(0.6);
      expect(m.get('gap:dp.kadane_max_subarray').live).toBe(false);
    }
  });
  test('deterministic across runs', () => {
    expect(JSON.stringify(computeHabits({ attempts, asOf: FIXTURE_NOW, seed: fx.seedObj }))).toBe(JSON.stringify(habits));
  });
  test('an asOf before the recent activity sees none of the live habits', () => {
    const past = computeHabits({ attempts, asOf: FIXTURE_NOW - 200 * DAY, seed: fx.seedObj });
    expect(keys(past)).not.toContain('overflow');
    expect(keys(past).some((k) => k.includes('dp.interval'))).toBe(false);
  });
  test('selection for an interval target: the two interval habits, never the stale Kadane gap', () => {
    const subs = fx.seedObj.subpatternsOf('minimum-cost-to-cut-a-stick').map((m) => m.id);
    const sel = selectRelevantHabits(habits, subs, { constraints_text: '1 <= n <= 100', statement_excerpt: '' });
    expect(keys(sel)).toEqual(['bucket:dp.interval:wa_edge_empty', 'gap:dp.interval']);
    const dismissed = selectRelevantHabits(habits, subs, { constraints_text: '' }, { states: { 'bucket:dp.interval:wa_edge_empty': 'dismissed' } });
    expect(dismissed.length).toBeLessThanOrEqual(2);
    expect(keys(dismissed)[0]).toBe('gap:dp.interval');
    expect(keys(dismissed)).not.toContain('bucket:dp.interval:wa_edge_empty');
    for (const s of [sel, dismissed]) { expect(keys(s)).not.toContain('gap:dp.kadane_max_subarray'); expect(s.every((h) => h.live && h.tier !== 'low')).toBe(true); }
  });
  test('rendered statements for the planted habits (EN + HI)', () => {
    expect(renderStatement(by.get('overflow'), 'en', fx.seedObj)).toBe('6 of your 45 failed submissions were integer overflow or missing-modulo errors, 6 of them in the last 6 months.');
    expect(renderStatement(by.get('bucket:dp.interval:wa_edge_empty'), 'en', fx.seedObj)).toBe('On Interval DP over [i..j] problems, 14 of your 15 failures were a wrong answer on a tiny input.');
    expect(renderStatement(by.get('bucket:dp.interval:wa_edge_empty'), 'hinglish', fx.seedObj)).toBe('Interval DP over [i..j] problems pe tumhare 15 failures mein se 14 chhote input pe wrong answer the.');
    expect(renderStatement(by.get('gap:dp.kadane_max_subarray'), 'en', fx.seedObj)).toBe('Kadane-style running best subarray ending here: 5 solved at 5.4 attempts on average versus your usual 2.35.');
  });
});
