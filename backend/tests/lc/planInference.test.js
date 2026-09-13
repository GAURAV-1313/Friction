'use strict';
/**
 * Plan inference: the change that lets a typed sentence replace the four deleted plan chips.
 * Pure unit tests over contextBuilder.resolvePlan / inferPlan — no DB, no network, no mocks.
 *
 * The contract (PANEL_REDESIGN "Backend changes"): with no body.plan and no stored session plan,
 * the student's own message counts as the plan when ALL of
 *   trimmed length >= 20, >= 4 distinct whitespace-separated words, not on the stoplist.
 * Anything that reads as "I have nothing" must NOT count — that is exactly what PLAN_CHIPS.no_idea
 * bought (nothing), and the measured effort gate depends on it.
 */
const cb = require('../../src/lc/services/contextBuilder');

const infer = (msg) => cb.resolvePlan(undefined, null, msg);

// A sentence long enough and varied enough to clear both numeric gates, used for precedence tests.
const REAL_PLAN = 'I think I need a dp over ranges but I cannot define the state';

describe('plan inference: sentences that DO count as a plan', () => {
  const yes = [
    ['the spec example', REAL_PLAN],
    ['a stated but wrong formulation', 'my dp[i][j] means longest palindrome but the transition is wrong'],
    ['an approach plus a failing case', 'I tried two pointers and it fails on the empty array case'],
    ['a complexity complaint', 'my recursion works but it times out on the big inputs'],
    // Hinglish: substantive, and deliberately close to the "samajh nahi aa raha" stoplist arm.
    ['hinglish, a real approach', 'Mujhe lagta hai dp use karna padega par state samajh nahi aa rahi'],
    ['hinglish, a stated attempt', 'Maine memoization try kiya lekin base case galat lag raha hai'],
    // Named in the spec's own risk list: it passes, and that is the accepted cost (one rung of a
    // Socratic question, paid for by typing). Locked in so a "fix" is a deliberate decision.
    ['the documented false positive', 'idk man this thing is confusing me a lot today'],
    ['exactly at the 20-character floor', 'i use dp over ii jj'.padEnd(20, 'j')]
  ];
  it.each(yes)('%s', (_label, msg) => {
    expect(infer(msg)).toBe(msg.trim());
  });

  it('collapses nothing and clamps free text to 500 characters', () => {
    const long = `${REAL_PLAN} ${'and then some more reasoning '.repeat(40)}`.trim();
    expect(long.length).toBeGreaterThan(500);
    expect(infer(long)).toHaveLength(500);
  });

  it('trims surrounding whitespace but keeps the sentence itself', () => {
    expect(infer(`   ${REAL_PLAN}   `)).toBe(REAL_PLAN);
  });
});

describe('plan inference: sentences that must NOT count as a plan', () => {
  const no = [
    // --- the English stoplist, bare utterances ---
    ['help', 'help'],
    ['help me', 'Help me'],
    ['hint', 'hint'],
    ['hints please', 'hints please'],
    ['stuck', 'stuck'],
    ["i'm stuck", "i'm stuck"],
    ["i'm still stuck", "I'm still stuck"],
    ['i am stuck', 'I am stuck'],
    ['i am still stuck (long enough to clear the gates)', 'I am still stuck'],
    ['idk', 'idk'],
    ["i don't know", "I don't know"],
    ['i dont know', 'i dont know'],
    ['i have no idea', 'I have no idea'],
    ['no idea', 'no idea'],
    ['no idea yet', 'no idea yet'],
    // The headline case: long enough and wordy enough to clear both numeric gates, so only the
    // stoplist stops it. PANEL_REDESIGN states twice that this must not unlock rung 2.
    ['i have no idea where to start', 'I have no idea where to start'],
    ['no idea where to start', 'no idea where to start'],
    ["i've no idea where to start", "I've no idea where to start"],
    ['i have no idea what to do', 'I have no idea what to do'],
    ['give me a hint', 'give me a hint'],
    ['any hint', 'any hint'],
    ['what now', 'what now'],
    ['next', 'next'],
    ['more', 'more'],
    ['trailing punctuation is free', 'I have no idea where to start!!!'],
    ['case is free', 'I HAVE NO IDEA WHERE TO START'],
    ['extra whitespace is collapsed before matching', 'I  have   no    idea  where to start'],
    // --- Hinglish arms ---
    ['pata nahi', 'pata nahi'],
    ['nahi pata', 'nahi pata'],
    ['kuch nahi pata', 'kuch nahi pata'],
    ['samajh nahi aa raha', 'samajh nahi aa raha'],
    ['samajh nahi aa raha hai', 'Samajh nahi aa raha hai'],
    ['kuch samajh nahi aa raha', 'kuch samajh nahi aa raha'],
    ['mujhe kuch samajh nahi aa raha hai', 'Mujhe kuch samajh nahi aa raha hai'],
    ['madad', 'madad'],
    ['hint do', 'hint do'],
    // --- the exact strings the panel's affordance slot sends on the student's behalf ---
    ['stall affordance, english', 'I am still stuck.'],
    ['stall affordance after a fail', 'That run failed — what broke?'],
    ['stall affordance, hinglish', 'Abhi bhi atka hoon →'],
    ['stall affordance after a fail, hinglish', 'Wo run fail hua — kya toota?'],
    // --- too short ---
    ['under 20 characters', 'dp over ranges?'],
    ['19 characters exactly', 'a b c dp over ranges'.slice(0, 19)],
    // --- too few distinct words ---
    ['three long words', 'aaaaaaaaaa bbbbbbbbbb cccccccccc'],
    ['one word repeated', 'same same same same same same'],
    ['one very long word', 'm'.repeat(2000)],
    // --- not a string / nothing at all ---
    ['empty string', ''],
    ['whitespace only', '     \n\t  '],
    ['undefined', undefined],
    ['null', null],
    ['a number', 12345678901234567890],
    ['an object', { message: REAL_PLAN }],
    ['an array', [REAL_PLAN]]
  ];
  it.each(no)('%s', (_label, msg) => {
    expect(infer(msg)).toBeNull();
  });

  it('never throws on a hostile value', () => {
    const hostile = [Symbol('x'), () => {}, new Date(0), NaN, Infinity, true, false];
    for (const v of hostile) expect(() => infer(v)).not.toThrow();
    for (const v of hostile) expect(infer(v)).toBeNull();
  });
});

describe('plan inference: precedence against the two existing branches', () => {
  it('an explicit body.plan still wins over the message', () => {
    expect(cb.resolvePlan('too_slow', null, REAL_PLAN)).toBe(cb.PLAN_CHIPS.too_slow);
    expect(cb.resolvePlan('my own plan sentence', null, REAL_PLAN)).toBe('my own plan sentence');
    expect(cb.resolvePlan('Have a plan, it fails', null, REAL_PLAN)).toBe(cb.PLAN_CHIPS.have_plan_fails);
  });

  it('the no_idea chip still states no plan even when the message would infer one', () => {
    expect(cb.resolvePlan('no_idea', null, REAL_PLAN)).toBeNull();
    expect(cb.resolvePlan('no_idea', 'stored plan', REAL_PLAN)).toBeNull();
    expect(cb.resolvePlan('   ', 'stored plan', REAL_PLAN)).toBeNull();
  });

  it('a stored session plan still wins; inference does not fire when a session plan exists', () => {
    expect(cb.resolvePlan(undefined, 'stored plan', REAL_PLAN)).toBe('stored plan');
    expect(cb.resolvePlan(null, 'stored plan', REAL_PLAN)).toBe('stored plan');
    expect(cb.resolvePlan(undefined, 'stored plan', 'help')).toBe('stored plan');
  });

  it('the two existing branches are unchanged when no message is passed at all', () => {
    expect(cb.resolvePlan(undefined, 'old plan')).toBe('old plan');
    expect(cb.resolvePlan(undefined, null)).toBeNull();
    expect(cb.resolvePlan(null, '')).toBeNull();
    expect(cb.resolvePlan('   ', 'old plan')).toBeNull();
    expect(cb.resolvePlan('p'.repeat(800), null)).toHaveLength(500);
  });

  it('inferPlan is the same rule as the third branch of resolvePlan', () => {
    expect(cb.inferPlan(REAL_PLAN)).toBe(REAL_PLAN);
    expect(cb.inferPlan('I have no idea where to start')).toBeNull();
    expect(cb.PLAN_INFER).toEqual({ minChars: 20, minWords: 4 });
  });
});
