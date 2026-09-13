'use strict';
const { createAnthropicProvider, JSON_ONLY_LINE, API_URL } = require('../../src/lc/services/llm/anthropic');
const { REPLY_JSON_SCHEMA } = require('../../src/lc/services/llm/schema');
const { LlmError } = require('../../src/lc/services/llm/parse');

// ---- synthetic fixtures (no real student data) ----
const REPLY = { reply: 'Think about what a sub-answer would represent for a prefix. What would you index it by?', rung: 2, anchors_used: ['synthetic-anchor-a'], habits_used: [], asks_question: true, self_check: 'student needs the state, not the transition' };
const SYSTEM = 'RULES: word the hint only.';
const USER = 'STUDENT MESSAGE\nI am stuck on synthetic-problem-2.';

function resLike(status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}
function okBody(reply = REPLY, extra = {}) {
  return {
    id: 'msg_synthetic', type: 'message', role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(reply) }],
    usage: { input_tokens: 3500, output_tokens: 120, cache_read_input_tokens: 0 },
    ...extra
  };
}
/** fetch that never resolves but rejects with AbortError when the signal aborts (real fetch behaviour). */
function hangingFetch() {
  return (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
}

function makeProvider(fetchImpl, overrides = {}) {
  let t = 0;
  const now = () => { t += 100; return t; };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const provider = createAnthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-5', timeoutMs: 40, fetchImpl, now, logger, ...overrides });
  return { provider, logger };
}
function bodyOf(fetchImpl, i = 0) { return JSON.parse(fetchImpl.mock.calls[i][1].body); }

describe('anthropic provider: request shape', () => {
  test('POSTs to the messages endpoint with the required headers', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(resLike(200, okBody()));
    const { provider } = makeProvider(fetchImpl);
    await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(url).toBe(API_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('body has model, max_tokens 4000, system, messages, output_config json_schema, fallbacks default and NO sampling/thinking keys', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(resLike(200, okBody()));
    const { provider } = makeProvider(fetchImpl);
    const history = [{ role: 'user', text: 'first ask' }, { role: 'assistant', text: 'first hint' }];
    await provider.generate({ system: SYSTEM, history, user: USER });
    const body = bodyOf(fetchImpl);
    expect(body.model).toBe('claude-opus-5');
    expect(body.max_tokens).toBe(4000);
    expect(body.system).toBe(SYSTEM);
    expect(body.messages).toEqual([
      { role: 'user', content: 'first ask' },
      { role: 'assistant', content: 'first hint' },
      { role: 'user', content: USER }
    ]);
    expect(body.output_config).toEqual({ effort: 'low', format: { type: 'json_schema', schema: REPLY_JSON_SCHEMA } });
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.fallbacks).toBe('default');
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'thinking', 'stream', 'tools']) expect(body).not.toHaveProperty(forbidden);
    expect(Object.keys(body).sort()).toEqual(['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
  });

  test('history is trimmed to the last 10 turns and starts with a user turn', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(resLike(200, okBody()));
    const { provider } = makeProvider(fetchImpl);
    const history = [{ role: 'assistant', text: 'a0' }];
    for (let i = 1; i <= 12; i += 1) history.push({ role: i % 2 ? 'user' : 'assistant', text: `m${i}` });
    await provider.generate({ system: SYSTEM, history, user: USER });
    const { messages } = bodyOf(fetchImpl);
    expect(messages.length).toBeLessThanOrEqual(11);
    expect(messages[0]).toEqual({ role: 'user', content: 'm3' });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: USER });
    expect(messages.some((m) => m.content === 'a0')).toBe(false);
  });

  test('default model is claude-opus-5 when none is given', () => {
    const provider = createAnthropicProvider({ apiKey: 'sk-test', fetchImpl: jest.fn() });
    expect(provider.model).toBe('claude-opus-5');
    expect(provider.provider).toBe('anthropic');
  });
});

describe('anthropic provider: response parsing', () => {
  test('parses the first text block (skipping non-text blocks) and maps usage with cache_read', async () => {
    const body = okBody(REPLY, { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: JSON.stringify(REPLY) }], usage: { input_tokens: 3000, output_tokens: 150, cache_read_input_tokens: 2500 } });
    const fetchImpl = jest.fn().mockResolvedValue(resLike(200, body));
    const { provider } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.usage).toEqual({ input_tokens: 3000, output_tokens: 150, total_tokens: 3150, cache_read: 2500 });
    expect(out.provider).toBe('anthropic');
    expect(out.model).toBe('claude-opus-5');
    expect(out.latency_ms).toBe(100);
    expect(out.raw_text).toBe(JSON.stringify(REPLY));
    expect(out.stop_reason).toBe('end_turn');
    expect(out.attempts).toBe(1);
    expect(out.output_config_fallback).toBe(false);
  });

  test('brace-scan fallback when the text block has chatter around the object', async () => {
    const text = 'Here is the hint:\n' + JSON.stringify(REPLY) + '\nHope that helps.';
    const fetchImpl = jest.fn().mockResolvedValue(resLike(200, okBody(REPLY, { content: [{ type: 'text', text }] })));
    const { provider } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.parse_via).toBe('scan');
  });

  test('stop_reason refusal → LlmError(refusal), no retry', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(resLike(200, okBody(REPLY, { stop_reason: 'refusal', content: [] })));
    const { provider } = makeProvider(fetchImpl);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('refusal');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('unparseable text twice → LlmError(parse) after 2 attempts', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(resLike(200, okBody(REPLY, { content: [{ type: 'text', text: 'sorry, plain prose' }] })));
    const { provider } = makeProvider(fetchImpl);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err.code).toBe('parse');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('max_tokens truncation → parse failure → retry → success', async () => {
    const truncated = okBody(REPLY, { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"reply": "this got cut' }] });
    const fetchImpl = jest.fn().mockResolvedValueOnce(resLike(200, truncated)).mockResolvedValueOnce(resLike(200, okBody()));
    const { provider } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.attempts).toBe(2);
  });
});

describe('anthropic provider: http errors, timeout, retry', () => {
  test('429 then 200 → success with exactly one retry', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(resLike(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }))
      .mockResolvedValueOnce(resLike(200, okBody()));
    const { provider, logger } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.attempts).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const line = JSON.parse(logger.warn.mock.calls[0][0]);
    expect(line).toMatchObject({ evt: 'lc.llm.retry', provider: 'anthropic', code: 'http', status: 429 });
    expect(logger.warn.mock.calls[0][0]).not.toContain(USER);
  });

  test('500 twice → LlmError(http) with status 500 after 2 attempts', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(resLike(500, { type: 'error', error: { type: 'api_error', message: 'internal' } }));
    const { provider } = makeProvider(fetchImpl);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('http');
    expect(err.status).toBe(500);
    expect(err.message).toContain('internal');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('529 overloaded is treated like 5xx (retried)', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(resLike(529, { error: { message: 'overloaded' } })).mockResolvedValueOnce(resLike(200, okBody()));
    const { provider } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.attempts).toBe(2);
  });

  test('400 (not about output_config) and 401 are never retried', async () => {
    for (const [status, msg] of [[400, 'messages: roles must alternate'], [401, 'invalid x-api-key'], [403, 'forbidden'], [404, 'model not found']]) {
      const fetchImpl = jest.fn().mockResolvedValue(resLike(status, { type: 'error', error: { type: 'invalid_request_error', message: msg } }));
      const { provider } = makeProvider(fetchImpl);
      const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
      expect(err.code).toBe('http');
      expect(err.status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test('timeout aborts the fetch via the signal, retries once, then LlmError(timeout)', async () => {
    const fetchImpl = jest.fn().mockImplementation(hangingFetch());
    const { provider } = makeProvider(fetchImpl);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
  });

  test('timeout then success', async () => {
    const fetchImpl = jest.fn().mockImplementationOnce(hangingFetch()).mockResolvedValueOnce(resLike(200, okBody()));
    const { provider } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.attempts).toBe(2);
  });

  test('network failure (fetch rejects) is an http error with status 0 and is not retried', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { provider } = makeProvider(fetchImpl);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err.code).toBe('http');
    expect(err.status).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('anthropic provider: output_config fallback', () => {
  test('400 mentioning output_config → re-sent once without output_config, JSON-only system line appended, logged', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(resLike(400, { type: 'error', error: { type: 'invalid_request_error', message: 'output_config: Extra inputs are not permitted' } }))
      .mockResolvedValueOnce(resLike(200, okBody()));
    const { provider, logger } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.output_config_fallback).toBe(true);
    expect(out.attempts).toBe(1); // the fallback re-send is not a retry
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = bodyOf(fetchImpl, 0);
    const second = bodyOf(fetchImpl, 1);
    expect(first).toHaveProperty('output_config');
    expect(second).not.toHaveProperty('output_config');
    expect(second.system).toBe(`${SYSTEM}\n${JSON_ONLY_LINE}`);
    expect(second.system.endsWith(JSON_ONLY_LINE)).toBe(true);
    expect(second.fallbacks).toBe('default');
    expect(second.max_tokens).toBe(4000);
    expect(second).not.toHaveProperty('temperature');
    const warned = logger.warn.mock.calls.map((c) => JSON.parse(c[0]));
    expect(warned.some((l) => l.evt === 'lc.llm.output_config_fallback' && l.provider === 'anthropic')).toBe(true);
    for (const c of logger.warn.mock.calls) expect(c[0]).not.toContain(USER);
  });

  test('the fallback happens at most once per call: a second output_config 400 after fallback surfaces as http 400', async () => {
    const reject = () => resLike(400, { error: { message: 'output_config is not supported' } });
    const fetchImpl = jest.fn().mockResolvedValueOnce(reject()).mockResolvedValueOnce(reject());
    const { provider } = makeProvider(fetchImpl);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err.code).toBe('http');
    expect(err.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('after the fallback, a retryable failure retries without output_config too', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(resLike(400, { error: { message: 'output_config: unknown field' } }))
      .mockResolvedValueOnce(resLike(500, { error: { message: 'internal' } }))
      .mockResolvedValueOnce(resLike(200, okBody()));
    const { provider } = makeProvider(fetchImpl);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchImpl, 2)).not.toHaveProperty('output_config');
    expect(bodyOf(fetchImpl, 2).system.endsWith(JSON_ONLY_LINE)).toBe(true);
  });
});

describe('anthropic provider: configuration', () => {
  test('missing api key → LlmError(config)', () => {
    let err;
    try { createAnthropicProvider({ apiKey: '', fetchImpl: jest.fn() }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('config');
  });

  test('empty user turn → LlmError(config) without calling fetch', async () => {
    const fetchImpl = jest.fn();
    const { provider } = makeProvider(fetchImpl);
    const err = await provider.generate({ system: SYSTEM, history: [], user: '   ' }).catch((e) => e);
    expect(err.code).toBe('config');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
