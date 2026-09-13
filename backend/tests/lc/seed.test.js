'use strict';
const path = require('path');
const { loadSeed, familiesOf, normDiff } = require('../../src/lc/domain/seed');
const { DP_TAGS, GRAPH_TAGS } = require('../../src/lc/domain/constants');

const raw = require('../../src/lc/data/subpatterns.json');
const catalog = require('../../src/lc/data/catalog.json');

describe('shipped seed data', () => {
  const seed = loadSeed();

  test('30 sub-patterns, 535 verified problems, catalog of 4047', () => {
    expect(raw.subpatterns).toHaveLength(30);
    expect(seed.subLabel.size).toBe(30);
    expect(seed.membership.size).toBe(535);
    expect(seed.catalogBySlug.size).toBe(4047);
    expect(catalog.problems).toHaveLength(4047);
    expect(catalog.tags).toHaveLength(175);
    expect(seed.version).toBe(raw.version || 'v0');
  });

  test('exactly one primary sub-pattern per slug', () => {
    for (const [slug, members] of seed.membership) {
      expect({ slug, primaries: members.filter((m) => m.primary).length }).toEqual({ slug, primaries: 1 });
      expect(seed.primarySub(slug).primary).toBe(true);
    }
  });

  test('every sub-pattern has a label, a dp|graph family and canonical problems', () => {
    for (const s of raw.subpatterns) {
      expect(seed.subLabel.get(s.id)).toBeTruthy();
      expect(['dp', 'graph']).toContain(seed.subFamily.get(s.id));
      expect(seed.subFamily.get(s.id)).toBe(s.id.split('.')[0]);
      expect(Array.isArray(seed.canonical.get(s.id))).toBe(true);
    }
  });

  test('membership entries carry id, primary, family and confidence; unverified rows are excluded', () => {
    for (const [, members] of seed.membership) for (const m of members) {
      expect(m).toEqual({ id: expect.any(String), primary: expect.any(Boolean), family: expect.stringMatching(/^(dp|graph)$/), confidence: expect.any(String) });
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
    expect(seed.subpatternsOf('two-sum')).toEqual([]);
    expect(seed.primarySub('two-sum')).toBeNull();
    expect(seed.subLabel.get('dp.interval')).toBe('Interval DP over [i..j]');
    expect(seed.subLabel.get('dp.kadane_max_subarray')).toBe('Kadane-style running best subarray ending here');
  });

  test('loadSeed() is cached; explicit paths bypass the cache', () => {
    expect(loadSeed()).toBe(seed);
    const fresh = loadSeed({ subpatternsPath: path.join(__dirname, '..', '..', 'src', 'lc', 'data', 'subpatterns.json') });
    expect(fresh).not.toBe(seed);
    expect(fresh.membership.size).toBe(535);
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
