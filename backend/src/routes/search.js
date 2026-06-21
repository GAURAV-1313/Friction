const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { embedText, cosineSimilarity, safeParseEmbedding } = require('../services/embeddings');
const { suggestCanonicalTopic, getCanonicalTopics } = require('../services/canonicalTopics');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;
  const query = req.query.q;
  const limit = Math.min(Number(req.query.limit) || 8, 20);
  const simThreshold = Number(process.env.RAG_SEARCH_SIM_THRESHOLD || 0.55);

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'missing_query' });
  }

  try {
    const pool = getDbPool();
    const queryEmbedding = await embedText(query.trim().slice(0, 5000));
    if (!queryEmbedding) {
      return res.json({ results: [], query, canonical_suggestion: null });
    }

    const [findingRows] = await pool.query(
      `SELECT finding_id as id, 'finding' as type, topic, summary, recall_anchor,
              type as item_type, created_at, state, confidence_ai,
              domain_id, subdomain_id, embedding
       FROM candidate_findings
       WHERE user_id = ? AND embedding IS NOT NULL
       ORDER BY created_at DESC`,
      [userId]
    );

    const [recordRows] = await pool.query(
      `SELECT record_id as id, 'record' as type, topic, summary, recall_anchor,
              type as item_type, first_seen_at, last_admitted_at,
              occurrence_count, ignored_count, domain_id, subdomain_id, embedding,
              canonical_topic_id
       FROM learning_records
       WHERE user_id = ? AND embedding IS NOT NULL
       ORDER BY last_admitted_at DESC`,
      [userId]
    );

    const [canonicalTopics] = await pool.query(
      'SELECT topic_id, name FROM canonical_topics WHERE user_id = ?',
      [userId]
    );
    const canonicalMap = new Map();
    for (const ct of canonicalTopics) {
      canonicalMap.set(ct.topic_id, ct.name);
    }

    const scored = [];

    for (const row of findingRows) {
      const embedding = safeParseEmbedding(row.embedding);
      if (!embedding) continue;
      const score = cosineSimilarity(queryEmbedding, embedding);
      if (score >= simThreshold) {
        scored.push({
          ...row,
          similarity: Math.round(score * 100) / 100,
          evidence_count: 0,
          canonical_name: row.canonical_topic_id ? canonicalMap.get(row.canonical_topic_id) : null
        });
      }
    }

    for (const row of recordRows) {
      const embedding = safeParseEmbedding(row.embedding);
      if (!embedding) continue;
      const score = cosineSimilarity(queryEmbedding, embedding);
      if (score >= simThreshold) {
        scored.push({
          ...row,
          similarity: Math.round(score * 100) / 100,
          evidence_count: row.occurrence_count || 0,
          canonical_name: row.canonical_topic_id ? canonicalMap.get(row.canonical_topic_id) : null
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);

    const grouped = groupByTopicAndCanonical(scored.slice(0, limit));

    const canonicalSuggestion = await suggestCanonicalTopic(pool, userId, query.trim());

    return res.json({ results: grouped, query, canonical_suggestion: canonicalSuggestion });
  } catch (err) {
    console.error('search_failed', err);
    return res.status(500).json({ error: 'search_failed' });
  }
});

function groupByTopicAndCanonical(items) {
  const groups = new Map();

  for (const item of items) {
    const canonicalKey = item.canonical_name || item.topic.toLowerCase().trim();
    const topicKey = item.topic.toLowerCase().trim();
    const groupKey = item.canonical_name ? `canonical:${canonicalKey}` : `topic:${topicKey}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        topic: item.canonical_name || item.topic,
        canonical_name: item.canonical_name || null,
        type: item.item_type,
        count: 0,
        total_occurrences: 0,
        items: []
      });
    }

    const group = groups.get(groupKey);
    group.count += 1;
    group.total_occurrences += (item.evidence_count || 0);
    group.items.push(item);
  }

  const result = [];
  for (const group of groups.values()) {
    result.push({
      topic: group.topic,
      canonical_name: group.canonical_name,
      type: group.count > 1 ? 'mixed' : group.type,
      count: group.count,
      total_occurrences: group.total_occurrences,
      items: group.items
    });
  }

  return result;
}

module.exports = router;
