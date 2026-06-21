const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const {
  findConsolidationCandidates,
  createMergeCandidate,
  acceptMerge,
  rejectMerge,
  getPendingMerges
} = require('../services/consolidation');

const router = express.Router();

router.get('/merge-candidates', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const userId = req.auth.user_id;
    const merges = await getPendingMerges(pool, userId);
    return res.json({ merge_candidates: merges });
  } catch (err) {
    console.error('merge_candidates_failed', err);
    return res.status(500).json({ error: 'merge_candidates_failed' });
  }
});

router.post('/merge-candidates/:id/accept', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const userId = req.auth.user_id;
    const result = await acceptMerge(pool, userId, req.params.id);
    return res.json(result);
  } catch (err) {
    console.error('merge_accept_failed', err);
    return res.status(500).json({ error: 'merge_accept_failed' });
  }
});

router.post('/merge-candidates/:id/reject', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const userId = req.auth.user_id;
    const result = await rejectMerge(pool, userId, req.params.id);
    return res.json(result);
  } catch (err) {
    console.error('merge_reject_failed', err);
    return res.status(500).json({ error: 'merge_reject_failed' });
  }
});

module.exports = router;
