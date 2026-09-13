'use strict';
// Templated reply used when the LLM is off (kill switch), fails, refuses, or the guard falls back.
// Schema-valid, ends with a question, no technique names at rung 1. Degraded semantics are the caller's concern.
const { FAMILY_LABEL } = require('./constants');

// Plain-words verdict classes (local copy: habits.js keeps its own, unexported table).
const BUCKET_WORDS = Object.freeze({
  english: {
    re_overflow: 'an integer overflow',
    re_null_memo: 'a crash on a null or missing entry',
    tle: 'the time limit',
    wa_logic: 'a wrong answer on a normal case',
    wa_modulo: 'a modulo or overflow mismatch',
    wa_edge_empty: 'a wrong answer on a tiny input',
    re_index: 'an out-of-bounds index',
    mle_state: 'the memory limit'
  },
  hinglish: {
    re_overflow: 'integer overflow',
    re_null_memo: 'null ya missing-entry crash',
    tle: 'time limit',
    wa_logic: 'normal case pe wrong answer',
    wa_modulo: 'modulo ya overflow mismatch',
    wa_edge_empty: 'chhote input pe wrong answer',
    re_index: 'out-of-bounds index',
    mle_state: 'memory limit'
  }
});

const STATUS_WORDS = Object.freeze({
  english: { 'Wrong Answer': 'a wrong answer', 'Time Limit Exceeded': 'the time limit', 'Runtime Error': 'a runtime error', 'Memory Limit Exceeded': 'the memory limit', 'Compile Error': 'a compile error', 'Output Limit Exceeded': 'the output limit' },
  hinglish: { 'Wrong Answer': 'wrong answer', 'Time Limit Exceeded': 'time limit', 'Runtime Error': 'runtime error', 'Memory Limit Exceeded': 'memory limit', 'Compile Error': 'compile error', 'Output Limit Exceeded': 'output limit' }
});

const MAX_TESTCASE_CHARS = 120;

function langOf(ctx) {
  return ctx && ctx.language === 'hinglish' ? 'hinglish' : 'english';
}

function rungOf(ctx) {
  const r = ctx && ctx.contract && Number(ctx.contract.rung);
  return Number.isInteger(r) && r >= 1 && r <= 4 ? r : 1;
}

function familyWords(ctx, lang) {
  const fam = ctx.problem && ctx.problem.family;
  const label = fam ? (FAMILY_LABEL[fam] || fam) : null;
  if (lang === 'hinglish') return label ? `Yeh ${label} ka problem hai` : 'Yeh problem chhote hisson ke answers se bada answer banata hai';
  return label ? `This is a ${label} problem` : 'This problem builds its answer from the answers to smaller pieces';
}

function testcaseLine(ctx) {
  const v = ctx.verdict;
  if (!v || v.lastTestcase == null) return '';
  const tc = String(v.lastTestcase).replace(/\s+/g, ' ').trim();
  if (!tc) return '';
  return tc.length > MAX_TESTCASE_CHARS ? `${tc.slice(0, MAX_TESTCASE_CHARS).trimEnd()}...` : tc;
}

function verdictSentence(ctx, lang) {
  const v = ctx.verdict;
  if (!v) return lang === 'hinglish' ? 'Chalo dekhte hain reasoning kahan tootti hai.' : 'Let us find where the reasoning breaks.';
  const tier = v.tier || 'medium';
  const cls = (v.bucket && BUCKET_WORDS[lang][v.bucket]) || (v.status && STATUS_WORDS[lang][v.status]) || null;
  if (lang === 'hinglish') {
    if (!cls) return 'Tumhara last submission pass nahi hua.';
    return tier === 'high' ? `Tumhara last submission ${cls} pe gira.` : `Lagta hai tumhara last submission ${cls} pe gira.`;
  }
  if (!cls) return 'Your last submission did not pass.';
  return tier === 'high' ? `Your last submission hit ${cls}.` : `It looks like your last submission hit ${cls}.`;
}

function rung1(lang) {
  return lang === 'hinglish'
    ? 'Pehle tumhari apni soch se shuru karte hain. Ek line mein batao, is problem ke liye tumhara plan kya hai?'
    : 'Let us start from your own thinking. In one line, what is your plan for this problem?';
}

function rung2(ctx, lang, anchor) {
  const fam = familyWords(ctx, lang);
  if (lang === 'hinglish') {
    return anchor
      ? `${fam}, ${anchor.title} wali family ka. ${anchor.title} mein tumne koi bhi transition likhne se pehle decide kiya tha ki ek stored value kis cheez ko represent karti hai. Yahan ek state ka matlab kya hona chahiye, aur ek entry kis cheez ko represent karegi?`
      : `${fam}. Koi bhi transition likhne se pehle decide karo ki tum kya store kar rahe ho. Yahan ek state ka matlab kya hona chahiye, aur ek entry kis cheez ko represent karegi?`;
  }
  return anchor
    ? `${fam}, the same family as ${anchor.title}. In ${anchor.title} you decided what one stored value stood for before writing any transition. What should one state mean here, and which quantity would a single entry represent?`
    : `${fam}. Before writing any transition, decide what you are storing. What should one state mean here, and which quantity would a single entry represent?`;
}

function rung3(ctx, lang) {
  const tc = testcaseLine(ctx);
  const head = verdictSentence(ctx, lang);
  if (lang === 'hinglish') {
    const mid = tc ? ` Failing test yeh hai: ${tc}.` : '';
    return `${head}${mid} Us test ko haath se trace karo: kis step pe tumhari value expected output se pehli baar alag hoti hai?`;
  }
  const mid = tc ? ` The failing test is: ${tc}.` : '';
  return `${head}${mid} Trace that test by hand: at which step does your value first differ from the expected output?`;
}

function rung4(lang) {
  return lang === 'hinglish'
    ? 'Ab likhne ka time hai. Apna recurrence pseudocode mein likho, zyada se zyada baarah lines, aur jis line pe sabse kam sure ho usse ___ chhod do. Kaunsi gap sabse zyada uncertain lagti hai, aur uske theek upar wali line kya compute karti hai?'
    : 'Time to write it down. Write your recurrence as pseudocode, at most twelve lines, and leave the one line you are least sure of as ___. Which gap feels most uncertain to you, and what does the line just above it compute?';
}

/**
 * templatedReply(ctx) -> { reply, rung, anchors_used, habits_used, asks_question, self_check }
 */
function templatedReply(ctx) {
  const c = ctx || {};
  const lang = langOf(c);
  const rung = rungOf(c);
  const anchor = (Array.isArray(c.anchors) ? c.anchors : []).find((a) => a && a.slug && a.title) || null;
  let reply;
  let anchorsUsed = [];
  if (rung === 1) reply = rung1(lang);
  else if (rung === 2) { reply = rung2(c, lang, anchor); if (anchor) anchorsUsed = [anchor.slug]; }
  else if (rung === 3) reply = rung3(c, lang);
  else reply = rung4(lang);
  return {
    reply,
    rung,
    anchors_used: anchorsUsed,
    habits_used: [],
    asks_question: true,
    self_check: `templated fallback at rung ${rung}; no model diagnosis available`
  };
}

module.exports = { templatedReply, BUCKET_WORDS, STATUS_WORDS };
