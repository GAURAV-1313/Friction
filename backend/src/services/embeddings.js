const axios = require('axios');

function getEmbedModel() {
  return process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
}

async function embedText(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (!text) return null;

  const model = getEmbedModel();
  const url = 'https://api.openai.com/v1/embeddings';
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 60000);

  console.error('[EMBED] Text length:', text.length, 'Model:', model);

  const response = await axios.post(
    url,
    {
      model,
      input: text
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    }
  );

  const values = response.data?.data?.[0]?.embedding;
  console.error('[EMBED] Got', values?.length || 0, 'dimensions');
  if (!Array.isArray(values)) return null;
  return values;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(texts, delayMs = 500) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const model = getEmbedModel();
  const url = 'https://api.openai.com/v1/embeddings';
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 60000);

  const results = [];
  for (const text of texts) {
    if (!text) {
      results.push(null);
      continue;
    }

    try {
      const response = await axios.post(
        url,
        {
          model,
          input: text
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: timeoutMs
        }
      );

      const values = response.data?.data?.[0]?.embedding;
      results.push(Array.isArray(values) ? values : null);
    } catch (err) {
      results.push(null);
    }

    if (delayMs > 0 && texts.indexOf(text) < texts.length - 1) {
      await sleep(delayMs);
    }
  }

  return results;
}

async function embedAndStore(conn, table, idColumn, id, text) {
  if (!text) return null;

  const embedding = await embedText(text);
  if (!embedding) {
    console.error('[EMBED-STORE] No embedding generated for', id);
    return null;
  }

  const idName = idColumn || 'id';
  try {
    const result = await conn.query(
      `UPDATE ${table} SET embedding = ? WHERE ${idName} = ?`,
      [JSON.stringify(embedding), id]
    );
    const affected = Array.isArray(result) ? result[0].affectedRows : result.affectedRows;
    console.error('[EMBED-STORE] Result type:', Array.isArray(result) ? 'array' : 'object', 'affected:', affected, 'in', table, 'for', id);
    return embedding;
  } catch (err) {
    console.error('[EMBED-STORE] UPDATE failed for', id, ':', err.message);
    return null;
  }
}

function safeParseEmbedding(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && Array.isArray(value.values)) return value.values;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch (err) {
      return null;
    }
  }
  return null;
}

module.exports = { embedText, embedBatch, embedAndStore, cosineSimilarity, safeParseEmbedding };
