'use strict';
const { guardReply, RERUN_SENTENCE, FORBIDDEN_TERMS } = require('../../src/lc/domain/guard');
const { WORD_CAPS } = require('../../src/lc/domain/constants');
const { makeCtx } = require('./fixtures/ctx');

const CLEAN = {
  1: {
    english: 'This one is about finding the cheapest way to get from one place to another when every step has its own price. What would you try first on a tiny map with just three towns?',
    hinglish: 'Yeh problem ek jagah se doosri jagah sabse saste tareeke se pahunchne ki hai, jahan har step ka apna daam hai. Sirf teen towns wale chhote map pe tum sabse pehle kya try karoge?'
  },
  2: {
    english: 'This is a shortest-path problem, the same family as Minimum Cost Courier Route. There you kept one number per town: the best total known so far. What would one entry stand for here, before you think about how to update it?',
    hinglish: 'Yeh shortest-path problem hai, Minimum Cost Courier Route wali family ka. Wahan tumne har town ke liye ek number rakha tha: ab tak ka best total. Yahan ek entry kis cheez ko represent karegi, update ke baare mein sochne se pehle?'
  },
  3: {
    english: 'It looks like your single pass over the roads only improves a town once, so a cheaper toll found later never reaches town 2. In Minimum Cost Courier Route, what did you do after a town\'s cost dropped, and what would that mean for this input?',
    hinglish: 'Lagta hai tumhara single pass har town ko sirf ek baar improve karta hai, isliye baad mein mila sasta toll town 2 tak pahunchta hi nahi. Minimum Cost Courier Route mein jab kisi town ka cost gira tha, tumne uske baad kya kiya tha, aur yahan us input ke liye uska matlab kya hoga?'
  },
  4: {
    english: 'Here is the skeleton with the two key lines left for you.\n```\nbest[all] = INF\nbest[src] = 0\npush (0, src)\nwhile queue not empty:\n    d, u = pop smallest\n    if d > best[u]: skip\n    for (v, w) in adj[u]:\n        if ___ :\n            best[v] = ___\n            push (best[v], v)\n```\nWhich condition belongs in the first gap, and why does it use best[u] rather than d?',
    hinglish: 'Yeh raha skeleton, do key lines tumhare liye khali hain.\n```\nbest[all] = INF\nbest[src] = 0\npush (0, src)\nwhile queue not empty:\n    d, u = pop smallest\n    if d > best[u]: skip\n    for (v, w) in adj[u]:\n        if ___ :\n            best[v] = ___\n            push (best[v], v)\n```\nPehle gap mein kaunsi condition aayegi, aur wahan d ki jagah best[u] kyun use hota hai?'
  }
};

function parsedFor(rung, language, over = {}) {
  return { reply: CLEAN[rung][language], rung, anchors_used: [], habits_used: [], asks_question: true, self_check: 'synthetic', ...over };
}

function run(rung, language, over = {}, ctxOver = {}, opts = {}) {
  const ctx = makeCtx({ rung, language, ...ctxOver });
  return guardReply(parsedFor(rung, language, over), ctx, opts);
}

function rules(res, rule) {
  return res.violations.filter((v) => v.rule === rule);
}

describe('clean replies', () => {
  test.each([[1, 'english'], [1, 'hinglish'], [2, 'english'], [2, 'hinglish'], [3, 'english'], [3, 'hinglish'], [4, 'english'], [4, 'hinglish']])(
    'rung %i %s is accepted with no violations', (rung, language) => {
      const res = run(rung, language);
      expect(res.violations).toEqual([]);
      expect(res.action).toBe('accept');
      expect(res.reply).toBe(CLEAN[rung][language]);
      expect(res.retry_instructions).toBeUndefined();
      if (rung >= 2 && rung <= 3) expect(res.anchors_used).toEqual(['minimum-cost-courier-route']);
    }
  );
});

describe('rule 1: schema', () => {
  test.each(['english', 'hinglish'])('%s: invalid reply retries on pass 1 and falls back on pass 2', (language) => {
    const ctx = makeCtx({ rung: 2, language });
    const bad = { reply: 'x', rung: 2 };
    const p1 = guardReply(bad, ctx);
    expect(p1.action).toBe('retry');
    expect(p1.violations).toEqual([{ rule: 'schema', detail: expect.stringContaining('anchors_used'), action: 'retry' }]);
    expect(p1.retry_instructions).toContain('schema');
    const p2 = guardReply(bad, ctx, { pass: 2 });
    expect(p2.action).toBe('fallback');
    expect(p2.violations[0].action).toBe('fallback');
    expect(p2.retry_instructions).toBeUndefined();
    expect(guardReply(null, ctx).action).toBe('retry');
    expect(guardReply({ ...parsedFor(2, language), reply: '   ' }, ctx).violations[0].detail).toContain('reply');
  });
});

describe('rule 2: rung mismatch', () => {
  test.each(['english', 'hinglish'])('%s: the contract rung wins as a fix', (language) => {
    const res = run(3, language, { rung: 2 });
    expect(rules(res, 'rung')).toEqual([{ rule: 'rung', detail: 'model said rung 2, contract is 3', action: 'fix' }]);
    expect(res.action).toBe('accept');
  });
});

describe('rule 3: anchors_used subset of offered, title scan, unoffered titles', () => {
  test.each(['english', 'hinglish'])('%s: unoffered slugs dropped, titles mapped to slugs, cited titles detected', (language) => {
    const res = run(3, language, { anchors_used: ['not-offered-slug', 'Minimum Cost Courier Route', 'WATER-FLOW-THROUGH-PIPES'] });
    expect(res.anchors_used).toEqual(['minimum-cost-courier-route', 'water-flow-through-pipes']);
    expect(rules(res, 'anchors_used')).toEqual([{ rule: 'anchors_used', detail: 'not offered: not-offered-slug', action: 'fix' }]);
    expect(res.action).toBe('accept');
  });

  test('a title cited in the text is added even when the model forgot to list it', () => {
    const reply = {
      english: 'It looks like the road order decides which town gets updated. What did you seed the source with in water flow through pipes, and what would that mean here?',
      hinglish: 'Lagta hai road ka order decide karta hai ki kaunsa town update hota hai. Water Flow Through Pipes mein tumne source ko kis value se seed kiya tha, aur yahan uska matlab kya hoga?'
    };
    for (const language of ['english', 'hinglish']) {
      const res = run(3, language, { reply: reply[language] });
      expect(res.anchors_used).toEqual(['water-flow-through-pipes']);
      expect(res.action).toBe('accept');
    }
  });

  test.each(['english', 'hinglish'])('%s: a capitalised unoffered title from the not-allowed list becomes "a classic problem"', (language) => {
    const text = {
      english: 'In Network Delay Time you seeded the start with zero, and a lowercase network delay time is left alone. What did you seed the source with in Water Flow Through Pipes, and what would that mean here?',
      hinglish: 'Network Delay Time mein tumne start ko zero se seed kiya tha, aur lowercase network delay time waise hi rahega. Water Flow Through Pipes mein tumne source ko kis value se seed kiya tha, aur yahan uska matlab kya hoga?'
    };
    const res = run(3, language, { reply: text[language] }, { offered_titles_not_allowed: ['Network Delay Time', 'Coin Change', 'Minimum Cost Courier Route'] });
    expect(res.reply).toContain('a classic problem');
    expect(res.reply).not.toContain('Network Delay Time');
    expect(res.reply).toContain('network delay time');
    expect(rules(res, 'unoffered_title')).toEqual([{ rule: 'unoffered_title', detail: 'replaced: Network Delay Time', action: 'fix' }]);
    expect(res.anchors_used).toEqual(['water-flow-through-pipes']);
    expect(res.action).toBe('accept');
  });

  test('without a not-allowed list nothing is rewritten', () => {
    const res = run(3, 'english', { reply: 'In Network Delay Time you seeded the start with zero. What did you seed the source with in Water Flow Through Pipes, and what would that mean here?' });
    expect(res.reply).toContain('Network Delay Time');
    expect(rules(res, 'unoffered_title')).toEqual([]);
  });
});

describe('rule 4: habits_used subset of offered keys', () => {
  test.each(['english', 'hinglish'])('%s: unknown keys are dropped as a fix', (language) => {
    const res = run(3, language, { habits_used: ['overflow', 'gap:graph.bestfirst', 'overflow', 'bucket:graph.bestfirst:wa_logic'] });
    expect(res.habits_used).toEqual(['overflow', 'bucket:graph.bestfirst:wa_logic']);
    expect(rules(res, 'habits_used')).toEqual([{ rule: 'habits_used', detail: 'not offered: gap:graph.bestfirst', action: 'fix' }]);
    expect(res.action).toBe('accept');
  });
});

describe('rule 5: no code at rung <= 3', () => {
  const tail = {
    english: ' It looks like the road order decides which town gets updated. What would you check on the third test first?',
    hinglish: ' Lagta hai road ka order decide karta hai ki kaunsa town update hota hai. Teesre test pe tum sabse pehle kya check karoge?'
  };
  test.each(['english', 'hinglish'])('%s: a multi-line fence is stripped and forces a retry', (language) => {
    const res = run(3, language, { reply: `Try this.\n\`\`\`cpp\nfor (auto& r : roads) {\n  best[r[1]] = min(best[r[1]], best[r[0]] + r[2]);\n}\n\`\`\`${tail[language]}` });
    expect(res.reply).not.toContain('```');
    expect(res.reply).not.toContain('min(');
    expect(rules(res, 'code_at_low_rung').map((v) => v.action)).toEqual(['fix', 'retry']);
    expect(res.action).toBe('retry');
    expect(res.retry_instructions).toContain('code_at_low_rung');
  });

  test.each(['english', 'hinglish'])('%s: a short inline reference loses its backticks, a single identifier keeps them', (language) => {
    const res = run(3, language, { reply: `Look at \`best[v]\` and the variable \`best\` once more.${tail[language]}` });
    expect(res.reply).toContain('Look at best[v] and the variable `best` once more.');
    expect(rules(res, 'code_at_low_rung')).toEqual([{ rule: 'code_at_low_rung', detail: 'stripped 1 code span(s) at rung 3', action: 'fix' }]);
    expect(res.action).toBe('accept');
  });

  test.each(['english', 'hinglish'])('%s: a short inline statement is removed as a fix, a long one also retries', (language) => {
    const short = run(3, language, { reply: `Try \`best[v] = best[u] + w\` there.${tail[language]}` });
    expect(short.reply).toContain('Try there.');
    expect(short.reply).not.toContain('best[u] + w');
    expect(short.action).toBe('accept');
    const long = run(2, language, { reply: `Try \`for (auto [v, w] : adj[u]) if (best[u] + w < best[v]) best[v] = best[u] + w;\` there.${tail[language]}` });
    expect(long.reply).not.toContain('adj[u]');
    expect(long.action).toBe('retry');
    expect(rules(long, 'code_at_low_rung').some((v) => v.action === 'retry')).toBe(true);
  });

  test('an unterminated fence is treated as a block; a one-line fence is a fix only', () => {
    const open = run(3, 'english', { reply: `Here.\n\`\`\`cpp\nint x = 1;\nint y = 2;${tail.english}` });
    expect(open.reply).not.toContain('int x');
    expect(open.action).toBe('retry');
    const one = run(3, 'english', { reply: `Here \`\`\`x = 1\`\`\` and done.${tail.english}` });
    expect(one.reply).toContain('Here and done.');
    expect(one.action).toBe('accept');
  });

  test('rung 4 is exempt from the inline rule', () => {
    const res = run(4, 'english', { reply: `Fill \`best[v] = best[u] + w\` where it belongs.\n${CLEAN[4].english}` });
    expect(res.reply).toContain('`best[v] = best[u] + w`');
    expect(rules(res, 'code_at_low_rung')).toEqual([]);
  });
});

describe('rule 6: rung 4 fenced block only with ___ gaps and <= 12 lines', () => {
  const q = { english: '\nWhich condition belongs in the first gap, and why does it use best[u] rather than d?', hinglish: '\nPehle gap mein kaunsi condition aayegi, aur wahan d ki jagah best[u] kyun use hota hai?' };
  test.each(['english', 'hinglish'])('%s: a qualifying block is kept untouched', (language) => {
    const res = run(4, language);
    expect(res.reply).toContain('```\nbest[all] = INF');
    expect(rules(res, 'rung4_fence')).toEqual([]);
  });

  test.each(['english', 'hinglish'])('%s: a block without ___ is dropped', (language) => {
    const res = run(4, language, { reply: `Here.\n\`\`\`\nbest[src] = 0\npush (0, src)\n\`\`\`${q[language]}` });
    expect(res.reply).not.toContain('```');
    expect(rules(res, 'rung4_fence')).toEqual([{ rule: 'rung4_fence', detail: 'dropped block(s): no ___ gaps', action: 'fix' }]);
    expect(res.action).toBe('accept');
  });

  test('a block longer than 12 lines is dropped, a second qualifying block is dropped as extra', () => {
    const long = `\`\`\`\n${Array.from({ length: 14 }, (_, i) => (i === 3 ? 'x = ___' : `line ${i}`)).join('\n')}\n\`\`\``;
    const res = run(4, 'english', { reply: `Here.\n${long}${q.english}` });
    expect(res.reply).not.toContain('```');
    expect(rules(res, 'rung4_fence')[0].detail).toBe('dropped block(s): 14 lines');
    const two = run(4, 'english', { reply: `Here.\n\`\`\`\na = ___\n\`\`\`\nand\n\`\`\`\nb = ___\n\`\`\`${q.english}` });
    expect(two.reply).toContain('a = ___');
    expect(two.reply).not.toContain('b = ___');
    expect(rules(two, 'rung4_fence')[0].detail).toBe('dropped block(s): extra block');
  });
});

describe('rule 7: forbidden technique names at rung 1', () => {
  test('the term list is compiled from both languages', () => {
    expect(FORBIDDEN_TERMS.length).toBeGreaterThan(80);
    expect(FORBIDDEN_TERMS.some((t) => t.term === 'dp lagao')).toBe(true);
  });

  test('english: a technique name retries with the term named', () => {
    const res = run(1, 'english', { reply: 'You could run Dijkstra from the start town. What would you try first on a tiny map with just three towns?' });
    expect(rules(res, 'forbidden_term')).toEqual([{ rule: 'forbidden_term', detail: 'technique names at rung 1: dijkstra', action: 'retry' }]);
    expect(res.action).toBe('retry');
    expect(res.retry_instructions).toContain('dijkstra');
  });

  test('hinglish: a Hinglish phrasing retries', () => {
    const res = run(1, 'hinglish', { reply: 'Yahan dp lagao aur dekho. Sirf teen towns wale chhote map pe tum sabse pehle kya try karoge?' });
    const [v] = rules(res, 'forbidden_term');
    expect(v.action).toBe('retry');
    expect(v.detail).toContain('dp lagao');
    expect(v.detail).toContain('dp');
    expect(res.action).toBe('retry');
  });

  test('word boundaries: dpi, primary and bridges-of-text do not fire; rung 2 is exempt', () => {
    const res = run(1, 'english', { reply: 'The primary dpi of the picture is not the point here. What would you try first on a tiny map with just three towns?' });
    expect(rules(res, 'forbidden_term')).toEqual([]);
    const r2 = run(2, 'english', { reply: 'You could run Dijkstra from the start town, the same family as Minimum Cost Courier Route. What would one entry stand for here, before you think about how to update it?' });
    expect(rules(r2, 'forbidden_term')).toEqual([]);
  });
});

describe('rule 8: verbatim LeetCode hint', () => {
  test.each(['english', 'hinglish'])('%s: an 8-word window of a hint retries', (language) => {
    const text = {
      english: 'Think of every town as a node and every toll road as a weighted edge. What would you try first on a tiny map with just three towns?',
      hinglish: 'Socho ki every town as a node and every toll road as a weighted edge hai. Sirf teen towns wale chhote map pe tum sabse pehle kya try karoge?'
    };
    const res = run(1, language, { reply: text[language] });
    const [v] = rules(res, 'verbatim_hint');
    expect(v.action).toBe('retry');
    expect(v.detail).toMatch(/every town as a node and/);
    expect(v.detail.match(/"([^"]+)"/)[1].split(' ').length).toBe(8);
    expect(res.action).toBe('retry');
  });

  test('a paraphrase passes, and a short hint is matched whole', () => {
    expect(rules(run(1, 'english', { reply: 'Picture each town as a dot and each road as a priced line between two dots. What would you try first on a tiny map with just three towns?' }), 'verbatim_hint')).toEqual([]);
    const ctxOver = { problem: { ...makeCtx().problem, leetcode_hints: ['Seed the source with zero.'] } };
    expect(rules(run(2, 'english', { reply: 'Seed the source with zero, the same family as Minimum Cost Courier Route. What would one entry stand for here, before you think about how to update it?' }, ctxOver), 'verbatim_hint').length).toBe(1);
  });
});

describe('rule 9: transition leak at rung 2', () => {
  test('english: a recurrence retries at rung 2, not at rung 3', () => {
    const text = 'The state is dp[i] = min(dp[i-1], dp[i-2]) per town, like Minimum Cost Courier Route. What would one entry stand for here, before you think about how to update it?';
    const r2 = run(2, 'english', { reply: text });
    expect(rules(r2, 'transition_leak')).toEqual([{ rule: 'transition_leak', detail: expect.stringContaining('dp[i] ='), action: 'retry' }]);
    expect(r2.action).toBe('retry');
    expect(rules(run(3, 'english', { reply: text }), 'transition_leak')).toEqual([]);
  });

  test('hinglish: a data-structure choice retries', () => {
    const res = run(2, 'hinglish', { reply: 'Yahan heap lagao aur har town ko relax karo, Minimum Cost Courier Route wali family ka. Yahan ek entry kis cheez ko represent karegi, update ke baare mein sochne se pehle?' });
    expect(rules(res, 'transition_leak').length).toBe(1);
    expect(res.action).toBe('retry');
  });
});

describe('rule 10: anchor as a statement at rung 3', () => {
  test('english: "so here you should" with a title retries', () => {
    const res = run(3, 'english', { reply: 'In Minimum Cost Courier Route you pushed the source first, so here you should do the same. What did you seed the source with, and what would that mean for this input?' });
    const [v] = rules(res, 'anchor_as_statement');
    expect(v.action).toBe('retry');
    expect(v.detail).toContain('In Minimum Cost Courier Route you pushed');
    expect(res.action).toBe('retry');
  });

  test('hinglish: "yahan bhi wahi karo" with a title retries', () => {
    const res = run(3, 'hinglish', { reply: 'Minimum Cost Courier Route mein tumne source pehle push kiya tha, yahan bhi wahi karo. Tumne source ko kis value se seed kiya tha, aur yahan uska matlab kya hoga?' });
    expect(rules(res, 'anchor_as_statement').length).toBe(1);
    expect(res.action).toBe('retry');
  });

  test('the phrase without a title, or at rung 2, does not fire', () => {
    expect(rules(run(3, 'english', { reply: 'You pushed the source first there, so here you should do the same. What did you seed the source with, and what would that mean for this input?' }), 'anchor_as_statement')).toEqual([]);
    expect(rules(run(2, 'english', { reply: 'In Minimum Cost Courier Route you pushed the source first, so here you should do the same. What would one entry stand for here, before you think about how to update it?' }), 'anchor_as_statement')).toEqual([]);
  });
});

describe('rule 11: completion phrases', () => {
  test('english: the sentence is deleted and the re-run line goes before the closing question', () => {
    const res = run(3, 'english', { reply: 'Fix the loop bound. That\'s the only bug. Which index does the loop stop at?' });
    expect(res.reply).toBe(`Fix the loop bound. ${RERUN_SENTENCE.english} Which index does the loop stop at?`);
    expect(rules(res, 'completion_phrase')).toEqual([{ rule: 'completion_phrase', detail: 'deleted 1 sentence(s) implying one change finishes the problem', action: 'fix' }]);
    expect(res.action).toBe('accept');
  });

  test('hinglish: same with the Hinglish re-run line', () => {
    const res = run(3, 'hinglish', { reply: 'Loop ka bound theek karo. Bas yahi bug hai. Loop kis index pe rukta hai?' });
    expect(res.reply).toBe(`Loop ka bound theek karo. ${RERUN_SENTENCE.hinglish} Loop kis index pe rukta hai?`);
    expect(res.action).toBe('accept');
  });

  test('without a closing question the line is appended and rule 12 then retries', () => {
    const res = run(3, 'english', { reply: 'Fix the loop bound and it will pass.' });
    expect(res.reply).toBe(`${RERUN_SENTENCE.english}`);
    expect(rules(res, 'completion_phrase').length).toBe(1);
    expect(rules(res, 'ends_with_question').length).toBe(1);
    expect(res.action).toBe('retry');
  });

  test('several completion sentences are all removed, fenced code is untouched', () => {
    const res = run(4, 'english', { reply: `Then you're done. ${CLEAN[4].english.replace('Which condition', 'That should fix everything. Which condition')}` });
    expect(res.reply).not.toMatch(/done\.|fix everything/);
    expect(res.reply).toContain('best[v] = ___');
    expect(rules(res, 'completion_phrase')[0].detail).toContain('deleted 2');
  });
});

describe('rule 12: must end with a question', () => {
  test.each(['english', 'hinglish'])('%s: a statement at the end retries', (language) => {
    const text = { english: 'It looks like the road order decides which town gets updated. Check the third test.', hinglish: 'Lagta hai road ka order decide karta hai ki kaunsa town update hota hai. Teesra test check karo.' };
    const res = run(3, language, { reply: text[language] });
    expect(rules(res, 'ends_with_question')).toEqual([{ rule: 'ends_with_question', detail: 'the last sentence must be the one question', action: 'retry' }]);
    expect(res.action).toBe('retry');
  });

  test('asks_question false retries even when the text ends with a question mark', () => {
    const res = run(3, 'english', { asks_question: false });
    expect(rules(res, 'ends_with_question')).toEqual([{ rule: 'ends_with_question', detail: 'asks_question is not true', action: 'retry' }]);
  });

  test('a trailing quote or bracket after the question mark is fine', () => {
    const res = run(1, 'english', { reply: `${CLEAN[1].english.slice(0, -1)}?"` });
    expect(rules(res, 'ends_with_question')).toEqual([]);
  });
});

describe('rule 13: closing question already answered in the body', () => {
  test('english: a question that repeats the body retries on pass 1 and flags on pass 2', () => {
    const reply = 'Your loop skips the last town, so the bottom town never gets a cost. Which town does your loop skip?';
    const p1 = run(3, 'english', { reply });
    expect(rules(p1, 'question_answered')).toEqual([{ rule: 'question_answered', detail: expect.stringContaining('already covered in the body'), action: 'retry' }]);
    expect(p1.action).toBe('retry');
    const p2 = run(3, 'english', { reply }, {}, { pass: 2 });
    expect(rules(p2, 'question_answered')[0].action).toBe('flag');
    expect(p2.action).toBe('accept');
  });

  test('hinglish: same', () => {
    const reply = 'Tumhara loop aakhri town ko skip karta hai, isliye us town ka cost kabhi set nahi hota. Tumhara loop kaunsa town skip karta hai?';
    const res = run(3, 'hinglish', { reply });
    expect(rules(res, 'question_answered').length).toBe(1);
    expect(res.action).toBe('retry');
  });

  test('a question with a fresh key noun passes; offered titles and tags never count as key nouns', () => {
    expect(rules(run(3, 'english', { reply: 'Your loop skips the last town, so the bottom town never gets a cost. Which road would you add to force that skip on a two-town map?' }), 'question_answered')).toEqual([]);
    expect(rules(run(3, 'english', { reply: 'Minimum Cost Courier Route used a queue for the shortest path. What did Minimum Cost Courier Route need before its first pop?' }), 'question_answered')).toEqual([]);
  });
});

describe('rule 14: word cap', () => {
  test.each([1, 2, 3, 4])('rung %i: above the cap retries, pass 2 flags', (rung) => {
    const filler = Array.from({ length: WORD_CAPS[rung] + 5 }, (_, i) => `w${i}`).join(' ');
    const ctx = makeCtx({ rung, language: 'english' });
    const parsed = parsedFor(rung, 'english', { reply: `${filler}. What next?` });
    const p1 = guardReply(parsed, ctx);
    const [v] = rules(p1, 'word_cap');
    expect(v.action).toBe('retry');
    expect(v.detail).toContain(`cap for rung ${rung} is ${WORD_CAPS[rung]}`);
    expect(p1.action).toBe('retry');
    const p2 = guardReply(parsed, ctx, { pass: 2 });
    expect(rules(p2, 'word_cap')[0].action).toBe('flag');
    expect(p2.action).toBe('accept');
  });

  test('hinglish at the cap passes', () => {
    const filler = Array.from({ length: WORD_CAPS[1] - 3 }, (_, i) => `shabd${i}`).join(' ');
    const res = run(1, 'hinglish', { reply: `${filler}. Aage kya?` });
    expect(rules(res, 'word_cap')).toEqual([]);
  });
});

describe('pass 2 downgrade and retry instructions', () => {
  test('a forbidden term at rung 1 retries on pass 1 and is accepted with a flag on pass 2', () => {
    const parsed = parsedFor(1, 'english', { reply: 'You could run Dijkstra from the start town. What would you try first on a tiny map with just three towns?' });
    const ctx = makeCtx({ rung: 1 });
    const p1 = guardReply(parsed, ctx, { pass: 1 });
    expect(p1.action).toBe('retry');
    expect(p1.retry_instructions).toMatch(/^Your previous reply broke these rules: forbidden_term: technique names at rung 1: dijkstra\. Rewrite the whole reply/);
    const p2 = guardReply(parsed, ctx, { pass: 2 });
    expect(p2.action).toBe('accept');
    expect(p2.violations).toEqual([{ rule: 'forbidden_term', detail: 'technique names at rung 1: dijkstra', action: 'flag' }]);
    expect(p2.retry_instructions).toBeUndefined();
    expect(p2.reply).toBe(parsed.reply);
  });

  test('fixes still apply on pass 2 and every retry-class violation is listed once', () => {
    const parsed = parsedFor(3, 'english', { rung: 1, anchors_used: ['ghost'], reply: 'Fix the loop bound. That\'s the only bug.\n```\nint a = 1;\nint b = 2;\n```\nCheck the third test.' });
    const ctx = makeCtx({ rung: 3 });
    const p1 = guardReply(parsed, ctx);
    expect(p1.action).toBe('retry');
    expect(p1.retry_instructions).toContain('code_at_low_rung');
    expect(p1.retry_instructions).toContain('ends_with_question');
    expect(p1.retry_instructions).not.toContain('anchors_used');
    const p2 = guardReply(parsed, ctx, { pass: 2 });
    expect(p2.action).toBe('accept');
    expect(p2.reply).not.toContain('```');
    expect(p2.reply).toContain(RERUN_SENTENCE.english);
    expect(p2.anchors_used).toEqual([]);
    expect(p2.violations.map((v) => `${v.rule}:${v.action}`)).toEqual([
      'rung:fix', 'anchors_used:fix', 'code_at_low_rung:fix', 'code_at_low_rung:flag', 'completion_phrase:fix', 'ends_with_question:flag'
    ]);
  });
});
