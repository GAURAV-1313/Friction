'use strict';
/**
 * Anthropic Messages API provider over raw fetch (no SDK; Node 24 has global fetch).
 *
 * Request: POST https://api.anthropic.com/v1/messages with the structured-output config
 * (output_config.format json_schema + effort low) and server-side fallbacks. Never sends
 * temperature / top_p / top_k / thinking: those 400 on Opus 5 and Sonnet 5.
 * Timeout via AbortController; one retry on timeout / 429 / 5xx / unparseable output.
 * If the API rejects `output_config` with a 400, the same call is re-sent once without it and
 * with a JSON-only system line appended (logged as lc.llm.output_config_fallback).
 */
const { REPLY_JSON_SCHEMA } = require('./schema');
const { LlmError, parseReplyText, trimHistory, runWithTimeout, withRetry, isAbortError } = require('./parse');

const PROVIDER = 'anthropic';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const BETA_HEADER = 'server-side-fallback-2026-07-01';
const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 4000;
const JSON_ONLY_LINE = 'Return exactly one JSON object with keys reply, rung, anchors_used, habits_used, asks_question, self_check and nothing else.';

function toAnthropicMessages(history, user) {
  return [...history.map((m) => ({ role: m.role, content: m.text })), { role: 'user', content: user }];
}

function buildBody({ model, system, history, user, withOutputConfig }) {
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system: withOutputConfig ? system : `${system || ''}\n${JSON_ONLY_LINE}`.trim(),
    messages: toAnthropicMessages(history, user),
    fallbacks: 'default'
  };
  if (withOutputConfig) body.output_config = { effort: 'low', format: { type: 'json_schema', schema: REPLY_JSON_SCHEMA } };
  return body;
}

/** Reads a Response (real or fake) once: prefers text() then parses, else json(). */
async function readBody(res) {
  let raw = '';
  let data = null;
  if (res && typeof res.text === 'function') {
    raw = await res.text();
    if (typeof raw !== 'string') raw = raw === undefined || raw === null ? '' : String(raw);
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
  } else if (res && typeof res.json === 'function') {
    try { data = await res.json(); raw = JSON.stringify(data); } catch (_) { data = null; }
  }
  return { raw, data };
}

function errorMessageOf(data, raw) {
  if (data && data.error && typeof data.error.message === 'string') return data.error.message;
  if (data && typeof data.message === 'string') return data.message;
  return typeof raw === 'string' ? raw.slice(0, 500) : '';
}

function mapUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const out = { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens) };
  out.total_tokens = out.input_tokens + out.output_tokens;
  if (Number.isFinite(u.cache_read_input_tokens)) out.cache_read = u.cache_read_input_tokens;
  if (Number.isFinite(u.cache_creation_input_tokens)) out.cache_creation = u.cache_creation_input_tokens;
  return out;
}

/**
 * @param {{apiKey:string, model?:string, timeoutMs?:number, fetchImpl?:Function, now?:Function, logger?:{warn:Function}}} opts
 */
function createAnthropicProvider({ apiKey, model = DEFAULT_MODEL, timeoutMs = 15000, fetchImpl = globalThis.fetch, now = Date.now, logger = console }) {
  if (!apiKey) throw new LlmError('config', 'ANTHROPIC_API_KEY is not set', { provider: PROVIDER });
  if (typeof fetchImpl !== 'function') throw new LlmError('config', 'fetch implementation is required', { provider: PROVIDER });
  const resolvedModel = model || DEFAULT_MODEL;
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    'content-type': 'application/json',
    'anthropic-beta': BETA_HEADER
  };

  async function postOnce(body) {
    let res;
    try {
      res = await runWithTimeout(
        (signal) => fetchImpl(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal }),
        timeoutMs,
        { provider: PROVIDER }
      );
    } catch (err) {
      if (err && err.name === 'LlmError') throw err;
      if (isAbortError(err)) throw new LlmError('timeout', 'anthropic request aborted', { provider: PROVIDER, cause: err });
      throw new LlmError('http', `anthropic network error: ${err && err.message ? err.message : String(err)}`, { provider: PROVIDER, status: 0, cause: err });
    }
    const { raw, data } = await readBody(res);
    const status = Number.isInteger(res && res.status) ? res.status : 0;
    const ok = res && typeof res.ok === 'boolean' ? res.ok : status >= 200 && status < 300;
    return { ok, status, raw, data };
  }

  async function generate({ system, history = [], user } = {}) {
    if (typeof user !== 'string' || !user.trim()) throw new LlmError('config', 'generate() needs a non-empty user turn', { provider: PROVIDER });
    const t0 = now();
    const trimmed = trimHistory(history);
    let outputConfigRejected = false; // per call: once the API 400s on output_config, the rest of this call goes without it
    let attempts = 0;
    let parseVia = null;

    const result = await withRetry(async () => {
      attempts += 1;
      let r = await postOnce(buildBody({ model: resolvedModel, system, history: trimmed, user, withOutputConfig: !outputConfigRejected }));

      if (!r.ok && r.status === 400 && !outputConfigRejected && /output_config/i.test(errorMessageOf(r.data, r.raw))) {
        outputConfigRejected = true;
        if (logger && typeof logger.warn === 'function') {
          logger.warn(JSON.stringify({ evt: 'lc.llm.output_config_fallback', provider: PROVIDER, model: resolvedModel, status: 400 }));
        }
        r = await postOnce(buildBody({ model: resolvedModel, system, history: trimmed, user, withOutputConfig: false }));
      }

      if (!r.ok) {
        throw new LlmError('http', `anthropic http ${r.status}: ${errorMessageOf(r.data, r.raw) || 'request failed'}`, { provider: PROVIDER, status: r.status });
      }
      const data = r.data;
      if (!data || typeof data !== 'object') throw new LlmError('parse', 'anthropic response body is not JSON', { provider: PROVIDER });
      if (data.stop_reason === 'refusal') throw new LlmError('refusal', 'anthropic refused the request', { provider: PROVIDER });

      const block = Array.isArray(data.content) ? data.content.find((b) => b && b.type === 'text') : null;
      const text = block && typeof block.text === 'string' ? block.text : '';
      const parsed = parseReplyText(text);
      if (!parsed.ok) {
        throw new LlmError('parse', `anthropic reply not schema-valid (${parsed.errors.join(',')}) stop_reason=${data.stop_reason || 'unknown'}`, { provider: PROVIDER });
      }
      parseVia = parsed.via;
      return { parsed: parsed.parsed, raw_text: text, usage: mapUsage(data.usage), stop_reason: data.stop_reason, served_model: data.model };
    }, {
      onRetry: (err) => {
        if (logger && typeof logger.warn === 'function') logger.warn(JSON.stringify({ evt: 'lc.llm.retry', provider: PROVIDER, model: resolvedModel, code: err.code, status: err.status }));
      }
    });

    return {
      parsed: result.parsed,
      usage: result.usage,
      provider: PROVIDER,
      model: resolvedModel,
      latency_ms: now() - t0,
      raw_text: result.raw_text,
      attempts,
      parse_via: parseVia,
      stop_reason: result.stop_reason,
      served_model: result.served_model,
      output_config_fallback: outputConfigRejected
    };
  }

  return { provider: PROVIDER, model: resolvedModel, generate };
}

module.exports = { createAnthropicProvider, buildBody, toAnthropicMessages, mapUsage, API_URL, API_VERSION, BETA_HEADER, DEFAULT_MODEL, MAX_TOKENS, JSON_ONLY_LINE };
