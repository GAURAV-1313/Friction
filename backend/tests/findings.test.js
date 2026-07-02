const { findBestTopicMatch, normalizeTopic, jaccardSimilarity } = require('../src/routes/findings');

describe('normalizeTopic', () => {
  it('should tokenize and filter stopwords', () => {
    const result = normalizeTopic('Recursion base case issue');
    expect(result).toContain('recursion');
    expect(result).toContain('base');
    expect(result).not.toContain('case');
    expect(result).not.toContain('issue');
  });

  it('should handle null input', () => {
    expect(normalizeTopic(null)).toEqual([]);
  });

  it('should handle undefined input', () => {
    expect(normalizeTopic(undefined)).toEqual([]);
  });

  it('should handle empty string', () => {
    expect(normalizeTopic('')).toEqual([]);
  });

  it('should lowercase input', () => {
    const result = normalizeTopic('RECURSION BASE CASE');
    expect(result).toContain('recursion');
    expect(result).toContain('base');
    expect(result).not.toContain('case');
  });

  it('should remove special characters', () => {
    const result = normalizeTopic('Recursion@Base#Case$');
    expect(result).toContain('recursion');
    expect(result).toContain('base');
    expect(result).not.toContain('case');
  });

  it('should filter single character tokens', () => {
    const result = normalizeTopic('a b c recursion');
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
    expect(result).not.toContain('c');
    expect(result).toContain('recursion');
  });

  it('should handle whitespace-only input', () => {
    expect(normalizeTopic('   ')).toEqual([]);
  });
});

describe('jaccardSimilarity', () => {
  it('should return 1 for identical sets', () => {
    expect(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(1);
  });

  it('should return 0 for empty sets', () => {
    expect(jaccardSimilarity([], [])).toBe(0);
  });

  it('should return 0 when one set is empty', () => {
    expect(jaccardSimilarity(['a', 'b'], [])).toBe(0);
    expect(jaccardSimilarity([], ['a', 'b'])).toBe(0);
  });

  it('should calculate correct similarity', () => {
    expect(jaccardSimilarity(['a', 'b'], ['b', 'c', 'd'])).toBeCloseTo(0.25);
  });

  it('should return 0 for completely different sets', () => {
    expect(jaccardSimilarity(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('should handle duplicate tokens by converting to sets', () => {
    expect(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b', 'b'])).toBe(1);
  });
});

describe('findBestTopicMatch', () => {
  const mockRecords = [
    { record_id: 'r1', topic: 'Recursion base case', domain_id: 'd1', subdomain_id: 's1' },
    { record_id: 'r2', topic: 'Array iteration', domain_id: 'd1', subdomain_id: 's2' },
    { record_id: 'r3', topic: 'Recursion stopping condition', domain_id: 'd1', subdomain_id: 's1' }
  ];

  it('should find exact match', () => {
    const result = findBestTopicMatch(mockRecords, 'Recursion base case', 'd1', 's1');
    expect(result).toEqual(mockRecords[0]);
  });

  it('should find similar topic with high Jaccard score', () => {
    const originalThreshold = process.env.TOPIC_SIM_THRESHOLD;
    process.env.TOPIC_SIM_THRESHOLD = '0.6';
    try {
      const result = findBestTopicMatch(mockRecords, 'Recursion stopping', 'd1', 's1');
      expect(result).toEqual(mockRecords[2]);
    } finally {
      if (originalThreshold === undefined) {
        delete process.env.TOPIC_SIM_THRESHOLD;
      } else {
        process.env.TOPIC_SIM_THRESHOLD = originalThreshold;
      }
    }
  });

  it('should return null when no match exceeds threshold', () => {
    const result = findBestTopicMatch(mockRecords, 'Completely different topic', 'd1', 's1');
    expect(result).toBeNull();
  });

  it('should respect domain filter', () => {
    const result = findBestTopicMatch(mockRecords, 'Array iteration', 'd1', 's2');
    expect(result).toEqual(mockRecords[1]);
  });

  it('should filter by domain when domainId provided', () => {
    const result = findBestTopicMatch(mockRecords, 'Recursion base case', 'd2', 's1');
    expect(result).toBeNull();
  });

  it('should handle empty records array', () => {
    const result = findBestTopicMatch([], 'Some topic', 'd1', 's1');
    expect(result).toBeNull();
  });

  it('should handle null records', () => {
    const result = findBestTopicMatch(null, 'Some topic', 'd1', 's1');
    expect(result).toBeNull();
  });

  it('should handle undefined records', () => {
    const result = findBestTopicMatch(undefined, 'Some topic', 'd1', 's1');
    expect(result).toBeNull();
  });

  it('should handle null topic', () => {
    const result = findBestTopicMatch(mockRecords, null, 'd1', 's1');
    expect(result).toBeNull();
  });

  it('should use default threshold of 0.8', () => {
    const result = findBestTopicMatch(mockRecords, 'Recursion base case', 'd1', 's1');
    expect(result).toEqual(mockRecords[0]);
  });
});
