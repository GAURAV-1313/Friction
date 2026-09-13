'use strict';
const { templatedReply, BUCKET_WORDS } = require('../../src/lc/domain/fallback');
const { validateReply } = require('../../src/lc/services/llm/schema');
const { guardReply, FORBIDDEN_TERMS } = require('../../src/lc/domain/guard');
const { makeCtx, DP_PROBLEM, VERDICT } = require('./fixtures/ctx');

const GRID = [1, 2, 3, 4].flatMap((rung) => ['english', 'hinglish'].map((language) => [rung, language]));

describe('every rung and language', () => {
  test.each(GRID)('rung %i %s: schema-valid, ends with a question, guard accepts it', (rung, language) => {
    const ctx = makeCtx({ rung, language });
    const r = templatedReply(ctx);
    expect(validateReply(r)).toEqual({ ok: true, errors: [] });
    expect(r.rung).toBe(rung);
    expect(r.asks_question).toBe(true);
    expect(r.reply.trim().endsWith('?')).toBe(true);
    expect(r.habits_used).toEqual([]);
    expect(r.self_check).toContain('templated fallback');
    const g = guardReply(r, ctx);
    expect(g.action).toBe('accept');
    expect(g.violations.filter((v) => v.action !== 'fix')).toEqual([]);
    expect(g.reply).toBe(r.reply);
  });

  test.each(GRID)('rung %i %s: deterministic and never contains code fences', (rung, language) => {
    const ctx = makeCtx({ rung, language });
    expect(templatedReply(ctx)).toEqual(templatedReply(ctx));
    expect(templatedReply(ctx).reply).not.toContain('```');
  });
});

describe('rung 1', () => {
  test.each(['english', 'hinglish'])('%s: asks for the plan in one line and uses no forbidden term', (language) => {
    const r = templatedReply(makeCtx({ rung: 1, language }));
    expect(r.reply.toLowerCase()).toContain('plan');
    expect(r.reply.toLowerCase()).toMatch(/one line|ek line/);
    expect(r.anchors_used).toEqual([]);
    for (const { term, re } of FORBIDDEN_TERMS) expect({ term, hit: re.test(r.reply) }).toEqual({ term, hit: false });
    expect(r.reply).not.toContain('Cheapest Route');
  });
});

describe('rung 2', () => {
  test.each(['english', 'hinglish'])('%s: names the family and cites the first anchor by title', (language) => {
    const r = templatedReply(makeCtx({ rung: 2, language }));
    expect(r.reply).toContain('graphs');
    expect(r.reply).toContain('Minimum Cost Courier Route');
    expect(r.reply).not.toContain('Water Flow Through Pipes');
    expect(r.reply.toLowerCase()).toContain('state');
    expect(r.anchors_used).toEqual(['minimum-cost-courier-route']);
  });

  test.each(['english', 'hinglish'])('%s: dp family, and no anchor means no past problem', (language) => {
    const r = templatedReply(makeCtx({ rung: 2, language, problem: DP_PROBLEM, anchors: [] }));
    expect(r.reply).toContain('dynamic programming');
    expect(r.reply).not.toMatch(/Courier|Pipes|Maze/);
    expect(r.anchors_used).toEqual([]);
    expect(r.reply.trim().endsWith('?')).toBe(true);
  });

  test('unknown family gets plain words', () => {
    const r = templatedReply(makeCtx({ rung: 2, problem: { ...DP_PROBLEM, family: null }, anchors: [] }));
    expect(r.reply).toMatch(/^This problem builds its answer from the answers to smaller pieces\./);
  });
});

describe('rung 3', () => {
  test.each(['english', 'hinglish'])('%s: names the verdict class in plain words and asks for a trace of the failing test', (language) => {
    const r = templatedReply(makeCtx({ rung: 3, language }));
    expect(r.reply).toContain(BUCKET_WORDS[language].wa_logic);
    expect(r.reply).toContain('[[0,1,5],[1,2,3],[0,2,9]]');
    expect(r.reply.toLowerCase()).toContain('trace');
    expect(r.reply).toMatch(language === 'hinglish' ? /^Lagta hai/ : /^It looks like/);
  });

  test('high tier is stated as fact, medium as "it looks like"', () => {
    const high = templatedReply(makeCtx({ rung: 3, verdict: { ...VERDICT, bucket: 're_overflow', tier: 'high' } }));
    expect(high.reply).toMatch(/^Your last submission hit an integer overflow\./);
    const hi = templatedReply(makeCtx({ rung: 3, language: 'hinglish', verdict: { ...VERDICT, bucket: 'tle', tier: 'high' } }));
    expect(hi.reply).toMatch(/^Tumhara last submission time limit pe gira\./);
    const medium = templatedReply(makeCtx({ rung: 3, verdict: { ...VERDICT, bucket: 'wa_edge_empty', tier: undefined } }));
    expect(medium.reply).toMatch(/^It looks like your last submission hit a wrong answer on a tiny input\./);
  });

  test('unknown bucket falls back to the status, no verdict falls back to a generic trace request', () => {
    const status = templatedReply(makeCtx({ rung: 3, verdict: { ...VERDICT, bucket: null, tier: null, status: 'Runtime Error', lastTestcase: '' } }));
    expect(status.reply).toMatch(/^It looks like your last submission hit a runtime error\. Trace that test/);
    const none = templatedReply(makeCtx({ rung: 3, verdict: null }));
    expect(none.reply).toMatch(/^Let us find where the reasoning breaks\. Trace that test by hand/);
    expect(none.reply.trim().endsWith('?')).toBe(true);
    const longTc = templatedReply(makeCtx({ rung: 3, verdict: { ...VERDICT, lastTestcase: 'z'.repeat(400) } }));
    expect(longTc.reply).toContain(`${'z'.repeat(120)}...`);
    expect(longTc.reply).not.toContain('z'.repeat(121));
  });
});

describe('rung 4', () => {
  test.each(['english', 'hinglish'])('%s: asks for the recurrence with the key line blank', (language) => {
    const r = templatedReply(makeCtx({ rung: 4, language }));
    expect(r.reply).toContain('___');
    expect(r.reply.toLowerCase()).toContain('recurrence');
    expect(r.anchors_used).toEqual([]);
  });
});

describe('robustness', () => {
  test('missing ctx pieces default to rung 1 english', () => {
    const r = templatedReply(null);
    expect(validateReply(r).ok).toBe(true);
    expect(r.rung).toBe(1);
    expect(r.reply).toMatch(/plan/);
    expect(templatedReply({ contract: { rung: 9 } }).rung).toBe(1);
    expect(templatedReply({ language: 'hinglish', contract: { rung: 4 } }).reply).toMatch(/^Ab likhne ka time hai/);
  });
});
