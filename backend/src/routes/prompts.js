const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const [rows] = await pool.query(
      'SELECT prompt_id, name, body, is_active, updated_at FROM prompts ORDER BY updated_at DESC'
    );
    return res.json({ prompts: rows });
  } catch (err) {
    console.error('prompts_list_failed', err);
    return res.status(500).json({ error: 'prompts_list_failed' });
  }
});

router.get('/active', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const [rows] = await pool.query(
      'SELECT prompt_id, name, body, is_active, updated_at FROM prompts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1'
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'no_active_prompt' });
    }

    return res.json({ prompt: rows[0] });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('prompt_get_failed', err);
    return res.status(500).json({ error: 'prompt_get_failed' });
  }
});

router.put('/active', requireAuth, async (req, res) => {
  const { name, body } = req.body || {};

  if (!body || typeof body !== 'string') {
    return res.status(400).json({ error: 'prompt_body_required' });
  }

  try {
    const pool = getDbPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      await connection.query('UPDATE prompts SET is_active = 0 WHERE is_active = 1');
      await connection.query(
        'INSERT INTO prompts (prompt_id, name, body, is_active) VALUES (UUID(), ?, ?, 1)',
        [name || 'active', body]
      );

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    return res.json({ status: 'updated' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('prompt_update_failed', err);
    return res.status(500).json({ error: 'prompt_update_failed' });
  }
});

module.exports = router;
