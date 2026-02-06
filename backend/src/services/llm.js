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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const prompt = buildPrompt(promptBody, outputLanguage, moments);
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 60000);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await axios.post(
    url,
    {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }]
        }
      ]
    },
    {
      params: { key: apiKey },
      timeout: timeoutMs
    }
  );

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || typeof text !== 'string') {
    debugLog('Gemini response missing text', response.data);
    return [];
  }

  try {
    const extracted = extractJson(text);
    const parsed = JSON.parse(extracted);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    debugLog('Gemini JSON parse failed', text);
    return [];
  }
}

function extractJson(text) {
  const fenced = text.match(/```json\\s*([\\s\\S]*?)\\s*```/i);
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

module.exports = { analyzeMoments };

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
