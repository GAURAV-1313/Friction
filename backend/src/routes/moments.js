const express = require('express');
const { randomUUID } = require('crypto');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_SOURCE_TYPES = new Set(['highlight', 'bulk_paste']);

router.post('/', requireAuth, async (req, res) => {
  const { raw_text, source_type, source_url, created_at } = req.body || {};

  if (!raw_text || typeof raw_text !== 'string') {
    return res.status(400).json({ error: 'raw_text_required' });
  }

  if (!source_type || !ALLOWED_SOURCE_TYPES.has(source_type)) {
    return res.status(400).json({ error: 'invalid_source_type' });
  }

  const momentId = randomUUID();
  const userId = req.auth.user_id;
  const createdAtValue = normalizeCreatedAt(created_at);

  try {
    const pool = getDbPool();
    await pool.query(
      `INSERT INTO buffer_moments
        (moment_id, user_id, raw_text, source_type, source_url, created_at, status)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 'pending')`,
      [momentId, userId, raw_text, source_type, source_url || null, createdAtValue]
    );

    return res.status(201).json({ moment_id: momentId });
  } catch (err) {
    // Log for debugging; do not expose internal errors to client.
    // eslint-disable-next-line no-console
    console.error('moment_insert_failed', err);
    return res.status(500).json({ error: 'moment_insert_failed' });
  }
});

function normalizeCreatedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  // MySQL DATETIME expects 'YYYY-MM-DD HH:MM:SS'
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = router;
