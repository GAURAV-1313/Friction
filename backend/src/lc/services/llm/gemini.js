'use strict';
/**
 * Gemini provider over @google/generative-ai 0.24.1.
 *
 * Per call: getGenerativeModel({model, systemInstruction, generationConfig}) → startChat({history})
 * → sendMessage(user). `thinkingConfig.thinkingBudget: 0` is untyped in 0.24.1 but passes through
 * to the API; without it gemini-2.5-flash thinks by default and blows the latency budget.
 * Timeout via Promise.race (the signal is also handed to the SDK so its HTTP call is cancelled).
 * One retry on timeout / 429 / 5xx / unparseable output.
 */
const { GEMINI_RESPONSE_SCHEMA } = require('./schema');
const { LlmError, parseReplyText, trimHistory, runWithTimeout, withRetry, isAbortError } = require('./parse');

const PROVIDER = 'gemini';

function toGeminiHistory(history) {
  return history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] }));
}

function mapUsage(meta) {
  const u = meta && typeof meta === 'object' ? meta : {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const usage = {
    input_tokens: n(u.promptTokenCount),
    output_tokens: n(u.candidatesTokenCount),
    total_tokens: n(u.totalTokenCount),
    thoughts_tokens: n(u.thoughtsTokenCount)
  };
  if (Number.isFinite(u.cachedContentTokenCount)) usage.cached_tokens = u.cachedContentTokenCount;
  return usage;
}

/** Maps SDK errors onto LlmError codes. */
function classifyError(err, signal) {
  if (err && err.name === 'LlmError') return err;
  if (isAbortError(err) || (signal && signal.aborted)) return new LlmError('timeout', 'gemini request aborted', { provider: PROVIDER, cause: err });
  const name = err && err.name;
  if (name === 'GoogleGenerativeAIFetchError' || Number.isInteger(err && err.status)) {
    return new LlmError('http', `gemini http ${err.status}: ${err.message}`, { provider: PROVIDER, status: err.status, cause: err });
  }
  if (name === 'GoogleGenerativeAIResponseError' || /blocked|SAFETY|RECITATION|PROHIBITED/i.test(String(err && err.message))) {
    return new LlmError('refusal', `gemini response blocked: ${err.message}`, { provider: PROVIDER, cause: err });
  }
  if (name === 'GoogleGenerativeAIRequestInputError') {
    return new LlmError('config', `gemini request rejected: ${err.message}`, { provider: PROVIDER, cause: err });
  }
  return new LlmError('http', `gemini error: ${err && err.message ? err.message : String(err)}`, { provider: PROVIDER, cause: err });
}

/**
 * @param {{apiKey:string, model:string, timeoutMs?:number, GoogleGenerativeAI:Function, now?:Function, logger?:{warn:Function}}} opts
 */
function createGeminiProvider({ apiKey, model, timeoutMs = 15000, GoogleGenerativeAI, now = Date.now, logger = console }) {
  if (!apiKey) throw new LlmError('config', 'GEMINI_API_KEY is not set', { provider: PROVIDER });
  if (typeof GoogleGenerativeAI !== 'function') throw new LlmError('config', 'GoogleGenerativeAI class is required', { provider: PROVIDER });
  const genAI = new GoogleGenerativeAI(apiKey);

  async function generate({ system, history = [], user } = {}) {
    if (typeof user !== 'string' || !user.trim()) throw new LlmError('config', 'generate() needs a non-empty user turn', { provider: PROVIDER });
    const t0 = now();
    const trimmed = trimHistory(history);
    const genModel = genAI.getGenerativeModel({
      model,
      systemInstruction: system,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: GEMINI_RESPONSE_SCHEMA,
        temperature: 0.3,
        maxOutputTokens: 1500,
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    let attempts = 0;
    let parseVia = null;

    const result = await withRetry(async () => {
      attempts += 1;
      const chat = genModel.startChat({ history: toGeminiHistory(trimmed) });
      let sdkResult;
      let lastSignal = null;
      try {
        sdkResult = await runWithTimeout((signal) => { lastSignal = signal; return chat.sendMessage(user, { signal }); }, timeoutMs, { provider: PROVIDER });
      } catch (err) {
        throw classifyError(err, lastSignal);
      }
      const response = sdkResult && sdkResult.response;
      let text;
      try {
        text = response && typeof response.text === 'function' ? response.text() : '';
      } catch (err) {
        throw classifyError(err, null);
      }
      const parsed = parseReplyText(text);
      if (!parsed.ok) {
        const finish = response && Array.isArray(response.candidates) && response.candidates[0] ? response.candidates[0].finishReason : undefined;
        throw new LlmError('parse', `gemini reply not schema-valid (${parsed.errors.join(',')})${finish ? ` finish=${finish}` : ''}`, { provider: PROVIDER });
      }
      parseVia = parsed.via;
      return { parsed: parsed.parsed, raw_text: text, usage: mapUsage(response.usageMetadata) };
    }, {
      onRetry: (err) => {
        if (logger && typeof logger.warn === 'function') logger.warn(JSON.stringify({ evt: 'lc.llm.retry', provider: PROVIDER, model, code: err.code, status: err.status }));
      }
    });

    return {
      parsed: result.parsed,
      usage: result.usage,
      provider: PROVIDER,
      model,
      latency_ms: now() - t0,
      raw_text: result.raw_text,
      attempts,
      parse_via: parseVia
    };
  }

  return { provider: PROVIDER, model, generate };
}

module.exports = { createGeminiProvider, toGeminiHistory, mapUsage };
