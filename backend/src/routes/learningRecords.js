const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const pool = getDbPool();
    const [rows] = await pool.query(
      `SELECT lr.record_id, lr.type, lr.topic, lr.summary, lr.first_seen_at, lr.last_admitted_at,
              lr.occurrence_count, lr.ignored_count, lr.confidence_ai, lr.canonical_topic_id,
              lr.domain_id, lr.subdomain_id, lr.merged_at,
              ct.name as canonical_name,
              COUNT(cf.finding_id) as evidence_count
       FROM learning_records lr
       LEFT JOIN canonical_topics ct ON ct.topic_id = lr.canonical_topic_id
       LEFT JOIN candidate_findings cf ON cf.topic = lr.topic AND cf.state = 'confirmed' AND cf.user_id = lr.user_id
       WHERE lr.user_id = ?
       GROUP BY lr.record_id
       ORDER BY lr.last_admitted_at DESC`,
      [userId]
    );

    return res.json({ records: rows });
  } catch (err) {
    console.error('learning_records_list_failed', err);
    return res.status(500).json({ error: 'learning_records_list_failed' });
  }
});

module.exports = router;
