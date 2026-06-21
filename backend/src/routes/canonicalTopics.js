const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const {
  getOrCreateCanonicalTopic,
  suggestCanonicalTopic,
  updateTopicOccurrence,
  getCanonicalTopics,
  createCanonicalTopic
} = require('../services/canonicalTopics');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const userId = req.auth.user_id;
    const topics = await getCanonicalTopics(pool, userId);
    return res.json({ canonical_topics: topics });
  } catch (err) {
    console.error('canonical_topics_failed', err);
    return res.status(500).json({ error: 'canonical_topics_failed' });
  }
});

router.post('/suggest', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const userId = req.auth.user_id;
    const { topic } = req.body;

    if (!topic || typeof topic !== 'string') {
      return res.status(400).json({ error: 'missing_topic' });
    }

    const suggestion = await suggestCanonicalTopic(pool, userId, topic);
    return res.json({ suggestion });
  } catch (err) {
    console.error('canonical_suggest_failed', err);
    return res.status(500).json({ error: 'canonical_suggest_failed' });
  }
});

router.post('/create', requireAuth, async (req, res) => {
  try {
    const pool = getDbPool();
    const userId = req.auth.user_id;
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'missing_name' });
    }

    const topic = await createCanonicalTopic(pool, userId, name);
    return res.json({ canonical_topic: topic });
  } catch (err) {
    console.error('canonical_create_failed', err);
    return res.status(500).json({ error: 'canonical_create_failed' });
  }
});

module.exports = router;
