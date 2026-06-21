const { embedText, cosineSimilarity, safeParseEmbedding } = require('./embeddings');

async function findConsolidationCandidates(pool, userId, newRecordId, newTopic, newSummary, newDomainId, newSubdomainId) {
  const embedding = await embedText(`${newTopic} ${newSummary}`);
  if (!embedding) return [];

  const [rows] = await pool.query(
    `SELECT record_id, topic, summary, recall_anchor, type, occurrence_count, ignored_count,
            domain_id, subdomain_id, embedding, canonical_topic_id
     FROM learning_records
     WHERE user_id = ? AND record_id != ?
       AND domain_id = ? AND subdomain_id = ?
       AND embedding IS NOT NULL
     ORDER BY last_admitted_at DESC`,
    [userId, newRecordId, newDomainId, newSubdomainId]
  );

  const candidates = []
    .concat(rows)
    .map((row) => {
      const rowEmbedding = safeParseEmbedding(row.embedding);
      if (!rowEmbedding) return null;
      const score = cosineSimilarity(embedding, rowEmbedding);
      return { ...row, similarity: Math.round(score * 100) / 100 };
    })
    .filter((r) => r !== null && r.similarity >= CONSOLIDATION_SIM_THRESHOLD)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3);

  return candidates;
}

async function createMergeCandidate(pool, userId, sourceRecordId, targetRecordId, similarity) {
  const existing = await pool.query(
    `SELECT candidate_id FROM merge_candidates
     WHERE user_id = ? AND source_record_id = ? AND target_record_id = ? AND status = 'pending'`,
    [userId, sourceRecordId, targetRecordId]
  );

  if (existing[0].length > 0) return null;

  const candidateId = require('crypto').randomUUID();
  await pool.query(
    `INSERT INTO merge_candidates (candidate_id, user_id, source_record_id, target_record_id, similarity, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [candidateId, userId, sourceRecordId, targetRecordId, similarity]
  );

  return candidateId;
}

async function acceptMerge(pool, userId, candidateId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [candidateRows] = await connection.query(
      `SELECT mc.*, lr.topic as source_topic, lr.summary as source_summary, lr.occurrence_count as source_count,
              lr.canonical_topic_id as source_canonical_topic_id
       FROM merge_candidates mc
       JOIN learning_records lr ON lr.record_id = mc.source_record_id
       WHERE mc.candidate_id = ? AND mc.user_id = ? AND mc.status = 'pending'`,
      [candidateId, userId]
    );

    if (candidateRows.length === 0) {
      await connection.rollback();
      return { error: 'candidate_not_found' };
    }

    const candidate = candidateRows[0];

    const [targetRows] = await connection.query(
      'SELECT record_id, topic, summary, recall_anchor, occurrence_count, ignored_count, canonical_topic_id FROM learning_records WHERE record_id = ? AND user_id = ?',
      [candidate.target_record_id, userId]
    );

    if (targetRows.length === 0) {
      await connection.rollback();
      return { error: 'target_not_found' };
    }

    const target = targetRows[0];

    const mergedTopic = target.topic;
    const mergedSummary = `${target.summary} ${candidate.source_summary}`;
    const mergedCount = target.occurrence_count + candidate.source_count;
    const mergedIgnored = target.ignored_count;

    await connection.query(
      `UPDATE learning_records
       SET topic = ?, summary = ?, occurrence_count = ?, last_admitted_at = CURRENT_TIMESTAMP,
           merged_at = CURRENT_TIMESTAMP
       WHERE record_id = ?`,
      [mergedTopic, mergedSummary, mergedCount, candidate.target_record_id]
    );

    await connection.query(
      'DELETE FROM learning_records WHERE record_id = ?',
      [candidate.source_record_id]
    );

    await connection.query(
      'DELETE FROM merge_candidates WHERE candidate_id = ?',
      [candidateId]
    );

    await connection.commit();

    return { status: 'merged', target_record_id: candidate.target_record_id };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function rejectMerge(pool, userId, candidateId) {
  await pool.query(
    'UPDATE merge_candidates SET status = ? WHERE candidate_id = ? AND user_id = ?',
    ['rejected', candidateId, userId]
  );
  return { status: 'rejected' };
}

async function getPendingMerges(pool, userId) {
  const [rows] = await pool.query(
    `SELECT mc.*, lr_source.topic as source_topic, lr_target.topic as target_topic
     FROM merge_candidates mc
     JOIN learning_records lr_source ON lr_source.record_id = mc.source_record_id
     JOIN learning_records lr_target ON lr_target.record_id = mc.target_record_id
     WHERE mc.user_id = ? AND mc.status = 'pending'
     ORDER BY mc.created_at DESC`,
    [userId]
  );
  return rows;
}

async function getPendingMergesCount(pool, userId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) as count FROM merge_candidates WHERE user_id = ? AND status = ?',
    [userId, 'pending']
  );
  return rows[0].count;
}

module.exports = {
  findConsolidationCandidates,
  createMergeCandidate,
  acceptMerge,
  rejectMerge,
  getPendingMerges,
  getPendingMergesCount
};
