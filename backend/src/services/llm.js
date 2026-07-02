const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_RETRIES = 2;

function getTimeoutMs() {
  const val = Number(process.env.OPENAI_TIMEOUT_MS);
  return val > 0 ? val : DEFAULT_TIMEOUT_MS;
}

function getMaxRetries() {
  const val = Number(process.env.OPENAI_LLM_RETRIES);
  return val >= 0 && val <= 10 ? val : DEFAULT_MAX_RETRIES;
}

function getLLMProvider() {
  return (process.env.LLM_PROVIDER || 'openai').toLowerCase();
}

function getLLMModel() {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

function getGeminiModel() {
  return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) => {
    const err = new Error(`Request timed out after ${ms}ms`);
    err.code = 'ETIMEDOUT';
    setTimeout(() => reject(err), ms);
  });
  return Promise.race([promise, timeout]);
}

async function withRetry(fn, maxRetries) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (err.response?.status === 429 && attempt < maxRetries) {
        const retryAfter = err.response.headers['retry-after'];
        const waitMs = retryAfter
          ? Number(retryAfter) * 1000
          : 2000 * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }

      if ((err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') && attempt < maxRetries) {
        const waitMs = 1000 * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }

      if (err.response?.status >= 500 && attempt < maxRetries) {
        const waitMs = 1000 * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }

      break;
    }
  }
  throw lastError;
}

function buildPrompt(promptBody, outputLanguage, moments) {
  const languageLine = outputLanguage === 'english' ? 'Output language: English.' : 'Output language: Hinglish.';
  if (!Array.isArray(moments)) return `${promptBody}\n\n${languageLine}\n\nMoments (indexed, chronological):\n`;

  const momentLines = moments
    .map((text, index) => `${index}. ${sanitizeMoment(text)}`)
    .filter((line) => line.trim().length > 0)
    .join('\n');

  return `${promptBody}\n\n${languageLine}\n\nMoments (indexed, chronological):\n${momentLines}`;
}

async function analyzeMoments({ moments, promptBody, outputLanguage }) {
  const provider = getLLMProvider();
  console.log('[LLM] Using provider:', provider);

  if (!Array.isArray(moments) || moments.length === 0) return [];

  const prompt = buildPrompt(promptBody, outputLanguage, moments);
  const timeoutMs = getTimeoutMs();

  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: getGeminiModel(),
      generationConfig: { responseMimeType: 'application/json' }
    });

    const fetchFn = async () => {
      const result = await withTimeout(model.generateContent(prompt), timeoutMs);
      return result;
    };

    try {
      const result = await withRetry(fetchFn, getMaxRetries());
      const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
      return parseLLMResponse({ data: { choices: [{ message: { content: text } }] } });
    } catch (err) {
      console.error('[LLM] analyzeMoments (Gemini) failed after retries:', err.message);
      return [];
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const model = getLLMModel();
  const url = 'https://api.openai.com/v1/chat/completions';

  const fetchFn = async () => {
    const response = await axios.post(
      url,
      {
        model,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: timeoutMs
      }
    );
    return response;
  };

  let response;
  try {
    response = await withRetry(fetchFn, getMaxRetries());
  } catch (err) {
    console.error('[LLM] analyzeMoments failed after retries:', err.message);
    return [];
  }

  return parseLLMResponse(response);
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return '[]';
  const trimmed = text.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1] && fenced[1].trim().length > 0) {
    return fenced[1].trim();
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }

  const firstCurly = trimmed.indexOf('{');
  const lastCurly = trimmed.lastIndexOf('}');
  if (firstCurly !== -1 && lastCurly !== -1 && lastCurly > firstCurly) {
    return trimmed.slice(firstCurly, lastCurly + 1);
  }

  return trimmed;
}

function parseLLMResponse(response) {
  const text = response.data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    return [];
  }

  try {
    const extracted = extractJson(text);
    const parsed = JSON.parse(extracted);
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'object' && parsed !== null) return [parsed];
    return [];
  } catch (err) {
    return [];
  }
}

async function analyzeWithPrompt({ prompt, outputLanguage }) {
  const provider = getLLMProvider();
  console.log('[LLM] Using provider:', provider);

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return [];
  }

  const timeoutMs = getTimeoutMs();

  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }

    const systemMessage = 'You must return findings as a JSON array. Even if uncertain, return your best guess. If no findings exist, return []. Never return null or empty text.';
    const fullPrompt = `${systemMessage}\n\n${prompt}`;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: getGeminiModel(),
      generationConfig: { responseMimeType: 'application/json' }
    });

    const fetchFn = async () => {
      const result = await withTimeout(model.generateContent(fullPrompt), timeoutMs);
      return result;
    };

    try {
      const result = await withRetry(fetchFn, getMaxRetries());
      const text = result.response?.candidates?.[0]?.content?.parts?.[0]?.text;
      return parseLLMResponse({ data: { choices: [{ message: { content: text } }] } });
    } catch (err) {
      console.error('[LLM] analyzeWithPrompt (Gemini) failed after retries:', err.message);
      return [];
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set');
  }

  const model = getLLMModel();
  const url = 'https://api.openai.com/v1/chat/completions';

  const fetchFn = async () => {
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
    return response;
  };

  let response;
  try {
    response = await withRetry(fetchFn, getMaxRetries());
  } catch (err) {
    console.error('[LLM] analyzeWithPrompt failed after retries:', err.message);
    return [];
  }

  return parseLLMResponse(response);
}

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

module.exports = { analyzeMoments, analyzeWithPrompt };
