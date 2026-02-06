const express = require('express');
const { getDbPool } = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const pool = getDbPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'error' });
  }
});

module.exports = router;
