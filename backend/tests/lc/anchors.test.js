'use strict';
const { scoreAnchors } = require('../../src/lc/domain/anchors');
const { ANCHOR_MIN_SCORE, WINDOW_S } = require('../../src/lc/domain/constants');
const { buildAttempts } = require('../../src/lc/domain/attempts');
const { buildFixture, codeLookupFor, FIXTURE_NOW, PLANTED, TARGET_SLUGS } = require('./fixtures/buildFixture');

const NOW = 1789171200;
const DAY = 86400;
const OLD = NOW - 400 * DAY;     // outside the 180-day recency window
const RECENT = NOW - 10 * DAY;

// Minimal seed double: only subpatternsOf and subLabel are consulted by scoreAnchors.
function fakeSeed(members, labels = {}) {
  const membership = new Map(Object.entries(members).map(([slug, subs]) => [slug, subs.map((s) => (typeof s === 'string' ? { id: s, primary: true } : s))]));
  return { membership, subLabel: new Map(Object.entries(labels)), subpatternsOf: (slug) => membership.get(slug) || [] };
}
const att = (o) => ({ slug: o.slug, title: o.title || o.slug, difficulty: o.difficulty === undefined ? 'medium' : o.difficulty, tags: o.tags || [], solved: o.solved !== false, first_ac_ts: o.first_ac_ts === undefined ? OLD : o.first_ac_ts, attempts_to_ac: o.attempts_to_ac ?? 2, first_ac_id: o.first_ac_id ?? 100 });
const target = (o = {}) => ({ slug: 't', tags: [], difficulty: 'medium', ...o });
const score = (res) => res.anchors.map((a) => a.score);

describe('score terms', () => {
  test('shared seed sub-pattern: +3 (non-primary on one side)', () => {
    const seed = fakeSeed({ t: ['x'], c: [{ id: 'x', primary: false }] }, { x: 'X label' });
    const res = scoreAnchors({ target: target(), solvedAttempts: [att({ slug: 'c' })], asOf: NOW, seed });
    expect(score(res)).toEqual([3]);
    expect(res.anchors[0]).toMatchObject({ why: 'same idea: X label', subpattern: 'x', fine_tag: null });
  });
  test('primary/primary adds +1', () => {
    const seed = fakeSeed({ t: ['x'], c: ['x'] });
    expect(score(scoreAnchors({ target: target(), solvedAttempts: [att({ slug: 'c' })], asOf: NOW, seed }))).toEqual([4]);
  });
  test('shared fine tag: +2, and the fine tag itself also counts as a +0.5 specific tag', () => {
    const seed = fakeSeed({});
    const res = scoreAnchors({ target: target({ tags: ['dijkstra'] }), solvedAttempts: [att({ slug: 'c', tags: ['dijkstra'] })], asOf: NOW, seed, minScore: 0 });
    expect(score(res)).toEqual([2.5]);
    expect(res.anchors[0]).toMatchObject({ why: "shares LeetCode's dijkstra tag", subpattern: null, fine_tag: 'dijkstra' });
  });
  test('+0.5 per shared specific tag; umbrella tags do not count', () => {
    const seed = fakeSeed({ t: ['x'], c: ['x'] });
    const tags = ['array', 'dynamic-programming', 'prefix-sum', 'monotonic-stack'];
    expect(score(scoreAnchors({ target: target({ tags }), solvedAttempts: [att({ slug: 'c', tags })], asOf: NOW, seed }))).toEqual([5]);
  });
  test('+0.5 recency inside the 180-day window (strict)', () => {
    const seed = fakeSeed({ t: ['x'], c: ['x'] });
    const at = (ts) => score(scoreAnchors({ target: target(), solvedAttempts: [att({ slug: 'c', first_ac_ts: ts })], asOf: NOW, seed }))[0];
    expect(at(NOW - WINDOW_S + 1)).toBe(4.5);
    expect(at(NOW - WINDOW_S)).toBe(4);
  });
  test('+0.2 for a first-try solve', () => {
    const seed = fakeSeed({ t: ['x'], c: ['x'] });
    expect(score(scoreAnchors({ target: target(), solvedAttempts: [att({ slug: 'c', attempts_to_ac: 1 })], asOf: NOW, seed }))).toEqual([4.2]);
  });
  test('-0.5 when the difficulty gap is two steps, either direction', () => {
    const seed = fakeSeed({ t: ['x'], c: ['x'] });
    const s = (td, cd) => score(scoreAnchors({ target: target({ difficulty: td }), solvedAttempts: [att({ slug: 'c', difficulty: cd })], asOf: NOW, seed }))[0];
    expect(s('hard', 'easy')).toBe(3.5);
    expect(s('easy', 'hard')).toBe(3.5);
    expect(s('hard', 'medium')).toBe(4);
    expect(s('medium', 'easy')).toBe(4);
    expect(s(undefined, 'easy')).toBe(4);   // unknown target difficulty ranks as medium
    expect(s('hard', null)).toBe(4);        // unknown candidate difficulty ranks as medium
    expect(s('Hard', 'easy')).toBe(3.5);    // target difficulty is case-insensitive
    expect(s('hard', 'EASY')).toBe(4);      // candidate difficulty is not lowercased (attempts carry normalised difficulty by contract), so 'EASY' ranks as medium
  });
  test('all terms together', () => {
    const seed = fakeSeed({ t: ['x'], c: ['x'] });
    const tags = ['dijkstra', 'heap-priority-queue', 'graph'];
    const res = scoreAnchors({ target: target({ tags, difficulty: 'hard' }), solvedAttempts: [att({ slug: 'c', tags, difficulty: 'easy', first_ac_ts: RECENT, attempts_to_ac: 1 })], asOf: NOW, seed });
    // 3 + 1 + 2 + 0.5*2 + 0.5 + 0.2 - 0.5
    expect(score(res)).toEqual([7.2]);
  });
});

describe('eligibility gate', () => {
  test('no seed overlap and no fine tag -> no_eligible even with specific-tag overlap and similar_slugs', () => {
    const seed = fakeSeed({ t: ['x'], c: ['y'] });
    const res = scoreAnchors({ target: target({ tags: ['array', 'prefix-sum'], similar_slugs: ['c'] }), solvedAttempts: [att({ slug: 'c', tags: ['array', 'prefix-sum'] })], asOf: NOW, seed });
    expect(res).toEqual({ anchors: [], omitted_reason: 'no_eligible' });
  });
  test('the target itself is never an anchor', () => {
    const seed = fakeSeed({ t: ['x'] });
    expect(scoreAnchors({ target: target(), solvedAttempts: [att({ slug: 't' })], asOf: NOW, seed })).toEqual({ anchors: [], omitted_reason: 'no_eligible' });
  });
  test('unsolved attempts and solves at/after asOf are excluded', () => {
    const seed = fakeSeed({ t: ['x'], a: ['x'], b: ['x'], c: ['x'] });
    const res = scoreAnchors({ target: target(), solvedAttempts: [att({ slug: 'a', solved: false }), att({ slug: 'b', first_ac_ts: NOW }), att({ slug: 'c', first_ac_ts: NOW + 1 })], asOf: NOW, seed });
    expect(res.omitted_reason).toBe('no_eligible');
  });
  test('empty solved list', () => {
    expect(scoreAnchors({ target: target(), solvedAttempts: [], asOf: NOW, seed: fakeSeed({}) })).toEqual({ anchors: [], omitted_reason: 'no_eligible' });
  });
});

describe('threshold and limit', () => {
  test('ANCHOR_MIN_SCORE is 3 and a best score below it yields below_threshold', () => {
    expect(ANCHOR_MIN_SCORE).toBe(3);
    const seed = fakeSeed({});
    const res = scoreAnchors({ target: target({ tags: ['dijkstra'] }), solvedAttempts: [att({ slug: 'c', tags: ['dijkstra'] })], asOf: NOW, seed });
    expect(res).toEqual({ anchors: [], omitted_reason: 'below_threshold' });
  });
  test('a score of exactly 3 is offered', () => {
    const seed = fakeSeed({});
    const res = scoreAnchors({ target: target({ tags: ['dijkstra'] }), solvedAttempts: [att({ slug: 'c', tags: ['dijkstra'], first_ac_ts: RECENT })], asOf: NOW, seed });
    expect(score(res)).toEqual([3]);
    expect(res.omitted_reason).toBeNull();
  });
  test('candidates below the threshold are dropped from the top list, others kept', () => {
    const seed = fakeSeed({ t: ['x'], a: ['x'], b: [{ id: 'x', primary: false }] });
    const solved = [att({ slug: 'a' }), att({ slug: 'b' }), att({ slug: 'c', tags: ['dijkstra'] })];
    const res = scoreAnchors({ target: target({ tags: ['dijkstra'] }), solvedAttempts: solved, asOf: NOW, seed });
    expect(res.anchors.map((x) => [x.slug, x.score])).toEqual([['a', 4], ['b', 3]]);
    expect(res.omitted_reason).toBeNull();
    expect(scoreAnchors({ target: target({ tags: ['dijkstra'] }), solvedAttempts: solved, asOf: NOW, seed, minScore: 2 }).anchors.map((x) => x.slug)).toEqual(['a', 'b', 'c']);
  });
  test('top-3 by default, limit is honoured', () => {
    const seed = fakeSeed({ t: ['x'], a: ['x'], b: ['x'], c: ['x'], d: ['x'], e: ['x'] });
    const solved = ['a', 'b', 'c', 'd', 'e'].map((slug, i) => att({ slug, first_ac_ts: OLD + i * DAY }));
    expect(scoreAnchors({ target: target(), solvedAttempts: solved, asOf: NOW, seed }).anchors).toHaveLength(3);
    expect(scoreAnchors({ target: target(), solvedAttempts: solved, asOf: NOW, seed, limit: 5 }).anchors).toHaveLength(5);
    expect(scoreAnchors({ target: target(), solvedAttempts: solved, asOf: NOW, seed, limit: 1 }).anchors).toHaveLength(1);
  });
});

describe('ordering and tie-break', () => {
  test('score desc, then solved_on desc, then slug asc; deterministic under input permutation', () => {
    const seed = fakeSeed({ t: ['x'], a: ['x'], b: ['x'], c: ['x'], d: ['x'], e: ['x'], f: ['x'] });
    const solved = [
      att({ slug: 'f', first_ac_ts: OLD, attempts_to_ac: 1 }),          // 4.2, highest score
      att({ slug: 'b', first_ac_ts: OLD + 5 * DAY }),                   // 4, newest date
      att({ slug: 'e', first_ac_ts: OLD + 5 * DAY + 3600 }),            // 4, same date as b -> slug asc
      att({ slug: 'a', first_ac_ts: OLD + 5 * DAY + 7200 }),            // 4, same date -> 'a' first
      att({ slug: 'c', first_ac_ts: OLD }),                             // 4, older
      att({ slug: 'd', first_ac_ts: OLD + DAY })                        // 4
    ];
    const expected = ['f', 'a', 'b', 'e', 'd', 'c'];
    const res = scoreAnchors({ target: target(), solvedAttempts: solved, asOf: NOW, seed, limit: 10 });
    expect(res.anchors.map((x) => x.slug)).toEqual(expected);
    const res2 = scoreAnchors({ target: target(), solvedAttempts: solved.slice().reverse(), asOf: NOW, seed, limit: 10 });
    expect(res2.anchors.map((x) => x.slug)).toEqual(expected);
    expect(res.anchors.slice(0, 3).map((x) => x.slug)).toEqual(scoreAnchors({ target: target(), solvedAttempts: solved, asOf: NOW, seed }).anchors.map((x) => x.slug));
  });
});

describe('anchor record shape', () => {
  test('fields, ISO solved_on and rounded score', () => {
    const seed = fakeSeed({ t: ['x'], c: [{ id: 'x', primary: false }] }, { x: 'Label' });
    const res = scoreAnchors({ target: target({ tags: ['prefix-sum', 'dijkstra'] }), solvedAttempts: [att({ slug: 'c', title: 'C title', difficulty: 'hard', tags: ['prefix-sum', 'dijkstra'], first_ac_ts: 1767225600, attempts_to_ac: 3, first_ac_id: 987 })], asOf: NOW, seed });
    expect(res.anchors[0]).toEqual({ slug: 'c', title: 'C title', difficulty: 'hard', score: 6, why: 'same idea: Label', subpattern: 'x', fine_tag: 'dijkstra', solved_on: '2026-01-01', attempts_to_ac: 3, first_ac_submission_id: 987 });
  });
  test('scores are rounded to two decimals', () => {
    const seed = fakeSeed({ t: ['x'], c: ['x'] });
    const res = scoreAnchors({ target: target({ tags: ['a1', 'a2', 'a3'] }), solvedAttempts: [att({ slug: 'c', tags: ['a1', 'a2', 'a3'], attempts_to_ac: 1, first_ac_ts: RECENT })], asOf: NOW, seed });
    expect(res.anchors[0].score).toBe(6.2);
    expect(String(res.anchors[0].score).length).toBeLessThanOrEqual(4);
  });
});

describe('fixture goldens (real seed)', () => {
  const fx = buildFixture();
  const attempts = buildAttempts(fx.submissions, fx.problemsBySlug, fx.seedObj, { codeLookup: codeLookupFor(fx.submissions) });
  const run = (slug) => { const p = fx.seedObj.problemFromCatalog(slug); return scoreAnchors({ target: { slug, tags: p.tags, difficulty: p.difficulty }, solvedAttempts: attempts, asOf: FIXTURE_NOW, seed: fx.seedObj }); };

  test('interval target: three seed anchors tied at 4.5, ordered by most recent solve', () => {
    const res = run('minimum-cost-to-cut-a-stick');
    expect(res.omitted_reason).toBeNull();
    expect(res.anchors.map((a) => [a.slug, a.score, a.subpattern, a.solved_on])).toEqual([
      ['count-different-palindromic-subsequences', 4.5, 'dp.interval', '2026-08-21'],
      ['minimum-score-triangulation-of-polygon', 4.5, 'dp.interval', '2026-07-20'],
      ['minimum-cost-to-merge-stones', 4.5, 'dp.interval', '2026-06-18']
    ]);
    for (const a of res.anchors) { expect(a.why).toBe('same idea: Interval DP over [i..j]'); expect(PLANTED.interval).toContain(a.slug); }
  });
  test('coin-change: no seed overlap, anchors come through the knapsack-problem fine tag at 3.2', () => {
    const res = run('coin-change');
    expect(res.omitted_reason).toBeNull();
    expect(res.anchors.map((a) => [a.slug, a.score, a.fine_tag])).toEqual([
      ['tallest-billboard', 3.2, 'knapsack-problem'], ['profitable-schemes', 3.2, 'knapsack-problem'], ['length-of-the-longest-subsequence-that-sums-to-target', 3.2, 'knapsack-problem']
    ]);
    for (const a of res.anchors) { expect(a.subpattern).toBeNull(); expect(a.why).toBe("shares LeetCode's knapsack-problem tag"); expect(PLANTED.first_try['dp.knapsack_01']).toContain(a.slug); }
  });
  test('Dijkstra target: seed + fine tag + three specific tags + recency + first try = 8.2', () => {
    const res = run('path-with-maximum-probability');
    expect(res.anchors.map((a) => [a.slug, a.score])).toEqual([['minimum-obstacle-removal-to-reach-corner', 8.2], ['reachable-nodes-in-subdivided-graph', 8.2], ['the-maze-ii', 8.2]]);
    expect(res.anchors[0]).toMatchObject({ subpattern: 'graph.dijkstra', fine_tag: 'shortest-path', attempts_to_ac: 1, difficulty: 'hard' });
  });
  test('an unrelated target has no eligible anchors', () => {
    expect(run('two-sum')).toEqual({ anchors: [], omitted_reason: 'no_eligible' });
  });
  test('every offered anchor scores at least the threshold and is never the target', () => {
    for (const slug of TARGET_SLUGS) for (const a of run(slug).anchors) { expect(a.score).toBeGreaterThanOrEqual(ANCHOR_MIN_SCORE); expect(a.slug).not.toBe(slug); }
  });
  test('a solved target is excluded from its own anchors', () => {
    const res = run('burst-balloons');
    expect(res.anchors.map((a) => a.slug)).not.toContain('burst-balloons');
    expect(res.anchors).toHaveLength(3);
  });
});
