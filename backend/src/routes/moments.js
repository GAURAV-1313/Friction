const express = require('express');
const { randomUUID } = require('crypto');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { momentLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const ALLOWED_SOURCE_TYPES = new Set(['highlight', 'bulk_paste', 'auto']);

router.get('/', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const userId = req.auth.user_id;
    const [rows] = await pool.query(
      `SELECT moment_id, raw_text, source_type, source_url, created_at
       FROM buffer_moments
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );
    return res.json(rows);
  } catch (err) {
    console.error('moments_list_failed', err);
    return res.status(500).json({ error: 'moments_list_failed' });
  }
});

router.post('/', requireAuth, momentLimiter, async (req, res) => {
  const { raw_text, source_type, source_url, capture_hash, created_at } = req.body || {};

  console.log('[Moments POST]', { raw_text_length: raw_text?.length, source_type, capture_hash: capture_hash?.slice(0, 16), source_url });

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

    // Check for duplicate hash (within last 24 hours)
    if (capture_hash) {
      const [existing] = await pool.query(
        `SELECT moment_id FROM buffer_moments
         WHERE capture_hash = ?
         AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
         LIMIT 1`,
        [capture_hash]
      );

      if (existing.length > 0) {
        console.log('[Moments POST] Duplicate detected, skipping');
        return res.json({ ok: true, duplicate: true, moment_id: existing[0].moment_id });
      }
    }

    await pool.query(
      `INSERT INTO buffer_moments
        (moment_id, user_id, raw_text, source_type, source_url, capture_hash, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 'pending')`,
      [momentId, userId, raw_text, source_type, source_url || null, capture_hash || null, createdAtValue]
    );

    console.log('[Moments POST] Saved successfully, moment_id:', momentId);
    return res.status(201).json({ moment_id: momentId, duplicate: false });
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
