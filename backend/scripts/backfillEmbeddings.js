const { getDbPool } = require('./src/db/pool');
const { embedText, embedAndStore } = require('./src/services/embeddings');

async function backfillEmbeddings() {
  const pool = getDbPool();
  
  // Get all findings without embeddings
  const [rows] = await pool.query(
    `SELECT finding_id, topic, summary, recall_anchor 
     FROM candidate_findings 
     WHERE embedding IS NULL`
  );
  
  console.error(`[BACKFILL] Found ${rows.length} findings without embeddings`);
  
  let success = 0;
  let failed = 0;
  
  for (const row of rows) {
    const text = `${row.topic} ${row.summary} ${row.recall_anchor || ''}`;
    try {
      const embedding = await embedText(text);
      if (!embedding) {
        console.error(`[BACKFILL] Failed to generate embedding for ${row.finding_id}`);
        failed++;
        continue;
      }
      
      const result = await pool.query(
        `UPDATE candidate_findings SET embedding = ? WHERE finding_id = ?`,
        [JSON.stringify(embedding), row.finding_id]
      );
      
      const affected = result[0]?.affectedRows || result.affectedRows;
      if (affected > 0) {
        success++;
        console.error(`[BACKFILL] Stored embedding for ${row.finding_id}`);
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`[BACKFILL] Error for ${row.finding_id}:`, err.message);
      failed++;
    }
  }
  
  console.error(`[BACKFILL] Done. Success: ${success}, Failed: ${failed}`);
}

backfillEmbeddings().catch(console.error);
