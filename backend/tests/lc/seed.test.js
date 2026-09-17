'use strict';
const path = require('path');
const { loadSeed, familiesOf, normDiff } = require('../../src/lc/domain/seed');
const { DP_TAGS, GRAPH_TAGS } = require('../../src/lc/domain/constants');

const raw = require('../../src/lc/data/subpatterns.json');
const catalog = require('../../src/lc/data/catalog.json');

describe('shipped seed data', () => {
  const seed = loadSeed();

  test('116 sub-patterns, 1338 verified problems, catalog of 4047', () => {
    expect(raw.subpatterns).toHaveLength(116);
    expect(seed.subLabel.size).toBe(116);
    expect(seed.membership.size).toBe(1338);
    expect(seed.catalogBySlug.size).toBe(4047);
    expect(catalog.problems).toHaveLength(4047);
    expect(catalog.tags).toHaveLength(175);
    expect(seed.version).toBe(raw.version || 'v0');
  });

  // A problem can legitimately be primary in two FAMILIES -- jump-game is the main idea
  // of both dp.1d_linear and greedy.reach_frontier, and longest-valid-parentheses has both
  // the DP and the stack solution. What must never happen is two primaries inside one
  // family, because then the problem would have two "main ideas" in the same vocabulary.
  test('at most one primary sub-pattern per slug within a family', () => {
    for (const [slug, members] of seed.membership) {
      const perFamily = {};
      for (const m of members.filter((x) => x.primary)) perFamily[m.family] = (perFamily[m.family] || 0) + 1;
      for (const [family, n] of Object.entries(perFamily)) expect({ slug, family, n }).toEqual({ slug, family, n: 1 });
      // A slug may have NO primary anywhere: sort-list uses fast/slow pointers only to
      // find the midpoint, so it is secondary in every sub-pattern it belongs to.
      // primarySub() then falls back to the first membership.
      const primary = members.find((m) => m.primary);
      expect(seed.primarySub(slug)).toEqual(primary || members[0]);
    }
  });

  test('every sub-pattern has a label, a family matching its id prefix, and canonical problems', () => {
    const families = new Set(raw.subpatterns.map((s) => s.id.split('.')[0]));
    expect(families.size).toBe(20);
    expect(families.has('dp')).toBe(true);
    expect(families.has('graph')).toBe(true);
    for (const s of raw.subpatterns) {
      expect(seed.subLabel.get(s.id)).toBeTruthy();
      expect(seed.subFamily.get(s.id)).toBe(s.id.split('.')[0]);
      expect(Array.isArray(seed.canonical.get(s.id))).toBe(true);
      expect(seed.canonical.get(s.id).length).toBeGreaterThan(0);
      // the label is rendered verbatim after "same idea: ", so it must not end in a period
      expect(seed.subLabel.get(s.id).endsWith('.')).toBe(false);
    }
  });

  test('membership entries carry id, primary, family and confidence; unverified rows are excluded', () => {
    for (const [, members] of seed.membership) for (const m of members) {
      expect(m).toEqual({ id: expect.any(String), primary: expect.any(Boolean), family: expect.stringMatching(/^[a-z_]+$/), confidence: expect.stringMatching(/^(high|medium|low)$/) });
    }
    for (const s of raw.subpatterns) for (const p of s.problems) if (p.verified === false) {
      expect((seed.membership.get(p.slug) || []).some((m) => m.id === s.id)).toBe(false);
    }
  });

  test('every seeded slug resolves in the catalog with a normalised difficulty', () => {
    for (const slug of seed.membership.keys()) {
      const c = seed.problemFromCatalog(slug);
      expect(c).not.toBeNull();
      expect(['easy', 'medium', 'hard']).toContain(c.difficulty);
      expect(Array.isArray(c.tags)).toBe(true);
    }
  });

  test('catalog entries are normalised', () => {
    expect(seed.problemFromCatalog('two-sum')).toEqual({ slug: 'two-sum', title: 'Two Sum', frontendId: '1', difficulty: 'easy', paid: false, tags: ['array', 'hash-table'] });
    expect(seed.problemFromCatalog('not-a-real-slug')).toBeNull();
  });

  test('lookups for a known problem', () => {
    expect(seed.subpatternsOf('coin-change')).toEqual([{ id: 'dp.knapsack_unbounded', primary: true, family: 'dp', confidence: 'high' }]);
    expect(seed.primarySub('coin-change').id).toBe('dp.knapsack_unbounded');
    // two-sum used to resolve to nothing at all, which is why it could never be anchored
    expect(seed.subpatternsOf('two-sum')).toEqual([{ id: 'hashing.complement_lookup', primary: true, family: 'hashing', confidence: 'high' }]);
    expect(seed.primarySub('two-sum').id).toBe('hashing.complement_lookup');
    expect(seed.subpatternsOf('not-a-real-slug')).toEqual([]);
    expect(seed.primarySub('not-a-real-slug')).toBeNull();
    expect(seed.subLabel.get('dp.interval')).toBe('Interval DP over [i..j]');
    expect(seed.subLabel.get('dp.kadane_max_subarray')).toBe('Kadane-style running best subarray ending here');
  });

  test('loadSeed() is cached; explicit paths bypass the cache', () => {
    expect(loadSeed()).toBe(seed);
    const fresh = loadSeed({ subpatternsPath: path.join(__dirname, '..', '..', 'src', 'lc', 'data', 'subpatterns.json') });
    expect(fresh).not.toBe(seed);
    expect(fresh.membership.size).toBe(1338);
    expect(loadSeed()).toBe(seed);
  });
});

describe('familiesOf / normDiff', () => {
  test('familiesOf uses the DP and graph tag sets', () => {
    expect(familiesOf(['array'])).toEqual([]);
    expect(familiesOf(['dynamic-programming'])).toEqual(['dp']);
    expect(familiesOf(['dijkstra'])).toEqual(['graph']);
    expect(familiesOf(['knapsack-problem', 'topological-sort'])).toEqual(['dp', 'graph']);
    expect(familiesOf(null)).toEqual([]);
    expect(familiesOf(undefined)).toEqual([]);
    expect([...DP_TAGS].every((t) => familiesOf([t]).includes('dp'))).toBe(true);
    expect([...GRAPH_TAGS].every((t) => familiesOf([t]).includes('graph'))).toBe(true);
  });
  test('normDiff', () => {
    expect(normDiff('Hard')).toBe('hard');
    expect(normDiff('MEDIUM')).toBe('medium');
    expect(normDiff('easy')).toBe('easy');
    expect(normDiff('Expert')).toBeNull();
    expect(normDiff(null)).toBeNull();
    expect(normDiff(undefined)).toBeNull();
    expect(normDiff('')).toBeNull();
  });
});
