const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/summary', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const pool = getDbPool();

    const [rows] = await pool.query(
      `SELECT type, topic, summary, occurrence_count, ignored_count, first_seen_at, last_admitted_at
       FROM learning_records
       WHERE user_id = ?
       ORDER BY last_admitted_at DESC`,
      [userId]
    );

    return res.json({ report: rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('report_summary_failed', err);
    return res.status(500).json({ error: 'report_summary_failed' });
  }
});

module.exports = router;
