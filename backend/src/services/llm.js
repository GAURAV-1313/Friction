const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

function buildPrompt(promptBody, outputLanguage, moments) {
  const languageLine = outputLanguage === 'english' ? 'Output language: English.' : 'Output language: Hinglish.';
  const momentLines = moments
    .map((text, index) => `${index}. ${sanitizeMoment(text)}`)
    .join('\n');

  return `${promptBody}\n\n${languageLine}\n\nMoments (indexed, chronological):\n${momentLines}`;
}

async function analyzeMoments({ moments, promptBody, outputLanguage }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const prompt = buildPrompt(promptBody, outputLanguage, moments);
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 60000);

  const url = 'https://api.openai.com/v1/chat/completions';

  const response = await axios.post(
    url,
    {
      model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
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
  if (!text || typeof text !== 'string') {
    debugLog('OpenAI response missing text', response.data);
    console.error('[LLM] FULL RESPONSE:', JSON.stringify(response.data, null, 2).slice(0, 4000));
    return [];
  }

  try {
    const extracted = extractJson(text);
    const parsed = JSON.parse(extracted);
    console.error('[LLM] RAW:', text.slice(0, 2000));
    console.error('[LLM] EXTRACTED:', extracted.slice(0, 2000));
    console.error('[LLM] PARSED:', JSON.stringify(parsed, null, 2).slice(0, 4000));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    debugLog('OpenAI JSON parse failed', text);
    console.error('[LLM] RAW:', text.slice(0, 2000));
    console.error('[LLM] EXTRACTED:', extractJson(text).slice(0, 2000));
    console.error('[LLM] ERROR:', err.message);
    return [];
  }
}

function extractJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) return fenced[1];
  const trimmed = text.trim();
  const first = trimmed.indexOf('[');
  const last = trimmed.lastIndexOf(']');
  if (first !== -1 && last !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return trimmed;
}

function debugLog(message, payload) {
  if (process.env.DEBUG_LLM !== 'true') return;
  // eslint-disable-next-line no-console
  console.error('[LLM]', message);
  // eslint-disable-next-line no-console
  console.error(
    typeof payload === 'string'
      ? payload.slice(0, 2000)
      : JSON.stringify(payload).slice(0, 2000)
  );
}

async function compressCluster(clusterTexts, outputLanguage) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const languageLine = outputLanguage === 'english' ? 'Output language: English.' : 'Output language: Hinglish.';

  const momentLines = clusterTexts
    .map((text, index) => `${index}. ${sanitizeMoment(text)}`)
    .join('\n');

  const prompt = `These moments are related to each other. Summarize them into a single concise description that captures the core theme and key details.

${languageLine}

Cluster moments:
${momentLines}

Output JSON format:
{
  "theme": "short topic label",
  "summary": "concise description of the cluster's core content",
  "representative_indices": [0, 2]
}

The representative_indices should point to the most informative moments in the cluster (0-based indices into the list above).
Return only valid JSON.`;

  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 60000);
  const url = 'https://api.openai.com/v1/chat/completions';

  const response = await axios.post(
    url,
    {
      model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
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
  if (!text || typeof text !== 'string') {
    debugLog('Cluster compression missing text', response.data);
    console.error('[LLM] FULL RESPONSE:', JSON.stringify(response.data, null, 2).slice(0, 4000));
    return {
      theme: 'Cluster',
      summary: clusterTexts.slice(0, 2).join(' ').slice(0, 500),
      representative_indices: [0]
    };
  }

  try {
    const extracted = extractJson(text);
    const parsed = JSON.parse(extracted);
    console.error('[LLM] CLUSTER RAW:', text.slice(0, 2000));
    console.error('[LLM] CLUSTER EXTRACTED:', extracted.slice(0, 2000));
    return {
      theme: parsed.theme || 'Cluster',
      summary: parsed.summary || clusterTexts.slice(0, 2).join(' ').slice(0, 500),
      representative_indices: Array.isArray(parsed.representative_indices)
        ? parsed.representative_indices
        : [0]
    };
  } catch (err) {
    debugLog('Cluster compression JSON parse failed', text);
    console.error('[LLM] CLUSTER RAW:', text.slice(0, 2000));
    console.error('[LLM] CLUSTER EXTRACTED:', extractJson(text).slice(0, 2000));
    console.error('[LLM] CLUSTER ERROR:', err.message);
    return {
      theme: 'Cluster',
      summary: clusterTexts.slice(0, 2).join(' ').slice(0, 500),
      representative_indices: [0]
    };
  }
}

function buildRagPrompt(promptBody, outputLanguage, items, ragContext) {
  const languageLine = outputLanguage === 'english' ? 'Output language: English.' : 'Output language: Hinglish.';

  let contextSection = '';
  if (ragContext && ragContext.length > 0) {
    const contextLines = ragContext
      .map((record, index) => {
        const typeLabel = record.type || 'insight';
        const topic = record.topic || '';
        const summary = record.summary || '';
        const anchor = record.recall_anchor ? ` (Recall: ${record.recall_anchor})` : '';
        const count = record.occurrence_count ? ` [seen ${record.occurrence_count}x]` : '';
        return `${index + 1}. [${typeLabel}] ${topic}${count}${anchor} — ${summary}`;
      })
      .join('\n');

    contextSection = `\n\nPast Context (from your learning history):\n${contextLines}\n\nAnalyze the items below in light of this past context. Identify recurring patterns, unresolved gaps, or evolving misunderstandings that connect to what you've already encountered.`;
  }

  const itemLines = items
    .map((item, index) => `${index}. ${item.summary || item.text}`)
    .join('\n');

  return `${promptBody}\n\n${languageLine}${contextSection}\n\nItems (indexed, chronological):\n${itemLines}`;
}

async function analyzeWithPrompt({ prompt, outputLanguage }) {
  console.error('[LLM-DEBUG-12345] analyzeWithPrompt called');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS || 60000);

  const url = 'https://api.openai.com/v1/chat/completions';

  const response = await axios.post(
    url,
    {
      model,
      messages: [
        {
          role: 'system',
          content: 'You must return findings as a JSON array. Even if uncertain, return your best guess. If no findings exist, return []. Never return null or empty text.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    },
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: timeoutMs
    }
  );

  console.error('[LLM] STATUS:', response.status);
  console.error('[LLM] FULL DATA:', JSON.stringify(response.data, null, 2).slice(0, 5000));
  console.error('[LLM] PROMPT SENT:', prompt.slice(0, 4000));
  
  const text = response.data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    debugLog('OpenAI response missing text', response.data);
    console.error('[LLM] FULL RESPONSE:', JSON.stringify(response.data, null, 2).slice(0, 4000));
    return [];
  }

  try {
    const extracted = extractJson(text);
    console.error('[LLM] RAW TEXT:', text.slice(0, 3000));
    console.error('[LLM] EXTRACTED JSON:', extracted.slice(0, 3000));
    const parsed = JSON.parse(extracted);
    console.error('[LLM] PARSED:', JSON.stringify(parsed, null, 2).slice(0, 5000));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    debugLog('OpenAI JSON parse failed', text);
    console.error('[LLM] RAW:', text.slice(0, 3000));
    console.error('[LLM] EXTRACTED:', extractJson(text).slice(0, 3000));
    console.error('[LLM] ERROR:', err.message);
    return [];
  }
}

module.exports = { analyzeMoments, analyzeWithPrompt, compressCluster, buildRagPrompt };

function sanitizeMoment(text) {
  if (!text || typeof text !== 'string') return '';
  const lines = text.split('\n');
  const cleaned = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isChromeNoise(line))
    .filter((line) => !isChatUiNoise(line));
  return cleaned.join(' ');
}

function isChromeNoise(line) {
  return (
    line.length <= 2 ||
    line === '⋮' ||
    line === '...' ||
    line === 'Copy code' ||
    line === 'Share'
  );
}

function isChatUiNoise(line) {
  const lower = line.toLowerCase();
  return (
    lower === 'skip to content' ||
    lower === 'chat history' ||
    lower === 'new chat' ||
    lower === 'search chats' ||
    lower === 'images' ||
    lower === 'apps' ||
    lower === 'gpts' ||
    lower === 'projects' ||
    lower === 'recent' ||
    lower === 'your chats' ||
    lower === 'share' ||
    lower === 'copy code'
  );
}
