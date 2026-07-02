jest.mock('../src/services/llm', () => ({
  analyzeMoments: jest.fn(),
}));
jest.mock('../src/services/subdomainResolver');

const snapshotRunner = require('../src/services/snapshotRunner');
const llm = require('../src/services/llm');
const subdomainResolver = require('../src/services/subdomainResolver');

let queryCallCount = 0;
let queryResponses = [];
let queryReject = false;

const mockConnection = {
  query: jest.fn(async function(...args) {
    const response = this._mockResponses?.shift() || [];
    return response;
  }),
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  release: jest.fn(),
  _mockResponses: []
};

const mockPool = {
  query: jest.fn(async function(...args) {
    if (queryReject) {
      queryReject = false;
      throw new Error('DB connection failed');
    }
    const response = queryResponses.shift();
    return response !== undefined ? response : [[]];
  }),
  getConnection: jest.fn().mockResolvedValue(mockConnection)
};

function setupPoolResponses(...responses) {
  queryCallCount = 0;
  queryResponses = responses.map(r => [r]);
  queryReject = false;
}

describe('runSnapshotsForUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryResponses = [];
    queryReject = false;
    llm.analyzeMoments.mockClear().mockResolvedValue([]);
    subdomainResolver.resolveDomainAndSubdomain.mockClear().mockResolvedValue({ domainId: 'd1', subdomainId: null });
  });

  it('should return no_activity when no pending moments', async () => {
    setupPoolResponses([]);

    const result = await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });
    expect(result.status).toBe('no_activity');
    expect(result.snapshots).toEqual([]);
  });

  it('should return no_active_prompt when no active prompt exists', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [{ output_language: 'english' }],
      []
    );

    const result = await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });
    expect(result.status).toBe('no_active_prompt');
  });

  it('should use hinglish as default output language', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    expect(llm.analyzeMoments).toHaveBeenCalledWith({
      moments: expect.any(Array),
      promptBody: 'Analyze moments',
      outputLanguage: 'hinglish'
    });
  });

  it('should use configured output language', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [{ output_language: 'english' }],
      [{ body: 'Analyze moments' }]
    );

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    expect(llm.analyzeMoments).toHaveBeenCalledWith({
      moments: expect.any(Array),
      promptBody: 'Analyze moments',
      outputLanguage: 'english'
    });
  });

  it('should query buffer_moments with correct parameters', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    expect(mockPool.query).toHaveBeenCalledWith(
      expect.stringContaining('buffer_moments'),
      ['user1']
    );
  });

  it('should query user_settings for output_language', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    expect(mockPool.query).toHaveBeenCalledWith(
      'SELECT output_language FROM user_settings WHERE user_id = ? LIMIT 1',
      ['user1']
    );
  });

  it('should query active prompt', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    expect(mockPool.query).toHaveBeenCalledWith(
      'SELECT body FROM prompts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1'
    );
  });

  it('should call analyzeMoments with correct arguments', async () => {
    setupPoolResponses(
      [
        { moment_id: 'm1', raw_text: 'Moment 1', created_at: '2024-01-01' },
        { moment_id: 'm2', raw_text: 'Moment 2', created_at: '2024-01-02' }
      ],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    expect(llm.analyzeMoments).toHaveBeenCalledWith({
      moments: expect.any(Array),
      promptBody: 'Analyze moments',
      outputLanguage: 'hinglish'
    });
  });

  it('should insert snapshot into database', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    const insertCall = mockConnection.query.mock.calls.find(c => c[0].includes('INSERT INTO snapshots'));
    expect(insertCall).toBeDefined();
  });

  it('should mark moments as processed', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    const updateCall = mockPool.query.mock.calls.find(c => c[0].includes("status = 'processed'"));
    expect(updateCall).toBeDefined();
  });

  it('should delete moments after processing', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });

    const deleteCall = mockPool.query.mock.calls.find(c => c[0].includes('DELETE FROM buffer_moments'));
    expect(deleteCall).toBeDefined();
  });

  it('should return ok status with snapshots array', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    const result = await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });
    expect(result.status).toBe('ok');
    expect(Array.isArray(result.snapshots)).toBe(true);
  });

  it('should include snapshot_id and moment_count in result', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: 'Test moment', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    const result = await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });
    expect(result.snapshots[0]).toHaveProperty('snapshot_id');
    expect(result.snapshots[0]).toHaveProperty('moment_count');
  });

  it('should handle database errors', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('DB connection failed'));

    await expect(snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' }))
      .rejects.toThrow('DB connection failed');
  });

  it('should handle empty raw_text in moments', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: '', created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    const result = await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });
    expect(result.status).toBe('ok');
  });

  it('should handle null raw_text in moments', async () => {
    setupPoolResponses(
      [{ moment_id: 'm1', raw_text: null, created_at: '2024-01-01' }],
      [],
      [{ body: 'Analyze moments' }]
    );
    llm.analyzeMoments.mockResolvedValue([]);

    const result = await snapshotRunner.runSnapshotsForUser({ pool: mockPool, userId: 'user1', triggerType: 'manual' });
    expect(result.status).toBe('ok');
  });
});

describe('mapFindings', () => {
  it('should map valid findings correctly', () => {
    const findings = snapshotRunner.mapFindings([
      {
        type: 'gap',
        domain: 'programming',
        topic: 'Recursion',
        summary: 'Confusion about base case',
        recall_anchor: 'Factorial',
        confidence_ai: 'high',
        evidence_indices: [0, 1]
      }
    ], ['m1', 'm2']);

    expect(findings[0].type).toBe('gap');
    expect(findings[0].topic).toBe('Recursion');
    expect(findings[0].summary).toBe('Confusion about base case');
    expect(findings[0].recall_anchor).toBe('Factorial');
    expect(findings[0].confidence_ai).toBe('high');
    expect(findings[0].evidence_moment_ids).toEqual(['m1', 'm2']);
  });

  it('should filter out findings missing required fields', () => {
    const findings = snapshotRunner.mapFindings([
      { type: 'gap', topic: 'Test', summary: 'Test', confidence_ai: null, evidence_indices: [] },
      { type: null, topic: 'Test', summary: 'Test', confidence_ai: 'high', evidence_indices: [] },
      { type: 'gap', topic: null, summary: 'Test', confidence_ai: 'high', evidence_indices: [] },
      { type: 'gap', topic: 'Test', summary: null, confidence_ai: 'high', evidence_indices: [] },
      { type: 'gap', topic: 'Test', summary: 'Test', confidence_ai: 'high', evidence_indices: [] }
    ], []);

    expect(findings.length).toBe(1);
  });

  it('should handle null evidence_indices', () => {
    const findings = snapshotRunner.mapFindings([
      { type: 'gap', topic: 'Test', summary: 'Test', confidence_ai: 'high', evidence_indices: null }
    ], ['m1', 'm2']);

    expect(findings[0].evidence_moment_ids).toEqual([]);
  });

  it('should handle empty evidence_indices', () => {
    const findings = snapshotRunner.mapFindings([
      { type: 'gap', topic: 'Test', summary: 'Test', confidence_ai: 'high', evidence_indices: [] }
    ], ['m1', 'm2']);

    expect(findings[0].evidence_moment_ids).toEqual([]);
  });

  it('should filter out invalid evidence indices', () => {
    const findings = snapshotRunner.mapFindings([
      { type: 'gap', topic: 'Test', summary: 'Test', confidence_ai: 'high', evidence_indices: [0, 5, -1, 'abc'] }
    ], ['m1', 'm2']);

    expect(findings[0].evidence_moment_ids).toEqual(['m1']);
  });

  it('should handle null findings array', () => {
    const findings = snapshotRunner.mapFindings(null, ['m1']);
    expect(findings).toEqual([]);
  });

  it('should handle undefined findings', () => {
    const findings = snapshotRunner.mapFindings(undefined, ['m1']);
    expect(findings).toEqual([]);
  });

  it('should use domain fallback when domain is missing', () => {
    const findings = snapshotRunner.mapFindings([
      { type: 'gap', topic: 'Test', summary: 'Test', confidence_ai: 'high', evidence_indices: [] }
    ], []);

    expect(findings[0].domain).toBe('misc');
  });

  it('should use confidence fallback', () => {
    const findings = snapshotRunner.mapFindings([
      { type: 'gap', topic: 'Test', summary: 'Test', confidence: 'medium', evidence_indices: [] }
    ], []);

    expect(findings[0].confidence_ai).toBe('medium');
  });

  it('should handle null finding objects', () => {
    const findings = snapshotRunner.mapFindings([null, { type: 'gap', topic: 'Test', summary: 'Test', confidence_ai: 'high', evidence_indices: [] }, undefined], []);
    expect(findings.length).toBe(1);
  });
});

describe('truncateMoment', () => {
  it('should return text as-is when within limit', () => {
    const result = snapshotRunner.truncateMoment('Short text');
    expect(result).toBe('Short text');
  });

  it('should truncate text exceeding limit', () => {
    const longText = 'a'.repeat(6000);
    const result = snapshotRunner.truncateMoment(longText);
    expect(result.length).toBeGreaterThan(5000);
    expect(result).toContain('[truncated]');
  });

  it('should handle null text', () => {
    expect(snapshotRunner.truncateMoment(null)).toBe('');
  });

  it('should handle undefined text', () => {
    expect(snapshotRunner.truncateMoment(undefined)).toBe('');
  });

  it('should handle empty text', () => {
    expect(snapshotRunner.truncateMoment('')).toBe('');
  });

  it('should handle non-string text', () => {
    expect(snapshotRunner.truncateMoment(123)).toBe('');
  });
});

describe('chunkArray', () => {
  it('should split array into chunks of specified size', () => {
    const result = snapshotRunner.chunkArray([1, 2, 3, 4, 5], 2);
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('should return single chunk when array size equals chunk size', () => {
    const result = snapshotRunner.chunkArray([1, 2, 3], 3);
    expect(result).toEqual([[1, 2, 3]]);
  });

  it('should return single element chunks', () => {
    const result = snapshotRunner.chunkArray([1, 2, 3], 1);
    expect(result).toEqual([[1], [2], [3]]);
  });

  it('should return empty array for empty input', () => {
    expect(snapshotRunner.chunkArray([], 5)).toEqual([]);
  });

  it('should return empty array for null input', () => {
    expect(snapshotRunner.chunkArray(null, 5)).toEqual([]);
  });

  it('should return empty array for invalid size', () => {
    expect(snapshotRunner.chunkArray([1, 2, 3], 0)).toEqual([]);
    expect(snapshotRunner.chunkArray([1, 2, 3], -1)).toEqual([]);
  });
});
