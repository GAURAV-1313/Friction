'use strict';
const { levelOf, familyLevel, skillSummary, WEIGHT } = require('../../src/lc/domain/skill');
const { DP_TAGS, GRAPH_TAGS, UMBRELLA } = require('../../src/lc/domain/constants');
const { buildAttempts } = require('../../src/lc/domain/attempts');
const { buildFixture, codeLookupFor, FIXTURE_NOW } = require('./fixtures/buildFixture');

const NOW = 1789171200;
let n = 0;
const att = (difficulty, tags, o = {}) => ({ slug: o.slug || `s${++n}`, title: o.title || `T${n}`, difficulty, tags, solved: o.solved !== false, first_ac_ts: o.first_ac_ts ?? NOW - 1000 - n, attempts_to_ac: 1 });
const many = (count, difficulty, tags) => Array.from({ length: count }, () => att(difficulty, tags));

describe('levelOf boundaries', () => {
  test.each([
    [null, 'new'],
    [{ solved: 0, w: 0, hard: 0 }, 'new'],
    [{ solved: 12, w: 12, hard: 0 }, 'learning'],
    [{ solved: 13, w: 13, hard: 0 }, 'solid'],
    [{ solved: 15, w: 30, hard: 0 }, 'solid'],
    [{ solved: 16, w: 31, hard: 0 }, 'strong'],
    [{ solved: 1, w: 4, hard: 1 }, 'learning'],
    [{ solved: 2, w: 8, hard: 2 }, 'solid'],
    [{ solved: 4, w: 16, hard: 4 }, 'solid'],
    [{ solved: 5, w: 20, hard: 5 }, 'strong']
  ])('levelOf(%j) -> %s', (c, expected) => { expect(levelOf(c)).toBe(expected); });
  test('weights are easy 1 / medium 2 / hard 4', () => { expect(WEIGHT).toEqual({ easy: 1, medium: 2, hard: 4 }); });
});

describe('familyLevel', () => {
  test('w 12 vs 13 (easy problems)', () => {
    expect(familyLevel(many(12, 'easy', ['dynamic-programming']), DP_TAGS, 'dp').level).toBe('learning');
    expect(familyLevel(many(13, 'easy', ['dynamic-programming']), DP_TAGS, 'dp').level).toBe('solid');
  });
  test('w 30 vs 31 (mediums)', () => {
    expect(familyLevel(many(15, 'medium', ['graph']), GRAPH_TAGS, 'graphs').level).toBe('solid');
    expect(familyLevel([...many(15, 'medium', ['graph']), att('easy', ['graph'])], GRAPH_TAGS, 'graphs').level).toBe('strong');
  });
  test('hard 2 -> solid, hard 5 -> strong, regardless of weight', () => {
    expect(familyLevel(many(2, 'hard', ['dijkstra']), GRAPH_TAGS, 'graphs')).toMatchObject({ level: 'solid', solved: 2, hard: 2 });
    expect(familyLevel(many(5, 'hard', ['dijkstra']), GRAPH_TAGS, 'graphs')).toMatchObject({ level: 'strong', solved: 5, hard: 5 });
    expect(familyLevel(many(1, 'hard', ['dijkstra']), GRAPH_TAGS, 'graphs').level).toBe('learning');
  });
  test('tags outside the family are ignored; sample is the last three titles by first AC', () => {
    const items = [att('easy', ['array']), att('medium', ['knapsack-problem'], { title: 'K1', first_ac_ts: 10 }), att('medium', ['bitmask'], { title: 'K2', first_ac_ts: 30 }), att('hard', ['memoization'], { title: 'K3', first_ac_ts: 20 }), att('easy', ['dp-on-trees'], { title: 'K4', first_ac_ts: 40 })];
    const f = familyLevel(items, DP_TAGS, 'dynamic programming');
    expect(f).toEqual({ label: 'dynamic programming', level: 'learning', solved: 4, hard: 1, sample: ['K3', 'K2', 'K4'] });
    expect(familyLevel([att('easy', ['array'])], DP_TAGS, 'dp')).toMatchObject({ level: 'new', solved: 0, sample: [] });
  });
});

describe('skillSummary bands', () => {
  test('29 solved -> beginner, 30 -> intermediate', () => {
    expect(skillSummary(many(29, 'medium', ['array'])).band).toBe('beginner');
    expect(skillSummary(many(30, 'medium', ['array'])).band).toBe('intermediate');
  });
  test('advanced needs 150 solved AND 10 hard', () => {
    expect(skillSummary([...many(140, 'medium', ['array']), ...many(10, 'hard', ['array'])]).band).toBe('advanced');
    expect(skillSummary([...many(141, 'medium', ['array']), ...many(9, 'hard', ['array'])]).band).toBe('intermediate');
    expect(skillSummary([...many(139, 'medium', ['array']), ...many(10, 'hard', ['array'])]).band).toBe('intermediate');
  });
  test('cold_start: none / thin (<=20) / ok', () => {
    expect(skillSummary([]).cold_start).toBe('none');
    expect(skillSummary(many(20, 'easy', ['array'])).cold_start).toBe('thin');
    expect(skillSummary(many(21, 'easy', ['array'])).cold_start).toBe('ok');
  });
});

describe('skillSummary contents', () => {
  test('strengths exclude umbrella tags, sort by weight then tag, cap at 4', () => {
    const items = [
      ...many(3, 'hard', ['array', 'dynamic-programming', 'knapsack-problem', '0-1-knapsack']),
      ...many(2, 'medium', ['graph', 'dijkstra', 'heap-priority-queue']),
      att('easy', ['string', 'trie']),
      att('easy', ['math', 'bit-manipulation'])
    ];
    const s = skillSummary(items);
    expect(s.strengths).toEqual([{ tag: '0-1-knapsack', solved: 3 }, { tag: 'knapsack-problem', solved: 3 }, { tag: 'dijkstra', solved: 2 }, { tag: 'heap-priority-queue', solved: 2 }]);
    for (const st of s.strengths) expect(UMBRELLA.has(st.tag)).toBe(false);
  });
  test('tag_levels covers every tag, umbrella included', () => {
    const s = skillSummary([...many(13, 'easy', ['array', 'prefix-sum']), att('hard', ['array'])]);
    expect(s.tag_levels['prefix-sum']).toEqual({ level: 'solid', solved: 13 });
    expect(s.tag_levels.array).toEqual({ level: 'solid', solved: 14 }); // w = 13 + 4 = 17, hard 1 -> solid
  });
  test('counts, dp/graph families and gaps', () => {
    const s = skillSummary([...many(31, 'easy', ['array']), att('medium', ['dynamic-programming'])]);
    expect(s.counts).toEqual({ easy: 31, medium: 1, hard: 0 });
    expect(s.dp).toMatchObject({ label: 'dynamic programming', level: 'learning', solved: 1 });
    expect(s.graph).toMatchObject({ label: 'graphs', level: 'new', solved: 0 });
    expect(s.gaps).toEqual(['dp', 'graph']);
    expect(s.version).toBe('v0');
  });
  test('gaps are not reported for beginners', () => {
    expect(skillSummary(many(5, 'easy', ['array'])).gaps).toEqual([]);
  });
  test('asOf excludes solves at or after the cut-off and unsolved items', () => {
    const items = [att('easy', ['array'], { first_ac_ts: 100 }), att('easy', ['array'], { first_ac_ts: 200 }), att('easy', ['array'], { first_ac_ts: 300 }), att('easy', ['array'], { solved: false, first_ac_ts: null })];
    expect(skillSummary(items, 200)).toMatchObject({ solved: 1, computed_at: 200 });
    expect(skillSummary(items, 301)).toMatchObject({ solved: 3, computed_at: 301 });
    expect(skillSummary(items)).toMatchObject({ solved: 3, computed_at: null });
    expect(skillSummary(items, null).solved).toBe(3);
  });
});

describe('fixture golden', () => {
  test('summary for the synthetic student', () => {
    const fx = buildFixture();
    const attempts = buildAttempts(fx.submissions, fx.problemsBySlug, fx.seedObj, { codeLookup: codeLookupFor(fx.submissions) });
    const s = skillSummary(attempts, FIXTURE_NOW);
    expect(s).toMatchObject({
      version: 'v0', computed_at: FIXTURE_NOW, band: 'intermediate', solved: 38, counts: { easy: 3, medium: 23, hard: 12 },
      dp: { label: 'dynamic programming', level: 'strong', solved: 19, hard: 8 },
      graph: { label: 'graphs', level: 'strong', solved: 14, hard: 6 },
      strengths: [{ tag: 'dijkstra', solved: 7 }, { tag: 'heap-priority-queue', solved: 7 }, { tag: '0-1-knapsack', solved: 7 }, { tag: 'knapsack-problem', solved: 7 }],
      gaps: [], cold_start: 'ok'
    });
    expect(s.tag_levels.dijkstra).toEqual({ level: 'solid', solved: 7 });
    expect(s.tag_levels['topological-sort']).toEqual({ level: 'solid', solved: 7 });
    expect(s.dp.sample).toHaveLength(3);
    // a cut-off before the interval/anchor activity shrinks the picture to the old solves only
    expect(skillSummary(attempts, FIXTURE_NOW - 190 * 86400)).toMatchObject({ band: 'beginner', solved: 8 }); // 5 Kadane + 3 easy fillers
  });
});
