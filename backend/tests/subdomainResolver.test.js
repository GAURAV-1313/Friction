const subdomainResolver = require('../src/services/subdomainResolver');

const mockPool = {
  query: jest.fn()
};

describe('resolveDomainAndSubdomain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    subdomainResolver.clearCache();
    mockPool.query.mockResolvedValue([[]]);
  });

  it('should return domainId and subdomainId object', async () => {
    mockPool.query.mockResolvedValueOnce([[{ domain_id: 'd1' }]]);

    const result = await subdomainResolver.resolveDomainAndSubdomain(mockPool, 'programming', 'recursion');
    expect(result).toHaveProperty('domainId');
    expect(result).toHaveProperty('subdomainId');
  });

  it('should fallback to misc domain when not found', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    mockPool.query.mockResolvedValueOnce([[{ domain_id: 'misc-id' }]]);

    const result = await subdomainResolver.resolveDomainAndSubdomain(mockPool, 'unknown-domain', 'topic');
    expect(result.domainId).toBe('misc-id');
  });

  it('should return null when neither domain nor misc found', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    mockPool.query.mockResolvedValueOnce([[]]);

    const result = await subdomainResolver.resolveDomainAndSubdomain(mockPool, 'unknown-domain-xyz', 'topic');
    expect(result.domainId).toBeNull();
    expect(result.subdomainId).toBeNull();
  });

  it('should handle case-insensitive lookup', async () => {
    mockPool.query.mockResolvedValueOnce([[{ domain_id: 'd1' }]]);

    await subdomainResolver.resolveDomainAndSubdomain(mockPool, 'Programming', 'recursion');
    expect(mockPool.query).toHaveBeenCalledWith(
      'SELECT domain_id FROM domains WHERE name = ? LIMIT 1',
      ['programming']
    );
  });

  it('should handle null domain name', async () => {
    mockPool.query.mockResolvedValueOnce([[{ domain_id: 'misc-id' }]]);

    const result = await subdomainResolver.resolveDomainAndSubdomain(mockPool, null, 'topic');
    expect(result.domainId).toBe('misc-id');
  });

  it('should return null subdomainId (no embedding lookup)', async () => {
    mockPool.query.mockResolvedValueOnce([[{ domain_id: 'd1' }]]);

    const result = await subdomainResolver.resolveDomainAndSubdomain(mockPool, 'programming', 'algorithms');
    expect(result.subdomainId).toBeNull();
  });

  it('should handle database errors gracefully', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('DB error'));

    const result = await subdomainResolver.resolveDomainAndSubdomain(mockPool, 'programming', 'recursion');
    expect(result.domainId).toBeNull();
    expect(result.subdomainId).toBeNull();
  });
});
