const { embedText, cosineSimilarity, safeParseEmbedding } = require('./embeddings');

async function retrieveContext(userId, queryText, topK = 5, simThreshold = 0.65) {
  const truncated = (queryText || '').slice(0, 5000);
  if (!truncated || truncated.trim().length === 0) return [];
  const queryEmbedding = await embedText(truncated);
  if (!queryEmbedding) return [];

  const threshold = simThreshold;
  const limit = topK;

  const { getDbPool } = require('../db/pool');
  const pool = getDbPool();

  const [rows] = await pool.query(
    "SELECT finding_id, topic, summary, recall_anchor, type, created_at, domain_id, subdomain_id, embedding FROM candidate_findings WHERE user_id = ? AND state = 'confirmed' AND embedding IS NOT NULL ORDER BY created_at DESC",
    [userId]
  );

  const scored = rows
    .map((row) => {
      const embedding = safeParseEmbedding(row.embedding);
      if (!embedding) return null;
      const score = cosineSimilarity(queryEmbedding, embedding);
      return { ...row, similarity: score };
    })
    .filter((r) => r !== null && r.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

async function retrieveRecordsContext(userId, queryText, topK = 5, simThreshold = 0.65) {
  const truncated = (queryText || '').slice(0, 5000);
  if (!truncated || truncated.trim().length === 0) return [];
  const queryEmbedding = await embedText(truncated);
  if (!queryEmbedding) return [];

  const threshold = simThreshold;
  const limit = topK;

  const { getDbPool } = require('../db/pool');
  const pool = getDbPool();

  const [rows] = await pool.query(
    'SELECT record_id, topic, summary, recall_anchor, type, first_seen_at, last_admitted_at, occurrence_count, domain_id, subdomain_id, embedding FROM learning_records WHERE user_id = ? AND embedding IS NOT NULL ORDER BY last_admitted_at DESC',
    [userId]
  );

  const scored = rows
    .map((row) => {
      const embedding = safeParseEmbedding(row.embedding);
      if (!embedding) return null;
      const score = cosineSimilarity(queryEmbedding, embedding);
      return { ...row, similarity: score };
    })
    .filter((r) => r !== null && r.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

async function retrieveCombinedContext(userId, queryText, topK = 5, simThreshold = 0.65) {
  const truncated = (queryText || '').slice(0, 5000);
  if (!truncated || truncated.trim().length === 0) return [];
  const queryEmbedding = await embedText(truncated);
  if (!queryEmbedding) return [];

  const threshold = simThreshold;
  const limit = topK;

  const { getDbPool } = require('../db/pool');
  const pool = getDbPool();

  const [findingRows] = await pool.query(
    "SELECT finding_id, topic, summary, recall_anchor, type, created_at, domain_id, subdomain_id, embedding FROM candidate_findings WHERE user_id = ? AND state = 'confirmed' AND embedding IS NOT NULL ORDER BY created_at DESC",
    [userId]
  );

  const [recordRows] = await pool.query(
    'SELECT record_id, topic, summary, recall_anchor, type, first_seen_at, last_admitted_at, occurrence_count, domain_id, subdomain_id, embedding FROM learning_records WHERE user_id = ? AND embedding IS NOT NULL ORDER BY last_admitted_at DESC',
    [userId]
  );

  const allRows = [
    ...findingRows.map((r) => ({ ...r, is_record: 0 })),
    ...recordRows.map((r) => ({ ...r, is_record: 1 }))
  ];

  const scored = allRows
    .map((row) => {
      const embedding = safeParseEmbedding(row.embedding);
      if (!embedding) return null;
      const score = cosineSimilarity(queryEmbedding, embedding);
      return { ...row, similarity: score };
    })
    .filter((r) => r !== null && r.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

module.exports = { retrieveContext, retrieveRecordsContext, retrieveCombinedContext };
