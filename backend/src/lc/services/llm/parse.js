'use strict';
/**
 * Shared, provider-agnostic pieces of the LLM layer: the error class, reply parsing,
 * history trimming, and the timeout / retry wrappers. Pure except for the timers in
 * runWithTimeout (which takes `now` and uses global setTimeout so tests can fake it).
 */
const { validateReply } = require('./schema');

const LLM_ERROR_CODES = ['timeout', 'http', 'parse', 'refusal', 'config'];

class LlmError extends Error {
  /**
   * @param {'timeout'|'http'|'parse'|'refusal'|'config'} code
   * @param {string} message
   * @param {{status?: number, cause?: any, provider?: string}} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'LlmError';
    this.code = LLM_ERROR_CODES.includes(code) ? code : 'http';
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.provider) this.provider = extra.provider;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/** True when a failed attempt is worth exactly one more try: timeout, 429, 5xx, or unparseable output. */
function isRetryable(err) {
  if (!err || err.name !== 'LlmError') return false;
  if (err.code === 'timeout' || err.code === 'parse') return true;
  if (err.code === 'http') return err.status === 429 || (Number.isInteger(err.status) && err.status >= 500);
  return false;
}

/**
 * Returns the first balanced `{...}` object in `text` as a string, or null.
 * Brace-depth scan that honours JSON strings and escape sequences (no regex).
 */
function extractFirstJsonObject(text) {
  if (typeof text !== 'string') return null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inString = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue; }
    if (ch === '}') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJson(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch (err) { return { ok: false, error: err.message }; }
}

/**
 * Turns a model's raw text into a validated reply object.
 * Strategy: JSON.parse the whole text; if that fails (or validation fails), fall back to the
 * first balanced JSON object found by brace scanning (handles ```json fences and chatter).
 * @returns {{ok: true, parsed: object, via: 'direct'|'scan'} | {ok: false, errors: string[]}}
 */
function parseReplyText(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['empty_text'] };
  const errors = [];
  const direct = tryParseJson(text.trim());
  if (direct.ok) {
    const v = validateReply(direct.value);
    if (v.ok) return { ok: true, parsed: direct.value, via: 'direct' };
    errors.push(...v.errors.map((e) => `direct:${e}`));
  } else {
    errors.push('direct:invalid_json');
  }
  const candidate = extractFirstJsonObject(text);
  if (candidate && candidate !== text.trim()) {
    const scanned = tryParseJson(candidate);
    if (scanned.ok) {
      const v = validateReply(scanned.value);
      if (v.ok) return { ok: true, parsed: scanned.value, via: 'scan' };
      errors.push(...v.errors.map((e) => `scan:${e}`));
    } else {
      errors.push('scan:invalid_json');
    }
  } else if (!candidate) {
    errors.push('scan:no_object');
  }
  return { ok: false, errors };
}

/**
 * Keeps the last `max` well-formed entries and guarantees the list starts with a 'user' turn
 * (leading 'assistant' entries are dropped). Entries must be {role:'user'|'assistant', text:string}.
 */
function trimHistory(history, max = 10) {
  if (!Array.isArray(history)) return [];
  const clean = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role, text: m.text }));
  const tail = clean.slice(-max);
  let i = 0;
  while (i < tail.length && tail[i].role !== 'user') i += 1;
  return tail.slice(i);
}

/**
 * Runs `task(signal)` with a deadline. The signal is aborted when the deadline passes (so a fetch
 * or SDK call can cancel its HTTP request) and the returned promise rejects with LlmError('timeout').
 * Works both for fetch (AbortController) and for SDK promises that ignore the signal (Promise.race).
 */
function runWithTimeout(task, ms, { provider } = {}) {
  const controller = new AbortController();
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LlmError('timeout', `llm call exceeded ${ms}ms`, { provider }));
    }, ms);
  });
  const work = Promise.resolve().then(() => task(controller.signal));
  return Promise.race([work, deadline]).then(
    (v) => { clearTimeout(timer); return v; },
    (err) => {
      clearTimeout(timer);
      // The underlying call may surface the abort as its own error; normalise it to a timeout.
      if (controller.signal.aborted && !(err && err.name === 'LlmError')) {
        throw new LlmError('timeout', `llm call exceeded ${ms}ms`, { provider, cause: err });
      }
      throw err;
    }
  );
}

/**
 * Calls `attempt(attemptIndex)` and retries once when the failure is retryable (see isRetryable).
 * Never retries on 4xx other than 429, nor on refusal/config errors.
 */
async function withRetry(attempt, { retries = 1, onRetry } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      if (i < retries && isRetryable(err)) {
        if (typeof onRetry === 'function') onRetry(err, i + 1);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function isAbortError(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.name === 'GoogleGenerativeAIAbortError');
}

module.exports = {
  LlmError,
  LLM_ERROR_CODES,
  isRetryable,
  isAbortError,
  extractFirstJsonObject,
  parseReplyText,
  trimHistory,
  runWithTimeout,
  withRetry
};
