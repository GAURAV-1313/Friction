const express = require('express');
const { getDbPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_STATES = new Set(['unreviewed', 'confirmed', 'deferred', 'rejected']);

router.get('/', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;
  const state = req.query.state;

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');

  if (state && !ALLOWED_STATES.has(state)) {
    return res.status(400).json({ error: 'invalid_state' });
  }

  try {
    const pool = getDbPool();
    const [rows] = await pool.query(
      `SELECT f.finding_id, f.snapshot_id, f.type, f.topic, f.summary, f.recall_anchor, f.confidence_ai,
              f.evidence_moment_ids, f.state, f.created_at, f.domain_id, f.subdomain_id,
              d.name AS domain_name, d.label AS domain_label,
              sd.name AS subdomain_name,
              s.created_at AS snapshot_created_at
       FROM candidate_findings f
       LEFT JOIN snapshots s ON s.snapshot_id = f.snapshot_id
       LEFT JOIN domains d ON d.domain_id = f.domain_id
       LEFT JOIN subdomains sd ON sd.subdomain_id = f.subdomain_id
       WHERE f.user_id = ?
       ${state ? 'AND f.state = ?' : ''} 
       ORDER BY f.created_at DESC`,
      state ? [userId, state] : [userId]
    );

    return res.json({ findings: rows });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('findings_list_failed', err);
    return res.status(500).json({ error: 'findings_list_failed' });
  }
});

router.post('/:id/confirm', requireAuth, async (req, res) => {
  return handleFindingDecision(req, res, 'confirmed');
});

router.post('/:id/defer', requireAuth, async (req, res) => {
  return handleFindingDecision(req, res, 'deferred');
});

router.post('/:id/resolve', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;
  const findingId = req.params.id;

  try {
    const pool = getDbPool();
    const [result] = await pool.query(
      'DELETE FROM candidate_findings WHERE finding_id = ? AND user_id = ? AND state = "confirmed"',
      [findingId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'finding_not_found' });
    }

    return res.json({ status: 'resolved' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('finding_resolve_failed', err);
    return res.status(500).json({ error: 'finding_resolve_failed' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const userId = req.auth.user_id;
  const findingId = req.params.id;

  try {
    const pool = getDbPool();
    const [result] = await pool.query(
      `DELETE FROM candidate_findings
       WHERE finding_id = ? AND user_id = ? AND state IN ('unreviewed','deferred')`,
      [findingId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'finding_not_found' });
    }

    return res.json({ status: 'rejected' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('finding_reject_failed', err);
    return res.status(500).json({ error: 'finding_reject_failed' });
  }
});

async function handleFindingDecision(req, res, nextState) {
  const userId = req.auth.user_id;
  const findingId = req.params.id;

  try {
    const pool = getDbPool();
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();

      const [findingRows] = await connection.query(
        `SELECT finding_id, type, topic, summary, recall_anchor, state, domain_id, subdomain_id
         FROM candidate_findings
         WHERE finding_id = ? AND user_id = ? LIMIT 1`,
        [findingId, userId]
      );

      if (findingRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: 'finding_not_found' });
      }

      const finding = findingRows[0];
      if (finding.state === 'rejected') {
        await connection.rollback();
        return res.status(400).json({ error: 'finding_already_rejected' });
      }

      await connection.query(
        'UPDATE candidate_findings SET state = ? WHERE finding_id = ? AND user_id = ?',
        [nextState, findingId, userId]
      );

      const [recordRows] = await connection.query(
        `SELECT record_id, topic, domain_id, subdomain_id
         FROM learning_records
         WHERE user_id = ? AND type = ?`,
        [userId, finding.type]
      );

      const bestMatch = findBestTopicMatch(recordRows, finding.topic, finding.domain_id, finding.subdomain_id);

      if (!bestMatch) {
        await connection.query(
          `INSERT INTO learning_records
            (record_id, user_id, type, topic, summary, recall_anchor, first_seen_at, last_admitted_at, occurrence_count, ignored_count, domain_id, subdomain_id)
           VALUES (UUID(), ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 0, ?, ?)`,
          [
            userId,
            finding.type,
            finding.topic,
            finding.summary,
            finding.recall_anchor || null,
            finding.domain_id || null,
            finding.subdomain_id || null
          ]
        );
      } else {
        await connection.query(
          `UPDATE learning_records
           SET summary = ?, recall_anchor = ?, last_admitted_at = CURRENT_TIMESTAMP, occurrence_count = occurrence_count + 1
           WHERE record_id = ?`,
          [finding.summary, finding.recall_anchor || null, bestMatch.record_id]
        );
      }

      await connection.commit();
      return res.json({ status: nextState });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('finding_decision_failed', err);
    return res.status(500).json({ error: 'finding_decision_failed' });
  }
}

module.exports = router;

function findBestTopicMatch(records, topic, domainId, subdomainId) {
  if (!records || records.length === 0) return null;
  const threshold = Number(process.env.TOPIC_SIM_THRESHOLD || 0.8);
  const target = normalizeTopic(topic);
  let best = null;
  let bestScore = 0;

  for (const record of records) {
    if (domainId && record.domain_id && record.domain_id !== domainId) {
      continue;
    }
    if (subdomainId && record.subdomain_id && record.subdomain_id !== subdomainId) {
      continue;
    }
    const score = jaccardSimilarity(target, normalizeTopic(record.topic));
    if (score > bestScore) {
      bestScore = score;
      best = record;
    }
  }

  if (bestScore >= threshold) {
    return best;
  }
  return null;
}

function normalizeTopic(value) {
  if (!value || typeof value !== 'string') return [];
  const stopwords = getStopwords();
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\\s]/g, ' ')
    .split(/\\s+/)
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopwords.has(token));
}

function jaccardSimilarity(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function getStopwords() {
  const defaultWords = [
    'issue',
    'problem',
    'confusion',
    'error',
    'bug',
    'mistake',
    'case',
    'edge',
    'logic',
    'understanding'
  ];
  const env = process.env.TOPIC_STOPWORDS;
  const tokens = env ? env.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean) : defaultWords;
  return new Set(tokens);
}
