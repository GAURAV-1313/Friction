'use strict';
/**
 * LLM client factory: picks the provider from config.provider ('gemini' | 'anthropic'),
 * fails fast with LlmError('config') when the key is missing, and logs exactly one JSON line
 * per call ({evt:'lc.llm', provider, model, latency_ms, usage}) - never the prompt or the reply.
 *
 * createLlmClient(config, { fetchImpl, GoogleGenerativeAI, now, logger })
 *   → { provider, model, generate({ system, history, user }) → Promise<{ parsed, usage, provider, model, latency_ms, raw_text }> }
 */
const { LlmError } = require('./parse');
const { createGeminiProvider } = require('./gemini');
const { createAnthropicProvider } = require('./anthropic');

const PROVIDERS = ['gemini', 'anthropic'];

function loadGoogleSdk() {
  // Required lazily so the anthropic path (and tests) never touch the SDK.
  // eslint-disable-next-line global-require
  return require('@google/generative-ai').GoogleGenerativeAI;
}

function createLlmClient(config, { fetchImpl = globalThis.fetch, GoogleGenerativeAI, now = Date.now, logger = console } = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const provider = String(cfg.provider || 'gemini').toLowerCase();
  const timeoutMs = Number.isFinite(cfg.llmTimeoutMs) && cfg.llmTimeoutMs > 0 ? cfg.llmTimeoutMs : 15000;

  let inner;
  if (provider === 'gemini') {
    if (!cfg.geminiApiKey) throw new LlmError('config', 'GEMINI_API_KEY is not set (LC_LLM_PROVIDER=gemini)', { provider });
    inner = createGeminiProvider({
      apiKey: cfg.geminiApiKey,
      model: cfg.geminiModel || 'gemini-2.5-flash',
      timeoutMs,
      GoogleGenerativeAI: GoogleGenerativeAI || loadGoogleSdk(),
      now,
      logger
    });
  } else if (provider === 'anthropic') {
    if (!cfg.anthropicApiKey) throw new LlmError('config', 'ANTHROPIC_API_KEY is not set (LC_LLM_PROVIDER=anthropic)', { provider });
    inner = createAnthropicProvider({
      apiKey: cfg.anthropicApiKey,
      model: cfg.anthropicModel || 'claude-opus-5',
      timeoutMs,
      fetchImpl,
      now,
      logger
    });
  } else {
    throw new LlmError('config', `unknown LC_LLM_PROVIDER "${provider}" (expected ${PROVIDERS.join(' | ')})`, { provider });
  }

  const log = (line) => { if (logger && typeof logger.log === 'function') logger.log(JSON.stringify(line)); };
  const warn = (line) => { if (logger && typeof logger.warn === 'function') logger.warn(JSON.stringify(line)); };

  async function generate(input) {
    const t0 = now();
    try {
      const out = await inner.generate(input);
      log({ evt: 'lc.llm', provider: inner.provider, model: inner.model, latency_ms: out.latency_ms, usage: out.usage, attempts: out.attempts });
      return out;
    } catch (err) {
      const e = err && err.name === 'LlmError' ? err : new LlmError('http', err && err.message ? err.message : String(err), { provider: inner.provider, cause: err });
      warn({ evt: 'lc.llm.error', provider: inner.provider, model: inner.model, code: e.code, status: e.status, latency_ms: now() - t0 });
      throw e;
    }
  }

  return { provider: inner.provider, model: inner.model, generate };
}

module.exports = { createLlmClient, LlmError, PROVIDERS };
