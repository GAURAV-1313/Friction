'use strict';
const { createGeminiProvider } = require('../../src/lc/services/llm/gemini');
const { GEMINI_RESPONSE_SCHEMA } = require('../../src/lc/services/llm/schema');
const { LlmError } = require('../../src/lc/services/llm/parse');

// ---- synthetic fixtures (no real student data) ----
const REPLY = { reply: 'Look at what the smallest input tells you. What changes when n grows by one?', rung: 1, anchors_used: [], habits_used: [], asks_question: true, self_check: 'student has not framed the state yet' };
const USAGE = { promptTokenCount: 3400, candidatesTokenCount: 90, totalTokenCount: 3490, thoughtsTokenCount: 0 };
const SYSTEM = 'RULES: word the hint only.';
const USER = 'STUDENT MESSAGE\nI am stuck on synthetic-problem-1.';

function okResult(obj = REPLY, usage = USAGE, finishReason = 'STOP') {
  return { response: { text: () => JSON.stringify(obj), usageMetadata: usage, candidates: [{ finishReason }] } };
}
function textResult(text, usage = USAGE, finishReason = 'STOP') {
  return { response: { text: () => text, usageMetadata: usage, candidates: [{ finishReason }] } };
}
/** A sendMessage that never resolves but rejects with AbortError when the injected signal aborts (SDK behaviour). */
function hanging() {
  return (_msg, opts) => new Promise((_, reject) => {
    const signal = opts && opts.signal;
    if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}
function sdkHttpError(status, message = 'boom') {
  const err = new Error(message);
  err.name = 'GoogleGenerativeAIFetchError';
  err.status = status;
  return () => Promise.reject(err);
}

/** Fake SDK capturing every argument. `responses` is a queue: values are resolved, functions are called (msg, opts). */
function makeFakeSdk(responses) {
  const calls = { keys: [], modelParams: [], chatParams: [], sendMessage: [] };
  class FakeGoogleGenerativeAI {
    constructor(apiKey) { calls.keys.push(apiKey); }
    getGenerativeModel(params) {
      calls.modelParams.push(params);
      return {
        startChat(chatParams) {
          calls.chatParams.push(chatParams);
          return {
            sendMessage(msg, opts) {
              calls.sendMessage.push({ msg, opts });
              const next = responses.shift();
              if (next === undefined) return Promise.reject(new Error('fake sdk: no response queued'));
              return typeof next === 'function' ? next(msg, opts) : Promise.resolve(next);
            }
          };
        }
      };
    }
  }
  return { FakeGoogleGenerativeAI, calls };
}

function makeProvider(responses, overrides = {}) {
  const { FakeGoogleGenerativeAI, calls } = makeFakeSdk(responses);
  let t = 0;
  const now = () => { t += 250; return t; };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const provider = createGeminiProvider({ apiKey: 'test-key', model: 'gemini-2.5-flash', timeoutMs: 40, GoogleGenerativeAI: FakeGoogleGenerativeAI, now, logger, ...overrides });
  return { provider, calls, logger };
}

describe('gemini provider: request shape', () => {
  test('getGenerativeModel receives system instruction, JSON mime + schema, temperature 0.3, maxOutputTokens 1500, thinkingBudget 0', async () => {
    const { provider, calls } = makeProvider([okResult()]);
    await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(calls.keys).toEqual(['test-key']);
    expect(calls.modelParams).toHaveLength(1);
    const p = calls.modelParams[0];
    expect(p.model).toBe('gemini-2.5-flash');
    expect(p.systemInstruction).toBe(SYSTEM);
    expect(p.generationConfig.responseMimeType).toBe('application/json');
    expect(p.generationConfig.responseSchema).toBe(GEMINI_RESPONSE_SCHEMA);
    expect(p.generationConfig.temperature).toBe(0.3);
    expect(p.generationConfig.maxOutputTokens).toBe(1500);
    expect(p.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  test('sendMessage is called with the user turn as its first argument and an AbortSignal', async () => {
    const { provider, calls } = makeProvider([okResult()]);
    await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(calls.sendMessage).toHaveLength(1);
    expect(calls.sendMessage[0].msg).toBe(USER);
    expect(calls.sendMessage[0].opts.signal).toBeInstanceOf(AbortSignal);
  });

  test('history maps assistant→model / user→user with parts[{text}], keeps the last 10, drops a leading assistant', async () => {
    const history = [{ role: 'assistant', text: 'a0' }];
    for (let i = 1; i <= 12; i += 1) history.push({ role: i % 2 ? 'user' : 'assistant', text: `m${i}` });
    // history has 13 entries: a0, u1, a2, u3, ..., u11, a12 → last 10 = [a3? no] compute: entries index 3..12 = u3,a4,u5,a6,u7,a8,u9,a10,u11,a12
    const { provider, calls } = makeProvider([okResult()]);
    await provider.generate({ system: SYSTEM, history, user: USER });
    const h = calls.chatParams[0].history;
    expect(h.length).toBeLessThanOrEqual(10);
    expect(h[0].role).toBe('user');
    expect(h[0]).toEqual({ role: 'user', parts: [{ text: 'm3' }] });
    expect(h[h.length - 1]).toEqual({ role: 'model', parts: [{ text: 'm12' }] });
    expect(h.every((c) => c.role === 'user' || c.role === 'model')).toBe(true);
    expect(h.some((c) => c.parts[0].text === 'a0')).toBe(false);
  });

  test('a history that is only a leading assistant turn becomes empty', async () => {
    const { provider, calls } = makeProvider([okResult()]);
    await provider.generate({ system: SYSTEM, history: [{ role: 'assistant', text: 'hello' }], user: USER });
    expect(calls.chatParams[0].history).toEqual([]);
  });
});

describe('gemini provider: response mapping', () => {
  test('returns parsed reply, mapped usage (incl. thoughts_tokens), provider, model, latency_ms and raw_text', async () => {
    const { provider } = makeProvider([okResult(REPLY, { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150, thoughtsTokenCount: 0 })]);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150, thoughts_tokens: 0 });
    expect(out.provider).toBe('gemini');
    expect(out.model).toBe('gemini-2.5-flash');
    expect(out.latency_ms).toBe(250); // injected clock: t0=250, end=500
    expect(out.raw_text).toBe(JSON.stringify(REPLY));
    expect(out.attempts).toBe(1);
    expect(out.parse_via).toBe('direct');
  });

  test('thoughts_tokens is surfaced when the API reports thinking (so the smoke test can assert 0)', async () => {
    const { provider } = makeProvider([okResult(REPLY, { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2, thoughtsTokenCount: 77 })]);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.usage.thoughts_tokens).toBe(77);
  });

  test('missing usageMetadata yields zeros instead of NaN', async () => {
    const { provider } = makeProvider([{ response: { text: () => JSON.stringify(REPLY) } }]);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0, thoughts_tokens: 0 });
  });

  test('falls back to a brace scan when the text is wrapped in a fence or chatter', async () => {
    const { provider } = makeProvider([textResult('```json\n' + JSON.stringify(REPLY) + '\n```')]);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.parse_via).toBe('scan');
  });
});

describe('gemini provider: timeout and retry', () => {
  test('timeout on the first attempt → one retry → success (2 sendMessage calls)', async () => {
    const { provider, calls, logger } = makeProvider([hanging(), okResult()]);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(out.attempts).toBe(2);
    expect(calls.sendMessage).toHaveLength(2);
    expect(calls.sendMessage[0].opts.signal.aborted).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(logger.warn.mock.calls[0][0]);
    expect(line).toMatchObject({ evt: 'lc.llm.retry', provider: 'gemini', code: 'timeout' });
    expect(logger.warn.mock.calls[0][0]).not.toContain(USER);
  });

  test('timeout twice → LlmError(timeout) after exactly 2 attempts', async () => {
    const { provider, calls } = makeProvider([hanging(), hanging()]);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('timeout');
    expect(calls.sendMessage).toHaveLength(2);
  });

  test('parse failure → retry once → LlmError(parse)', async () => {
    const { provider, calls } = makeProvider([textResult('I cannot answer in JSON right now.'), textResult('still not json')]);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('parse');
    expect(calls.sendMessage).toHaveLength(2);
  });

  test('schema-invalid JSON (wrong rung type) counts as a parse failure and is retried', async () => {
    const bad = { ...REPLY, rung: 'one' };
    const { provider, calls } = makeProvider([okResult(bad), okResult()]);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(calls.sendMessage).toHaveLength(2);
  });

  test('truncated output (MAX_TOKENS) is a parse failure; the error message carries the finish reason', async () => {
    const { provider } = makeProvider([textResult('{"reply": "cut off', USAGE, 'MAX_TOKENS'), textResult('{"reply": "cut off', USAGE, 'MAX_TOKENS')]);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err.code).toBe('parse');
    expect(err.message).toContain('MAX_TOKENS');
  });

  test('429 from the SDK → retried once → success', async () => {
    const { provider, calls } = makeProvider([sdkHttpError(429, 'quota'), okResult()]);
    const out = await provider.generate({ system: SYSTEM, history: [], user: USER });
    expect(out.parsed).toEqual(REPLY);
    expect(calls.sendMessage).toHaveLength(2);
  });

  test('503 twice → LlmError(http) with status', async () => {
    const { provider, calls } = makeProvider([sdkHttpError(503), sdkHttpError(503)]);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err.code).toBe('http');
    expect(err.status).toBe(503);
    expect(calls.sendMessage).toHaveLength(2);
  });

  test('400 from the SDK is not retried', async () => {
    const { provider, calls } = makeProvider([sdkHttpError(400, 'bad request'), okResult()]);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err.code).toBe('http');
    expect(err.status).toBe(400);
    expect(calls.sendMessage).toHaveLength(1);
  });

  test('a blocked response (text() throws a response error) maps to refusal and is not retried', async () => {
    const blocked = { response: { text: () => { const e = new Error('Candidate was blocked due to SAFETY'); e.name = 'GoogleGenerativeAIResponseError'; throw e; }, usageMetadata: USAGE } };
    const { provider, calls } = makeProvider([blocked, okResult()]);
    const err = await provider.generate({ system: SYSTEM, history: [], user: USER }).catch((e) => e);
    expect(err.code).toBe('refusal');
    expect(calls.sendMessage).toHaveLength(1);
  });
});

describe('gemini provider: configuration', () => {
  test('missing api key → LlmError(config)', () => {
    const { FakeGoogleGenerativeAI } = makeFakeSdk([]);
    let err;
    try { createGeminiProvider({ apiKey: '', model: 'gemini-2.5-flash', GoogleGenerativeAI: FakeGoogleGenerativeAI }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('config');
  });

  test('empty user turn → LlmError(config) without calling the SDK', async () => {
    const { provider, calls } = makeProvider([okResult()]);
    const err = await provider.generate({ system: SYSTEM, history: [], user: '' }).catch((e) => e);
    expect(err.code).toBe('config');
    expect(calls.sendMessage).toHaveLength(0);
  });
});
