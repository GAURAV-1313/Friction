const { randomUUID } = require('crypto');
const { analyzeMoments } = require('./llm');
const { resolveDomainAndSubdomain } = require('./subdomainResolver');

const MAX_BATCH_SIZE = 30;

async function runSnapshotsForUser({ pool, userId, triggerType }) {
  const [moments] = await pool.query(
    `SELECT moment_id, raw_text, created_at
     FROM buffer_moments
     WHERE user_id = ? AND status = 'pending'
     ORDER BY created_at ASC`,
    [userId]
  );

  if (moments.length === 0) {
    return { status: 'no_activity', snapshots: [] };
  }

  const [settingsRows] = await pool.query(
    'SELECT output_language FROM user_settings WHERE user_id = ? LIMIT 1',
    [userId]
  );
  const outputLanguage = settingsRows[0] ? settingsRows[0].output_language : 'hinglish';

  const [promptRows] = await pool.query(
    'SELECT body FROM prompts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1'
  );
  if (promptRows.length === 0) {
    return { status: 'no_active_prompt', snapshots: [] };
  }
  const promptBody = promptRows[0].body;

  const batches = chunkArray(moments, MAX_BATCH_SIZE);
  const snapshots = [];

  for (const batch of batches) {
    const snapshotId = randomUUID();
    const momentIds = batch.map((m) => m.moment_id);
    const momentTexts = batch.map((m) => truncateMoment(m.raw_text));

    const findings = await analyzeMoments({
      moments: momentTexts,
      promptBody,
      outputLanguage
    });

    const mappedFindings = mapFindings(findings, momentIds);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query(
        'INSERT INTO snapshots (snapshot_id, user_id, trigger_type, moment_count) VALUES (?, ?, ?, ?)',
        [snapshotId, userId, triggerType, batch.length]
      );

        for (const finding of mappedFindings) {
          const { domainId, subdomainId } = await resolveDomainAndSubdomain(
            connection,
            finding.domain || 'misc',
            finding.topic
          );
          await connection.query(
            `INSERT INTO candidate_findings
              (finding_id, snapshot_id, user_id, type, topic, summary, recall_anchor, confidence_ai, evidence_moment_ids, state, domain_id, subdomain_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?, ?)`,
            [
              randomUUID(),
              snapshotId,
              userId,
              finding.type,
              finding.topic,
              finding.summary,
              finding.recall_anchor || null,
              finding.confidence_ai,
              JSON.stringify(finding.evidence_moment_ids),
              domainId,
              subdomainId
            ]
          );
        }

      await connection.query(
        `UPDATE buffer_moments
         SET status = 'processed'
         WHERE user_id = ? AND moment_id IN (${placeholders(momentIds.length)})`,
        [userId, ...momentIds]
      );

      await connection.query(
        `DELETE FROM buffer_moments
         WHERE user_id = ? AND moment_id IN (${placeholders(momentIds.length)})`,
        [userId, ...momentIds]
      );

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    snapshots.push({ snapshot_id: snapshotId, moment_count: batch.length });
  }

  return { status: 'ok', snapshots };
}

function truncateMoment(text) {
  const limit = Number(process.env.LLM_MAX_MOMENT_CHARS || 5000);
  if (!text || typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated]`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function placeholders(count) {
  return new Array(count).fill('?').join(',');
}

function mapFindings(findings, momentIds) {
  if (!Array.isArray(findings)) return [];

  return findings
    .map((finding) => {
      const evidenceIndices = Array.isArray(finding.evidence_indices)
        ? finding.evidence_indices
        : [];

      const evidenceMomentIds = evidenceIndices
        .map((index) => momentIds[index])
        .filter(Boolean);

      return {
        type: finding.type,
        domain: finding.domain || 'misc',
        topic: finding.topic,
        summary: finding.summary,
        recall_anchor: finding.recall_anchor,
        confidence_ai: finding.confidence_ai || finding.confidence,
        evidence_moment_ids: evidenceMomentIds.length ? evidenceMomentIds : []
      };
    })
    .filter((finding) =>
      finding.type &&
      finding.topic &&
      finding.summary &&
      finding.confidence_ai
    );
}

module.exports = { runSnapshotsForUser };
