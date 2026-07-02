const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { runSnapshotsForUser } = require('../services/snapshotRunner');
const { snapshotLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.post('/run', requireAuth, snapshotLimiter, async (req, res) => {
  const triggerType = req.body && req.body.trigger_type === 'scheduled' ? 'scheduled' : 'manual';
  const userId = req.auth.user_id;

  try {
    const pool = getDbPool();
    const result = await runSnapshotsForUser({ pool, userId, triggerType });
    if (result.status === 'no_active_prompt') {
      return res.status(400).json({ error: 'no_active_prompt' });
    }
    return res.json(result);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('snapshot_run_failed', err);
    return res.status(500).json({ error: 'snapshot_run_failed' });
  }
});

module.exports = router;
