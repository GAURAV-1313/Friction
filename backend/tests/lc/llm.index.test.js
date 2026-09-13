'use strict';
const { createLlmClient, LlmError, PROVIDERS } = require('../../src/lc/services/llm');
const { loadConfig } = require('../../src/lc/config');
const { extractFirstJsonObject, parseReplyText, trimHistory, isRetryable } = require('../../src/lc/services/llm/parse');

// ---- synthetic fixtures (no real student data) ----
const REPLY = { reply: 'What does the smallest valid input look like, and what is its answer?', rung: 1, anchors_used: [], habits_used: [], asks_question: true, self_check: 'framing' };
const SYSTEM = 'RULES: word the hint only. SECRET-SYSTEM-MARKER';
const USER = 'STUDENT MESSAGE\nsynthetic problem, SECRET-USER-MARKER';

class FakeGoogleGenerativeAI {
  constructor() { FakeGoogleGenerativeAI.instances += 1; }
  getGenerativeModel() {
    return { startChat: () => ({ sendMessage: async () => ({ response: { text: () => JSON.stringify(REPLY), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 0 } } }) }) };
  }
}
FakeGoogleGenerativeAI.instances = 0;

function anthropicFetch(body) {
  const text = JSON.stringify(body || { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(REPLY) }], usage: { input_tokens: 20, output_tokens: 8 } });
  return jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text });
}

function env(extra) { return { LC_LLM_TIMEOUT_MS: '50', ...extra }; }

describe('createLlmClient: provider selection', () => {
  test('exports both providers by name', () => {
    expect(PROVIDERS).toEqual(['gemini', 'anthropic']);
    expect(LlmError).toBeDefined();
  });

  test('config.provider=gemini with a key → gemini client using the injected SDK', async () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-key', LC_GEMINI_MODEL: 'gemini-2.5-flash' }));
    const logger = { log: jest.fn(), warn: jest.fn() };
    const client = createLlmClient(config, { GoogleGenerativeAI: FakeGoogleGenerativeAI, logger });
    expect(client.provider).toBe('gemini');
    expect(client.model).toBe('gemini-2.5-flash');
    const out = await client.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.provider).toBe('gemini');
    expect(FakeGoogleGenerativeAI.instances).toBeGreaterThan(0);
  });

  test('config.provider=anthropic with a key → anthropic client using the injected fetch; default model claude-opus-5', async () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a-key' }));
    const fetchImpl = anthropicFetch();
    const client = createLlmClient(config, { fetchImpl, logger: { log: jest.fn(), warn: jest.fn() } });
    expect(client.provider).toBe('anthropic');
    expect(client.model).toBe('claude-opus-5');
    const out = await client.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('claude-opus-5');
  });

  test('LC_ANTHROPIC_MODEL overrides the anthropic model; provider name is case-insensitive', () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'Anthropic', ANTHROPIC_API_KEY: 'a-key', LC_ANTHROPIC_MODEL: 'claude-sonnet-5' }));
    const client = createLlmClient(config, { fetchImpl: anthropicFetch() });
    expect(client.provider).toBe('anthropic');
    expect(client.model).toBe('claude-sonnet-5');
  });

  test('provider defaults to gemini when LC_LLM_PROVIDER is unset', () => {
    const config = loadConfig(env({ GEMINI_API_KEY: 'g-key' }));
    const client = createLlmClient(config, { GoogleGenerativeAI: FakeGoogleGenerativeAI });
    expect(client.provider).toBe('gemini');
  });
});

describe('createLlmClient: configuration errors', () => {
  test('gemini without GEMINI_API_KEY → LlmError(config)', () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'gemini' }));
    let err;
    try { createLlmClient(config, { GoogleGenerativeAI: FakeGoogleGenerativeAI }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('config');
    expect(err.message).toMatch(/GEMINI_API_KEY/);
  });

  test('anthropic without ANTHROPIC_API_KEY → LlmError(config)', () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'anthropic' }));
    let err;
    try { createLlmClient(config, { fetchImpl: anthropicFetch() }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('config');
    expect(err.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  test('unknown provider → LlmError(config)', () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'openai', GEMINI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }));
    let err;
    try { createLlmClient(config, { fetchImpl: anthropicFetch(), GoogleGenerativeAI: FakeGoogleGenerativeAI }); } catch (e) { err = e; }
    expect(err.code).toBe('config');
    expect(err.message).toMatch(/openai/);
  });

  test('the anthropic path never touches the Gemini SDK (no injection needed)', () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a-key' }));
    expect(() => createLlmClient(config, { fetchImpl: anthropicFetch() })).not.toThrow();
  });
});

describe('createLlmClient: logging', () => {
  test('logs exactly one lc.llm JSON line per successful call with provider, model, latency_ms, usage; never the prompt or reply', async () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a-key' }));
    const logger = { log: jest.fn(), warn: jest.fn() };
    let t = 0;
    const client = createLlmClient(config, { fetchImpl: anthropicFetch(), logger, now: () => { t += 30; return t; } });
    await client.generate({ system: SYSTEM, history: [{ role: 'user', text: 'SECRET-HISTORY-MARKER' }], user: USER });
    expect(logger.log).toHaveBeenCalledTimes(1);
    const raw = logger.log.mock.calls[0][0];
    const line = JSON.parse(raw);
    expect(line.evt).toBe('lc.llm');
    expect(line.provider).toBe('anthropic');
    expect(line.model).toBe('claude-opus-5');
    expect(typeof line.latency_ms).toBe('number');
    expect(line.usage).toEqual({ input_tokens: 20, output_tokens: 8, total_tokens: 28 });
    for (const marker of ['SECRET-SYSTEM-MARKER', 'SECRET-USER-MARKER', 'SECRET-HISTORY-MARKER', REPLY.reply]) expect(raw).not.toContain(marker);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('on failure it warns one lc.llm.error line with the code and rethrows the LlmError', async () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a-key' }));
    const logger = { log: jest.fn(), warn: jest.fn() };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }), text: async () => JSON.stringify({ error: { message: 'bad key' } }) });
    const client = createLlmClient(config, { fetchImpl, logger });
    const err = await client.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('http');
    expect(err.status).toBe(401);
    expect(logger.log).not.toHaveBeenCalled();
    const lines = logger.warn.mock.calls.map((c) => JSON.parse(c[0]));
    expect(lines.filter((l) => l.evt === 'lc.llm.error')).toHaveLength(1);
    expect(lines.find((l) => l.evt === 'lc.llm.error')).toMatchObject({ provider: 'anthropic', code: 'http', status: 401 });
    for (const c of logger.warn.mock.calls) expect(c[0]).not.toContain('SECRET-USER-MARKER');
  });

  test('a non-LlmError thrown by a provider is wrapped as LlmError(http)', async () => {
    const config = loadConfig(env({ LC_LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'g-key' }));
    class ExplodingSdk { getGenerativeModel() { throw new RangeError('unexpected'); } }
    const client = createLlmClient(config, { GoogleGenerativeAI: ExplodingSdk, logger: { log: jest.fn(), warn: jest.fn() } });
    const err = await client.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('http');
  });
});

describe('parse helpers', () => {
  test('extractFirstJsonObject uses a brace-depth scan that respects strings and escapes', () => {
    expect(extractFirstJsonObject('text {"a": "}", "b": {"c": "\\"}"}} tail')).toBe('{"a": "}", "b": {"c": "\\"}"}}');
    expect(extractFirstJsonObject('no object here')).toBeNull();
    expect(extractFirstJsonObject('unbalanced {"a": 1')).toBeNull();
    expect(extractFirstJsonObject('} stray close then {"ok": true}')).toBe('{"ok": true}');
    expect(extractFirstJsonObject(null)).toBeNull();
  });

  test('parseReplyText: direct, scan, and failure paths', () => {
    expect(parseReplyText(JSON.stringify(REPLY))).toEqual({ ok: true, parsed: REPLY, via: 'direct' });
    expect(parseReplyText('```json\n' + JSON.stringify(REPLY) + '\n```')).toEqual({ ok: true, parsed: REPLY, via: 'scan' });
    expect(parseReplyText('')).toEqual({ ok: false, errors: ['empty_text'] });
    const bad = parseReplyText(JSON.stringify({ ...REPLY, rung: 9 }));
    expect(bad.ok).toBe(false);
    expect(bad.errors).toContain('direct:rung');
    expect(parseReplyText('nothing').ok).toBe(false);
  });

  test('trimHistory keeps the last 10 well-formed turns and drops leading assistant turns', () => {
    const h = [{ role: 'assistant', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }, { role: 'assistant', text: '' }, { role: 'system', text: 'x' }, { role: 'assistant', text: 'd' }];
    expect(trimHistory(h)).toEqual([{ role: 'user', text: 'c' }, { role: 'assistant', text: 'd' }]);
    const long = [];
    for (let i = 0; i < 25; i += 1) long.push({ role: i % 2 ? 'assistant' : 'user', text: `t${i}` });
    const t = trimHistory(long);
    expect(t).toHaveLength(9); // last 10 = t15..t24 starts with assistant t15 → dropped
    expect(t[0]).toEqual({ role: 'user', text: 't16' });
    expect(trimHistory(undefined)).toEqual([]);
  });

  test('isRetryable: timeout, parse, 429 and 5xx only', () => {
    expect(isRetryable(new LlmError('timeout', 't'))).toBe(true);
    expect(isRetryable(new LlmError('parse', 'p'))).toBe(true);
    expect(isRetryable(new LlmError('http', 'h', { status: 429 }))).toBe(true);
    expect(isRetryable(new LlmError('http', 'h', { status: 503 }))).toBe(true);
    expect(isRetryable(new LlmError('http', 'h', { status: 400 }))).toBe(false);
    expect(isRetryable(new LlmError('http', 'h', { status: 401 }))).toBe(false);
    expect(isRetryable(new LlmError('refusal', 'r'))).toBe(false);
    expect(isRetryable(new LlmError('config', 'c'))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });
});
