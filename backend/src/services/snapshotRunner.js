const { randomUUID } = require('crypto');
const { analyzeMoments, analyzeWithPrompt, compressCluster, buildRagPrompt } = require('./llm');
const { resolveDomainAndSubdomain } = require('./subdomainResolver');
const { clusterMoments } = require('./clustering');
const { retrieveContext, retrieveRecordsContext, retrieveCombinedContext } = require('./rag');
const { embedAndStore, embedText } = require('./embeddings');

const MAX_BATCH_SIZE = 30;
const HIERARCHICAL_SNAPSHOT = process.env.HIERARCHICAL_SNAPSHOT === 'true';
const DIRECT_ANALYSIS_THRESHOLD = Number(process.env.DIRECT_ANALYSIS_THRESHOLD || 15);
const CLUSTER_THRESHOLD = Number(process.env.CLUSTER_THRESHOLD || 50);
const VERY_LARGE_THRESHOLD = Number(process.env.VERY_LARGE_THRESHOLD || 100);
const RAG_TOP_K = Number(process.env.RAG_TOP_K || 5);
const RAG_SIM_THRESHOLD = Number(process.env.RAG_SIM_THRESHOLD || 0.65);
const RAG_SEARCH_SIM_THRESHOLD = Number(process.env.RAG_SEARCH_SIM_THRESHOLD || 0.55);
const CLUSTER_SIM_THRESHOLD = Number(process.env.CLUSTER_SIM_THRESHOLD || 0.7);
const CONSOLIDATION_SIM_THRESHOLD = Number(process.env.CONSOLIDATION_SIM_THRESHOLD || 0.75);

async function runSnapshotsForUser({ pool, userId, triggerType }) {
  const [moments] = await pool.query(
    `SELECT moment_id, raw_text, created_at
     FROM buffer_moments
     WHERE user_id = ? AND status = 'pending'
     ORDER BY created_at ASC`,
    [userId]
  );

  console.error('[SNAPSHOT] Moments found:', moments.length);

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
  console.error('[SNAPSHOT] Prompt rows:', promptRows.length);
  if (promptRows.length === 0) {
    return { status: 'no_active_prompt', snapshots: [] };
  }
  const promptBody = promptRows[0].body;

  const totalChars = moments.reduce((sum, m) => sum + (m.raw_text || '').length, 0);
  const strategy = determineProcessingStrategy(moments.length, totalChars);
  console.error('[SNAPSHOT] Strategy:', strategy, 'Chars:', totalChars);

  if (strategy === 'classic') {
    return await runClassicSnapshot({ pool, userId, triggerType, moments, outputLanguage, promptBody });
  }

  return await runAdaptiveSnapshot({ pool, userId, triggerType, moments, outputLanguage, promptBody });
}

function determineProcessingStrategy(momentCount, totalChars) {
  if (!HIERARCHICAL_SNAPSHOT) return 'classic';

  if (momentCount < DIRECT_ANALYSIS_THRESHOLD && totalChars < 50000) {
    return 'direct';
  }

  if (momentCount >= CLUSTER_THRESHOLD || totalChars >= VERY_LARGE_THRESHOLD) {
    return 'very_large';
  }

  return 'cluster';
}

async function runClassicSnapshot({ pool, userId, triggerType, moments, outputLanguage, promptBody }) {
  const batches = chunkArray(moments, MAX_BATCH_SIZE);
  const snapshots = [];
  console.error('[SNAPSHOT] Classic batch count:', batches.length);

  const ragContext = await retrieveCombinedContext(
    userId,
    moments.map((m) => m.raw_text).join(' '),
    RAG_TOP_K,
    RAG_SIM_THRESHOLD
  );
  console.error('[SNAPSHOT] RAG context found:', ragContext.length);

  for (const batch of batches) {
    console.error('[SNAPSHOT] Processing batch...');
    const snapshotId = randomUUID();
    const momentIds = batch.map((m) => m.moment_id);
    const momentTexts = batch.map((m) => truncateMoment(m.raw_text));

    const fullPrompt = buildRagPrompt(promptBody, outputLanguage, momentTexts.map((t) => ({ text: t })), ragContext);
    console.error('[SNAPSHOT] Prompt length:', fullPrompt.length);
    const analysisResults = await analyzeWithPrompt({ prompt: fullPrompt, outputLanguage });
    console.error('[SNAPSHOT] Analysis results:', analysisResults.length);
    const findings = mapFindings(analysisResults, momentIds);
    console.error('[SNAPSHOT] Valid findings:', findings.length);

    await insertSnapshotAndFindings(pool, snapshotId, userId, triggerType, batch.length, findings);
    console.error('[SNAPSHOT] Inserted findings into DB');

    await markAndDeleteMoments(pool, userId, momentIds);

    snapshots.push({ snapshot_id: snapshotId, moment_count: batch.length });
  }

  return { status: 'ok', snapshots };
}

async function runAdaptiveSnapshot({ pool, userId, triggerType, moments, outputLanguage, promptBody }) {
  const batches = chunkArray(moments, MAX_BATCH_SIZE);
  const snapshots = [];

  const allText = moments.map((m) => m.raw_text).join(' ');
  const ragContext = await retrieveCombinedContext(
    userId,
    allText,
    RAG_TOP_K,
    RAG_SIM_THRESHOLD
  );

  for (const batch of batches) {
    const snapshotId = randomUUID();
    const momentIds = batch.map((m) => m.moment_id);
    const momentTexts = batch.map((m) => truncateMoment(m.raw_text));

    const totalChars = batch.reduce((sum, m) => sum + (m.raw_text || '').length, 0);
    const strategy = determineProcessingStrategy(batch.length, totalChars);

    let findings;
    if (strategy === 'direct') {
    const fullPrompt = buildRagPrompt(promptBody, outputLanguage, momentTexts.map((t, i) => ({ text: t })), ragContext);
      const analysisResults = await analyzeWithPrompt({ prompt: fullPrompt, outputLanguage });
      findings = mapFindings(analysisResults, momentIds);
    } else if (strategy === 'very_large') {
      findings = await runVeryLargeBatch({
        pool, userId, batch, momentIds, outputLanguage, promptBody, ragContext
      });
    } else {
      findings = await runHierarchicalBatch({
        pool, userId, batch, momentIds, outputLanguage, promptBody
      });
    }

    await insertSnapshotAndFindings(pool, snapshotId, userId, triggerType, batch.length, findings);

    await markAndDeleteMoments(pool, userId, momentIds);

    snapshots.push({ snapshot_id: snapshotId, moment_count: batch.length });
  }

  return { status: 'ok', snapshots };
}

async function runHierarchicalSnapshot({ pool, userId, triggerType, moments, outputLanguage, promptBody }) {
  const batches = chunkArray(moments, MAX_BATCH_SIZE);
  const snapshots = [];

  for (const batch of batches) {
    const snapshotId = randomUUID();
    const momentIds = batch.map((m) => m.moment_id);

    const findings = await runHierarchicalBatch({
      pool, userId, batch, momentIds, outputLanguage, promptBody
    });

    await insertSnapshotAndFindings(pool, snapshotId, userId, triggerType, batch.length, findings);

    await markAndDeleteMoments(pool, userId, momentIds);

    snapshots.push({ snapshot_id: snapshotId, moment_count: batch.length });
  }

  return { status: 'ok', snapshots };
}

async function runHierarchicalBatch({ pool, userId, batch, momentIds, outputLanguage, promptBody }) {
  const clusterResults = await clusterMoments(pool, batch);

  const clusterSummaries = [];
  const clusterToMoments = new Map();

  for (const cluster of clusterResults) {
    const compression = await compressCluster(cluster.texts, outputLanguage);
    clusterSummaries.push(compression);
    clusterToMoments.set(compression.theme, cluster);
  }

  const ragContext = await retrieveContext(
    userId,
    clusterSummaries.map((c) => c.theme).join(' '),
    RAG_TOP_K,
    RAG_SIM_THRESHOLD
  );

  const fullPrompt = buildRagPrompt(promptBody, outputLanguage, clusterSummaries, ragContext);

  const analysisResults = await analyzeWithPrompt({ prompt: fullPrompt, outputLanguage });

  const allFindings = [];
  for (const rawFinding of analysisResults) {
    const finding = mapHierarchicalFinding(rawFinding, clusterToMoments);
    if (isValidFinding(finding)) {
      allFindings.push(finding);
    }
  }

  return allFindings;
}

async function runVeryLargeBatch({ pool, userId, batch, momentIds, outputLanguage, promptBody, ragContext }) {
  const clusterResults = await clusterMoments(pool, batch);

  const clusterSummaries = [];
  const clusterToMoments = new Map();

  for (const cluster of clusterResults) {
    const compression = await compressCluster(cluster.texts, outputLanguage);
    clusterSummaries.push(compression);
    clusterToMoments.set(compression.theme, cluster);
  }

  const compressedTexts = clusterSummaries.map((c) => `${c.theme}: ${c.summary}`);
  const allText = compressedTexts.join('\n');

  let compressedMoments = compressedTexts;
  if (allText.length > 15000) {
    const compressionPrompt = `Summarize the following cluster themes into at most 10 concise themes. Each theme should be one line: "theme: summary".

${allText}

Output only the compressed themes, one per line.`;

    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 60000);
      const url = 'https://api.openai.com/v1/chat/completions';

      try {
        const response = await axios.post(
          url,
          {
            model,
            messages: [{ role: 'user', content: compressionPrompt }]
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: timeoutMs
          }
        );

        const text = response.data?.choices?.[0]?.message?.content;
        if (text && typeof text === 'string') {
          const lines = text.split('\n').filter(l => l.includes(':')).slice(0, 10);
          if (lines.length > 0) {
            compressedMoments = lines;
          }
        }
      } catch (err) {
        // Fall back to full cluster summaries
      }
    }
  }

  const fullPrompt = buildRagPrompt(promptBody, outputLanguage, compressedMoments.map((t, i) => ({
    theme: `Theme ${i + 1}`,
    summary: t
  })), ragContext);

  const analysisResults = await analyzeWithPrompt({ prompt: fullPrompt, outputLanguage });

  const allFindings = [];
  for (const rawFinding of analysisResults) {
    const evidenceIndices = Array.isArray(rawFinding.evidence_indices) ? rawFinding.evidence_indices : [];
    const allMomentIds = [];
    for (const idx of evidenceIndices) {
      const themes = Array.from(clusterToMoments.keys());
      if (idx < themes.length) {
        const theme = themes[idx];
        const cluster = clusterToMoments.get(theme);
        if (cluster) {
          allMomentIds.push(...cluster.ids);
        }
      }
    }

    const finding = {
      finding_id: randomUUID(),
      type: rawFinding.type,
      domain: rawFinding.domain || 'misc',
      topic: rawFinding.topic,
      summary: rawFinding.summary,
      recall_anchor: rawFinding.recall_anchor,
      confidence_ai: rawFinding.confidence_ai || rawFinding.confidence,
      evidence_moment_ids: [...new Set(allMomentIds)]
    };

    if (isValidFinding(finding)) {
      allFindings.push(finding);
    }
  }

  return allFindings;
}

function mapHierarchicalFinding(rawFinding, clusterToMoments) {
  const evidenceIndices = Array.isArray(rawFinding.evidence_indices)
    ? rawFinding.evidence_indices
    : [];

  const allMomentIds = [];
  for (const idx of evidenceIndices) {
    const themes = Array.from(clusterToMoments.keys());
    if (idx < themes.length) {
      const theme = themes[idx];
      const cluster = clusterToMoments.get(theme);
      if (cluster) {
        allMomentIds.push(...cluster.ids);
      }
    }
  }

  return {
    finding_id: randomUUID(),
    type: rawFinding.type,
    domain: rawFinding.domain || 'misc',
    topic: rawFinding.topic,
    summary: rawFinding.summary,
    recall_anchor: rawFinding.recall_anchor,
    confidence_ai: rawFinding.confidence_ai || rawFinding.confidence,
    evidence_moment_ids: [...new Set(allMomentIds)]
  };
}

function isValidFinding(finding) {
  return finding.type && finding.topic && finding.summary && finding.confidence_ai;
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

async function insertSnapshotAndFindings(pool, snapshotId, userId, triggerType, momentCount, findings) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      'INSERT INTO snapshots (snapshot_id, user_id, trigger_type, moment_count) VALUES (?, ?, ?, ?)',
      [snapshotId, userId, triggerType, momentCount]
    );

    for (const finding of findings) {
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

      const embeddingText = `${finding.topic} ${finding.summary} ${finding.recall_anchor || ''}`;
      await embedAndStore(connection, 'candidate_findings', 'finding_id', finding.finding_id, embeddingText);
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function markAndDeleteMoments(pool, userId, momentIds) {
  await pool.query(
    `UPDATE buffer_moments
     SET status = 'processed'
     WHERE user_id = ? AND moment_id IN (${placeholders(momentIds.length)})`,
    [userId, ...momentIds]
  );

  await pool.query(
    `DELETE FROM buffer_moments
     WHERE user_id = ? AND moment_id IN (${placeholders(momentIds.length)})`,
    [userId, ...momentIds]
  );
}

module.exports = { runSnapshotsForUser };
