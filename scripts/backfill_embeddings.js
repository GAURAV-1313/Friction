const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const { embedBatch } = require('../backend/src/services/embeddings');

dotenv.config();

const BATCH_SIZE = 20;
const DELAY_MS = 500;

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'friction',
    charset: 'utf8mb4_unicode_ci'
  });

  console.log('Connected to DB');

  await backfillFindings(pool);
  await backfillRecords(pool);

  console.log('Backfill complete');
  await pool.end();
}

async function backfillFindings(pool) {
  console.log('\n=== Backfilling candidate_findings ===');

  const [rows] = await pool.query(
    `SELECT finding_id, topic, summary, recall_anchor 
     FROM candidate_findings 
     WHERE embedding IS NULL 
       AND (topic IS NOT NULL OR summary IS NOT NULL)
     ORDER BY created_at ASC`
  );

  console.log(`Found ${rows.length} findings to embed`);

  const texts = rows.map((row) => {
    const parts = [row.topic || '', row.summary || '', row.recall_anchor || ''].filter(Boolean);
    return parts.join(' ').trim();
  });

  const embeddings = await embedBatch(texts, DELAY_MS);

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    if (!embeddings[i]) {
      skipped++;
      continue;
    }

    await pool.query(
      'UPDATE candidate_findings SET embedding = ? WHERE finding_id = ?',
      [JSON.stringify(embeddings[i]), rows[i].finding_id]
    );
    updated++;

    if (updated % 10 === 0) {
      console.log(`  Progress: ${updated}/${rows.length} findings embedded`);
    }
  }

  console.log(`  Done: ${updated} updated, ${skipped} skipped (null embedding)`);
}

async function backfillRecords(pool) {
  console.log('\n=== Backfilling learning_records ===');

  const [rows] = await pool.query(
    `SELECT record_id, topic, summary, recall_anchor 
     FROM learning_records 
     WHERE embedding IS NULL 
       AND (topic IS NOT NULL OR summary IS NOT NULL)
     ORDER BY first_seen_at ASC`
  );

  console.log(`Found ${rows.length} records to embed`);

  const texts = rows.map((row) => {
    const parts = [row.topic || '', row.summary || '', row.recall_anchor || ''].filter(Boolean);
    return parts.join(' ').trim();
  });

  const embeddings = await embedBatch(texts, DELAY_MS);

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i++) {
    if (!embeddings[i]) {
      skipped++;
      continue;
    }

    await pool.query(
      'UPDATE learning_records SET embedding = ? WHERE record_id = ?',
      [JSON.stringify(embeddings[i]), rows[i].record_id]
    );
    updated++;

    if (updated % 10 === 0) {
      console.log(`  Progress: ${updated}/${rows.length} records embedded`);
    }
  }

  console.log(`  Done: ${updated} updated, ${skipped} skipped (null embedding)`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
