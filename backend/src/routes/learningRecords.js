const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const pool = getDbPool();
    const [rows] = await pool.query(
      `SELECT record_id, type, topic, summary, first_seen_at, last_admitted_at, occurrence_count, ignored_count
       FROM learning_records
       WHERE user_id = ?
       ORDER BY last_admitted_at DESC`,
      [userId]
    );

    return res.json({ records: rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('learning_records_list_failed', err);
    return res.status(500).json({ error: 'learning_records_list_failed' });
  }
});

module.exports = router;
