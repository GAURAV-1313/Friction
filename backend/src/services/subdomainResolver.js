const { embedText, cosineSimilarity } = require('./embeddings');

const domainCache = new Map();
const subdomainCache = new Map();

async function getDomainId(pool, name) {
  const key = (name || '').toLowerCase();
  if (domainCache.has(key)) return domainCache.get(key);

  const [rows] = await pool.query('SELECT domain_id FROM domains WHERE name = ? LIMIT 1', [key]);
  if (rows.length) {
    domainCache.set(key, rows[0].domain_id);
    return rows[0].domain_id;
  }

  const [fallbackRows] = await pool.query('SELECT domain_id FROM domains WHERE name = ? LIMIT 1', ['misc']);
  const fallback = fallbackRows[0] ? fallbackRows[0].domain_id : null;
  domainCache.set(key, fallback);
  return fallback;
}

async function ensureSubdomainEmbeddings(pool, domainId) {
  const [rows] = await pool.query(
    'SELECT subdomain_id, name FROM subdomains WHERE domain_id = ? AND embedding IS NULL LIMIT 50',
    [domainId]
  );
  if (!rows.length) return;

  for (const row of rows) {
    const embedding = await embedText(row.name);
    if (!embedding) continue;
    await pool.query('UPDATE subdomains SET embedding = ? WHERE subdomain_id = ?', [
      JSON.stringify(embedding),
      row.subdomain_id
    ]);
  }
}

async function loadSubdomains(pool, domainId) {
  if (subdomainCache.has(domainId)) return subdomainCache.get(domainId);
  await ensureSubdomainEmbeddings(pool, domainId);
  const [rows] = await pool.query(
    'SELECT subdomain_id, name, embedding FROM subdomains WHERE domain_id = ?',
    [domainId]
  );
  const parsed = rows.map((row) => ({
    subdomain_id: row.subdomain_id,
    name: row.name,
    embedding: row.embedding ? JSON.parse(row.embedding) : null
  }));
  subdomainCache.set(domainId, parsed);
  return parsed;
}

async function resolveSubdomainId(pool, domainId, topic) {
  if (!domainId || !topic) return null;
  const subdomains = await loadSubdomains(pool, domainId);
  if (!subdomains.length) return null;

  const topicEmbedding = await embedText(topic);
  if (!topicEmbedding) return null;

  let best = null;
  let bestScore = 0;
  for (const subdomain of subdomains) {
    if (!subdomain.embedding) continue;
    const score = cosineSimilarity(topicEmbedding, subdomain.embedding);
    if (score > bestScore) {
      bestScore = score;
      best = subdomain;
    }
  }

  const threshold = Number(process.env.SUBDOMAIN_SIM_THRESHOLD || 0.82);
  if (best && bestScore >= threshold) {
    return best.subdomain_id;
  }
  return null;
}

async function resolveDomainAndSubdomain(pool, domainName, topic) {
  const domainId = await getDomainId(pool, domainName || 'misc');
  if (!domainId) return { domainId: null, subdomainId: null };
  const subdomainId = await resolveSubdomainId(pool, domainId, topic);
  return { domainId, subdomainId };
}

module.exports = { resolveDomainAndSubdomain };
