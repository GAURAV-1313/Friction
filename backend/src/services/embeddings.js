const axios = require('axios');

function getEmbedModel() {
  return process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
}

async function embedText(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  if (!text) return null;

  const model = getEmbedModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 60000);

  const response = await axios.post(
    url,
    {
      content: {
        parts: [{ text }]
      }
    },
    {
      params: { key: apiKey },
      timeout: timeoutMs
    }
  );

  const values = response.data?.embedding?.values;
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

module.exports = { embedText, cosineSimilarity };
