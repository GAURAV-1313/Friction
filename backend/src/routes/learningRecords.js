const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getUserLearningRecords } = require('../services/learningRecords');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const rows = await getUserLearningRecords(userId);
    return res.json({ records: rows });
  } catch (err) {
    console.error('learning_records_list_failed', err);
    return res.status(500).json({ error: 'learning_records_list_failed' });
  }
});

module.exports = router;
