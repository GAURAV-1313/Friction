const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getUserLearningRecords } = require('../services/learningRecords');

const router = express.Router();

router.get('/summary', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;

  try {
    const records = await getUserLearningRecords(userId);
    const report = generateReport(records);
    return res.json({ report });
  } catch (err) {
    console.error('report_summary_failed', err);
    return res.status(500).json({ error: 'report_summary_failed' });
  }
});

function generateReport(records) {
  const highFriction = records
    .filter(r => r.type === 'gap' && r.occurrence_count >= 2)
    .sort((a, b) => b.occurrence_count - a.occurrence_count)
    .slice(0, 5)
    .map(r => ({
      topic: r.topic,
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
      topic: r.topic,
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
      topic: r.topic,
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
      topic: r.topic,
      type: r.type,
      occurrence_count: r.occurrence_count,
      confidence: r.confidence_ai || 'medium',
      last_admitted_at: r.last_admitted_at
    }));

  const reflectionQuestions = generateReflectionQuestions(records);

  return {
    snapshot_summary: {
      total_records: records.length,
      total_gaps: records.filter(r => r.type === 'gap').length,
      total_insights: records.filter(r => r.type === 'insight').length,
      total_patterns: records.filter(r => r.type === 'pattern').length
    },
    high_friction_areas: highFriction,
    active_learning_gaps: activeGaps,
    recent_insights: recentInsights,
    repeated_patterns: repeatedPatterns,
    reflection_questions: reflectionQuestions
  };
}

function generateReflectionQuestions(records) {
  const questions = [];

  const highFrictionGaps = records.filter(r => r.type === 'gap' && r.occurrence_count >= 3);
  if (highFrictionGaps.length > 0) {
    questions.push({
      type: 'pattern',
      question: `You've encountered "${highFrictionGaps[0].topic}" ${highFrictionGaps[0].occurrence_count} times. What's the common thread across these instances?`,
      related_records: highFrictionGaps.slice(0, 3).map(r => r.topic)
    });
  }

  const ignoredRecords = records.filter(r => r.ignored_count > r.occurrence_count);
  if (ignoredRecords.length > 0) {
    questions.push({
      type: 'avoidance',
      question: `You've deferred "${ignoredRecords[0].topic}" more times than you've engaged with it. Is there a reason to revisit this?`,
      related_records: ignoredRecords.slice(0, 2).map(r => r.topic)
    });
  }

  const recentInsights = records.filter(r => r.type === 'insight' && r.occurrence_count >= 2);
  if (recentInsights.length > 0) {
    questions.push({
      type: 'reinforcement',
      question: `You've confirmed "${recentInsights[0].topic}" ${recentInsights[0].occurrence_count} times. Have you applied this understanding in practice?`,
      related_records: recentInsights.slice(0, 2).map(r => r.topic)
    });
  }

  return questions;
}

module.exports = router;
