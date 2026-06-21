const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { embedText, cosineSimilarity, safeParseEmbedding } = require('../services/embeddings');

const router = express.Router();

router.get('/summary', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const pool = getDbPool();

    const [records] = await pool.query(
      `SELECT lr.*, ct.name as canonical_name, ct.topic_id as canonical_topic_id
       FROM learning_records lr
       LEFT JOIN canonical_topics ct ON ct.topic_id = lr.canonical_topic_id
       WHERE lr.user_id = ?
       ORDER BY lr.last_admitted_at DESC`,
      [userId]
    );

    const [mergeCandidates] = await pool.query(
      `SELECT mc.*, lr_source.topic as source_topic, lr_target.topic as target_topic
       FROM merge_candidates mc
       JOIN learning_records lr_source ON lr_source.record_id = mc.source_record_id
       JOIN learning_records lr_target ON lr_target.record_id = mc.target_record_id
       WHERE mc.user_id = ? AND mc.status = 'pending'
       ORDER BY mc.created_at DESC`,
      [userId]
    );

    const [canonicalTopics] = await pool.query(
      `SELECT ct.*, COUNT(lr.record_id) as record_count
       FROM canonical_topics ct
       LEFT JOIN learning_records lr ON lr.canonical_topic_id = ct.topic_id AND lr.user_id = ?
       WHERE ct.user_id = ?
       GROUP BY ct.topic_id
       ORDER BY ct.occurrence_count DESC`,
      [userId, userId]
    );

    const report = generateReport(records, mergeCandidates, canonicalTopics);

    return res.json({ report });
  } catch (err) {
    console.error('report_summary_failed', err);
    return res.status(500).json({ error: 'report_summary_failed' });
  }
});

function generateReport(records, mergeCandidates, canonicalTopics) {
  const highFriction = records
    .filter(r => r.type === 'gap' && r.occurrence_count >= 2)
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 5)
    .map(r => ({
      topic: r.canonical_name || r.topic,
      canonical_name: r.canonical_name,
      type: r.type,
      occurrence_count: r.occurrence_count,
      ignored_count: r.ignored_count,
      confidence: r.confidence_ai || 'medium',
      last_admitted_at: r.last_admitted_at,
      summary: r.summary
    }));

  const activeGaps = records
    .filter(r => r.type === 'gap')
    .sort((a, b) => b.last_admitted_at.localeCompare(a.last_admitted_at))
    .slice(0, 5)
    .map(r => ({
      topic: r.canonical_name || r.topic,
      canonical_name: r.canonical_name,
      type: r.type,
      occurrence_count: r.occurrence_count,
      confidence: r.confidence_ai || 'medium',
      last_admitted_at: r.last_admitted_at
    }));

  const recentInsights = records
    .filter(r => r.type === 'insight')
    .sort((a, b) => b.last_admitted_at.localeCompare(a.last_admitted_at))
    .slice(0, 5)
    .map(r => ({
      topic: r.canonical_name || r.topic,
      canonical_name: r.canonical_name,
      type: r.type,
      occurrence_count: r.occurrence_count,
      confidence: r.confidence_ai || 'medium',
      last_admitted_at: r.last_admitted_at,
      summary: r.summary
    }));

  const repeatedPatterns = records
    .filter(r => r.occurrence_count >= 3)
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 5)
    .map(r => ({
      topic: r.canonical_name || r.topic,
      canonical_name: r.canonical_name,
      type: r.type,
      occurrence_count: r.occurrence_count,
      confidence: r.confidence_ai || 'medium',
      last_admitted_at: r.last_admitted_at
    }));

  const recurringThemes = groupByCanonical(records);

  const reflectionQuestions = generateReflectionQuestions(records);

  return {
    snapshot_summary: {
      total_records: records.length,
      total_gaps: records.filter(r => r.type === 'gap').length,
      total_insights: records.filter(r => r.type === 'insight').length,
      total_patterns: records.filter(r => r.type === 'pattern').length,
      high_friction_count: highFriction.length,
      merge_candidates_pending: mergeCandidates.length,
      total_canonical_topics: canonicalTopics.length,
      total_recurring_themes: recurringThemes.length
    },
    high_friction_areas: highFriction,
    active_learning_gaps: activeGaps,
    recent_insights: recentInsights,
    repeated_patterns: repeatedPatterns,
    recurring_themes: recurringThemes,
    reflection_questions: reflectionQuestions,
    merge_candidates: mergeCandidates.map(m => ({
      candidate_id: m.candidate_id,
      source_topic: m.source_topic,
      target_topic: m.target_topic,
      similarity: m.similarity
    })),
    canonical_topics: canonicalTopics.slice(0, 10)
  };
}

function groupByCanonical(records) {
  const groups = new Map();

  for (const r of records) {
    const key = r.canonical_name || r.topic.toLowerCase().trim();
    if (!groups.has(key)) {
      groups.set(key, {
        theme: r.canonical_name || r.topic,
        type: r.type,
        record_count: 0,
        total_occurrences: 0,
        total_ignored: 0,
        confidence: r.confidence_ai || 'medium',
        last_admitted_at: r.last_admitted_at,
        topics: []
      });
    }
    const group = groups.get(key);
    group.record_count += 1;
    group.total_occurrences += (r.occurrence_count || 0);
    group.total_ignored += (r.ignored_count || 0);
    group.topics.push(r.topic);
  }

  const result = [];
  for (const group of groups.values()) {
    if (group.record_count >= 2 || group.total_occurrences >= 3) {
      result.push({
        theme: group.theme,
        type: group.type,
        record_count: group.record_count,
        total_occurrences: group.total_occurrences,
        total_ignored: group.total_ignored,
        confidence: group.confidence,
        last_admitted_at: group.last_admitted_at,
        topics: group.topics
      });
    }
  }

  result.sort((a, b) => b.total_occurrences - a.total_occurrences);
  return result.slice(0, 8);
}

function generateReflectionQuestions(records) {
  const questions = [];

  const highFrictionGaps = records.filter(r => r.type === 'gap' && r.occurrence_count >= 3);
  if (highFrictionGaps.length > 0) {
    questions.push({
      type: 'pattern',
      question: `You've encountered "${highFrictionGaps[0].topic}" ${highFrictionGaps[0].occurrence_count} times. What's the common thread across these instances?`,
      related_records: highFrictionGaps.slice(0, 3).map(r => r.canonical_name || r.topic)
    });
  }

  const ignoredRecords = records.filter(r => r.ignored_count > r.occurrence_count);
  if (ignoredRecords.length > 0) {
    questions.push({
      type: 'avoidance',
      question: `You've deferred "${ignoredRecords[0].topic}" more times than you've engaged with it. Is there a reason to revisit this?`,
      related_records: ignoredRecords.slice(0, 2).map(r => r.canonical_name || r.topic)
    });
  }

  const recentInsights = records.filter(r => r.type === 'insight' && r.occurrence_count >= 2);
  if (recentInsights.length > 0) {
    questions.push({
      type: 'reinforcement',
      question: `You've confirmed "${recentInsights[0].topic}" ${recentInsights[0].occurrence_count} times. Have you applied this understanding in practice?`,
      related_records: recentInsights.slice(0, 2).map(r => r.canonical_name || r.topic)
    });
  }

  const recurringThemes = records.filter(r => {
    const key = r.canonical_name || r.topic.toLowerCase().trim();
    return records.filter(r2 => (r2.canonical_name || r2.topic.toLowerCase().trim()) === key).length >= 2;
  });

  if (recurringThemes.length >= 3) {
    const themes = [...new Set(recurringThemes.map(r => r.canonical_name || r.topic))].slice(0, 5);
    questions.push({
      type: 'synthesis',
      question: `You have ${themes.length} recurring themes: ${themes.slice(0, 3).join(', ')}. Should you focus on one theme before moving to others?`,
      related_records: themes
    });
  }

  return questions;
}

module.exports = router;
