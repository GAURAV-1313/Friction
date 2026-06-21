const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const pool = getDbPool();

    const [canonicalTopics] = await pool.query(
      `SELECT ct.topic_id, ct.name, ct.occurrence_count, ct.created_at, ct.updated_at,
              COUNT(lr.record_id) as record_count,
              COALESCE(SUM(lr.occurrence_count), 0) as total_occurrences
       FROM canonical_topics ct
       LEFT JOIN learning_records lr ON lr.canonical_topic_id = ct.topic_id AND lr.user_id = ?
       WHERE ct.user_id = ?
       GROUP BY ct.topic_id
       ORDER BY ct.occurrence_count DESC`,
      [userId, userId]
    );

    const [records] = await pool.query(
      `SELECT lr.*, ct.name as canonical_name
       FROM learning_records lr
       LEFT JOIN canonical_topics ct ON ct.topic_id = lr.canonical_topic_id
       WHERE lr.user_id = ?
       ORDER BY lr.last_admitted_at DESC`,
      [userId]
    );

    const memoryView = buildMemoryView(canonicalTopics, records);

    return res.json({ memory_view: memoryView });
  } catch (err) {
    console.error('memory_view_failed', err);
    return res.status(500).json({ error: 'memory_view_failed' });
  }
});

function buildMemoryView(canonicalTopics, records) {
  const topicsWithRecords = new Map();

  for (const ct of canonicalTopics) {
    topicsWithRecords.set(ct.topic_id, {
      topic_id: ct.topic_id,
      name: ct.name,
      record_count: ct.record_count,
      total_occurrences: ct.total_occurrences,
      evidence_count: 0,
      timeline: [],
      sub_topics: []
    });
  }

  for (const r of records) {
    const canonicalId = r.canonical_topic_id;
    if (canonicalId && topicsWithRecords.has(canonicalId)) {
      const topic = topicsWithRecords.get(canonicalId);
      topic.evidence_count += (r.occurrence_count || 0);
      topic.timeline.push({
        topic: r.topic,
        type: r.type,
        last_seen: r.last_admitted_at,
        occurrence_count: r.occurrence_count,
        summary: r.summary
      });
      topic.sub_topics.push(r.topic);
    }
  }

  const result = [];
  for (const topic of topicsWithRecords.values()) {
    if (topic.record_count >= 1) {
      topic.timeline.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
      topic.sub_topics = [...new Set(topic.sub_topics)];
      result.push(topic);
    }
  }

  result.sort((a, b) => b.total_occurrences - a.total_occurrences);
  return result;
}

module.exports = router;
