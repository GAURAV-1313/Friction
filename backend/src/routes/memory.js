const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getUserLearningRecords } = require('../services/learningRecords');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const records = await getUserLearningRecords(userId);
    return res.json({ memory_view: records });
  } catch (err) {
    console.error('memory_view_failed', err);
    return res.status(500).json({ error: 'memory_view_failed' });
  }
});

module.exports = router;
