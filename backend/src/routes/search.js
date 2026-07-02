const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_QUERY_LENGTH = 5000;
const MAX_LIMIT = 20;

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;
  const query = req.query.q;
  const limit = Math.min(Number(req.query.limit) || 8, MAX_LIMIT);

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'missing_query' });
  }

  const trimmedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
  const searchPattern = `%${trimmedQuery}%`;

  try {
    const pool = getDbPool();

    const [findingRows] = await pool.query(
      `SELECT finding_id as id, 'finding' as type, topic, summary, recall_anchor,
              type as item_type, created_at, state, confidence_ai
       FROM candidate_findings
       WHERE user_id = ? AND (topic LIKE ? OR summary LIKE ? OR recall_anchor LIKE ?)
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, searchPattern, searchPattern, searchPattern, limit]
    );

    const [recordRows] = await pool.query(
      `SELECT record_id as id, 'record' as type, topic, summary, recall_anchor,
              type as item_type, first_seen_at, last_admitted_at,
              occurrence_count, ignored_count
       FROM learning_records
       WHERE user_id = ? AND (topic LIKE ? OR summary LIKE ? OR recall_anchor LIKE ?)
       ORDER BY last_admitted_at DESC
       LIMIT ?`,
      [userId, searchPattern, searchPattern, searchPattern, limit]
    );

    const results = [];
    for (const row of findingRows) {
      results.push({
        ...row,
        similarity: null,
        evidence_count: 0,
        canonical_name: null
      });
    }

    for (const row of recordRows) {
      results.push({
        ...row,
        similarity: null,
        evidence_count: row.occurrence_count || 0,
        canonical_name: null
      });
    }

    return res.json({ results, query: trimmedQuery, canonical_suggestion: null });
  } catch (err) {
    console.error('[SEARCH] search_failed:', err.message);
    return res.status(500).json({ error: 'search_failed' });
  }
});

module.exports = router;
