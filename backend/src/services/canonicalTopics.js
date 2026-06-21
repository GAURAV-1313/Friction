const { embedText, cosineSimilarity, safeParseEmbedding } = require('./embeddings');

const topicCache = new Map();

async function getOrCreateCanonicalTopic(pool, userId, topicName) {
  const key = `${userId}:${topicName.toLowerCase().trim()}`;
  if (topicCache.has(key)) return topicCache.get(key);

  const [rows] = await pool.query(
    'SELECT topic_id, name, occurrence_count FROM canonical_topics WHERE user_id = ? AND name = ?',
    [userId, topicName]
  );

  if (rows.length > 0) {
    const topic = rows[0];
    topicCache.set(key, topic);
    return topic;
  }

  const topicId = require('crypto').randomUUID();
  await pool.query(
    'INSERT INTO canonical_topics (topic_id, user_id, name) VALUES (?, ?, ?)',
    [topicId, userId, topicName]
  );

  const topic = { topic_id: topicId, name: topicName, occurrence_count: 0 };
  topicCache.set(key, topic);
  return topic;
}

async function suggestCanonicalTopic(pool, userId, rawTopic, summary) {
  const searchText = summary ? `${rawTopic} ${summary}` : rawTopic;
  const embedding = await embedText(searchText);
  if (!embedding) return null;

  const [rows] = await pool.query(
    'SELECT topic_id, name, embedding, occurrence_count FROM canonical_topics WHERE user_id = ? AND embedding IS NOT NULL',
    [userId]
  );

  let best = null;
  let bestScore = 0;
  const threshold = Number(process.env.CANONICAL_SIM_THRESHOLD || 0.8);

  for (const row of rows) {
    const rowEmbedding = safeParseEmbedding(row.embedding);
    if (!rowEmbedding) continue;

    const score = cosineSimilarity(embedding, rowEmbedding);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (best && bestScore >= threshold) {
    return { topic_id: best.topic_id, name: best.name, similarity: bestScore };
  }

  return null;
}

async function updateTopicOccurrence(pool, topicId) {
  await pool.query(
    'UPDATE canonical_topics SET occurrence_count = occurrence_count + 1, updated_at = CURRENT_TIMESTAMP WHERE topic_id = ?',
    [topicId]
  );
  topicCache.clear();
}

async function getCanonicalTopics(pool, userId) {
  const [rows] = await pool.query(
    'SELECT topic_id, name, occurrence_count, created_at, updated_at FROM canonical_topics WHERE user_id = ? ORDER BY occurrence_count DESC',
    [userId]
  );
  return rows;
}

async function createCanonicalTopic(pool, userId, name) {
  const topicId = require('crypto').randomUUID();
  await pool.query(
    'INSERT INTO canonical_topics (topic_id, user_id, name) VALUES (?, ?, ?)',
    [topicId, userId, name]
  );
  return { topic_id: topicId, name };
}

module.exports = {
  getOrCreateCanonicalTopic,
  suggestCanonicalTopic,
  updateTopicOccurrence,
  getCanonicalTopics,
  createCanonicalTopic
};
