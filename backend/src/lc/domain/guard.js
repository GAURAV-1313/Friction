'use strict';
// Deterministic guard over the LLM's parsed reply. Ordered rules; each is a fix (rewrite), a retry (one re-ask with the
// violation list) or, on the second pass, a flag. Pure: no clock, no randomness, no I/O beyond the static term list.
const { WORD_CAPS } = require('./constants');
const { validateReply } = require('../services/llm/schema');
const FORBIDDEN = require('../data/forbidden_terms.json');

const RE_TRANSITION_LEAK = /dp\[[^\]]*\]\s*=|=\s*(min|max)\s*\(|relax(ation)?|recurrence is|push(es)? (it )?(into|onto) (the )?(heap|queue|stack)|(heap|priority queue|stack|deque) (use|lagao|banao)/i;
const RE_ANCHOR_STATEMENT = /\b(so here|here (you|we) (should|need|do)|do the same|yahan (bhi )?(wahi|same) karo)\b/i;
const RE_COMPLETION = /(that('s| is) the only (bug|fix)|that (solves|fixes) it|solves it|problem solved|you're all set|and you are done|that (will|should) fix (it|everything)|then (it|you're) done|and it (will )?pass(es)?|bas yahi (bug|galti) hai|isse (sab )?ho jayega)/i;
const RERUN_SENTENCE = Object.freeze({
  english: 'After that change, re-run your recurrence on the failing case by hand.',
  hinglish: 'Us change ke baad failing case ko haath se dobara trace karo.'
});
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
// A bare reference like dist[node], dp[i][j] or nums[i-1]: not code, only a name. Kept as plain text at rung <= 3.
const REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]=;(){}]{1,24}\])*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FENCE_RE = /```([^\n`]*)\n?([\s\S]*?)```/g;
const STRAY_FENCE_RE = /```[\s\S]*$/;
const INLINE_RE = /`([^`\n]+)`/g;
const SENTENCE_RE = /[^\n]*?[.!?]+(?=\s|$)|[^\n]+$/gm;
const MAX_STRIP_CHARS = 40;
const MAX_FENCE_LINES = 12;
const HINT_WINDOW = 8;
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;

const STOPWORDS = new Set(`
the a an and or but if then else when where which what who whom whose why how does do did done is are was were be been being
have has had this that these those your you yours it its of in on at to for from with by about into over under before after
here there than them they their will would should could can may might must not very just only also still some any each every
both more most much many such same other another again once now ever never always thing things something anything next first
last some none like looks look tell told make made need needs want wants going come comes went right wrong yes true false part
already because while until about there where whether either neither said says say ask asks asked think thinks thought know knows
youre thats whats isnt doesnt dont cant wont didnt wasnt arent havent hasnt couldnt shouldnt wouldnt lets heres theres
tumhara tumhari tumhare tumne tumko tumhe tum kya kaise kyun kyon kaun kaunsa kaunsi kahan kab mein main hai hain tha thi the ho
hoga hogi honge hona hote hota hoti kar karo karna karte karta karti kiya kiye kiya wala wali wale yeh yah woh wo iska iski iske
uska uski uske aur ya par lekin phir bhi toh se ke ka ki ko liye jab tab abhi agar nahi nahin sirf bas kuch sab ek dono wahi
waise jaise matlab socho batao dekho pehle pehla pehli baad yahan wahan kahin lagta lagti chahiye chahiye
`.trim().split(/\s+/));

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function termRegex(term) {
  const body = escapeRe(term.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, 'i');
}

const FORBIDDEN_TERMS = [...(FORBIDDEN.en || []), ...(FORBIDDEN.hinglish || [])]
  .filter((t) => typeof t === 'string' && t.trim())
  .map((t) => ({ term: t, re: termRegex(t) }));

function titleRegex(title, flags) {
  const body = escapeRe(title.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, flags);
}

function lemma(w) {
  let x = w.toLowerCase();
  if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3);
  else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2);
  else if (x.length > 4 && x.endsWith('es')) x = x.slice(0, -2);
  else if (x.length > 3 && x.endsWith('s')) x = x.slice(0, -1);
  return x;
}

function words(text) {
  return (String(text).match(/[A-Za-z][A-Za-z']*/g) || []).map((w) => w.replace(/'/g, '').toLowerCase()).filter(Boolean);
}

function normWords(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []);
}

function protectFences(text) {
  const blocks = [];
  const out = text.replace(FENCE_RE, (m) => {
    blocks.push(m);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  return { out, blocks };
}

function restoreFences(text, blocks) {
  return text.replace(PLACEHOLDER_RE, (_, i) => blocks[Number(i)] || '');
}

function stripFences(text) {
  return text.replace(FENCE_RE, ' ').replace(STRAY_FENCE_RE, ' ');
}

function tidy(text) {
  return text
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fenceLines(match) {
  // Body lines of a fenced block, ignoring the info string and outer blank lines.
  const inner = match.slice(3, -3);
  if (!inner.includes('\n')) return inner.trim() ? [inner.trim()] : [];
  const parts = inner.split('\n');
  if (/^[\w+#.-]*\s*$/.test(parts[0])) parts.shift();
  while (parts.length && !parts[0].trim()) parts.shift();
  while (parts.length && !parts[parts.length - 1].trim()) parts.pop();
  return parts;
}

function sentences(text) {
  return (text.match(SENTENCE_RE) || []).map((s) => s.trim()).filter(Boolean);
}

function lastSentence(text) {
  const t = stripFences(text).replace(/[\s"'*_)\]]+$/, '').trim();
  const list = sentences(t);
  return list.length ? list[list.length - 1] : '';
}

function endsWithQuestion(text) {
  const t = stripFences(text).replace(/[\s"'*_)\]]+$/, '').trim();
  return t.endsWith('?');
}

function countWords(text) {
  return (String(text).trim().match(/\S+/g) || []).length;
}

function offeredAnchors(ctx) {
  return (Array.isArray(ctx.anchors) ? ctx.anchors : []).filter((a) => a && a.slug).slice(0, 3);
}

function offeredHabitKeys(ctx) {
  return (Array.isArray(ctx.habits) ? ctx.habits : []).filter((h) => h && h.key).slice(0, 2).map((h) => h.key);
}

function excludedWords(ctx) {
  const set = new Set();
  for (const a of offeredAnchors(ctx)) for (const w of words(a.title || '')) set.add(lemma(w));
  const p = ctx.problem || {};
  for (const t of Array.isArray(p.tags) ? p.tags : []) for (const w of String(t).split(/[^A-Za-z]+/)) if (w) set.add(lemma(w));
  for (const w of words(p.title || '')) set.add(lemma(w));
  return set;
}

/**
 * guardReply(parsed, ctx, { pass }) -> { reply, anchors_used, habits_used, violations, action, retry_instructions? }
 * Rules run in order on the evolving reply text. Each violation carries its own action ('fix' | 'retry' | 'flag').
 * pass 1: any retry-class violation makes action 'retry'. pass 2: retry-class violations become 'flag' and the reply is
 * accepted as fixed so far; schema failure is the only 'fallback'.
 */
function guardReply(parsed, ctx, opts = {}) {
  const pass = opts.pass === 2 ? 2 : 1;
  const c = ctx || {};
  const lang = c.language === 'hinglish' ? 'hinglish' : 'english';
  const rung = Number.isInteger(c.contract && c.contract.rung) ? c.contract.rung : 1;
  const violations = [];
  const add = (rule, detail, kind) => violations.push({ rule, detail, action: kind === 'retry' && pass === 2 ? 'flag' : kind });

  // 1. schema
  const schema = validateReply(parsed);
  if (!schema.ok) {
    violations.push({ rule: 'schema', detail: `invalid fields: ${schema.errors.join(', ')}`, action: pass === 2 ? 'fallback' : 'retry' });
    const result = {
      reply: parsed && typeof parsed.reply === 'string' ? parsed.reply : '',
      anchors_used: [],
      habits_used: [],
      violations,
      action: pass === 2 ? 'fallback' : 'retry'
    };
    if (result.action === 'retry') result.retry_instructions = retryLine(violations);
    return result;
  }

  let reply = String(parsed.reply);

  // 2. rung mismatch -> overwrite
  if (parsed.rung !== rung) add('rung', `model said rung ${parsed.rung}, contract is ${rung}`, 'fix');

  // 3. anchors_used subset of offered; scan for cited titles; unoffered known titles -> "a classic problem"
  const offered = offeredAnchors(c);
  const bySlug = new Map(offered.map((a) => [a.slug.toLowerCase(), a.slug]));
  const byTitle = new Map(offered.filter((a) => a.title).map((a) => [a.title.toLowerCase(), a.slug]));
  const used = new Set();
  const badAnchors = [];
  for (const raw of parsed.anchors_used) {
    const k = String(raw).trim().toLowerCase();
    const slug = bySlug.get(k) || byTitle.get(k);
    if (slug) used.add(slug); else badAnchors.push(raw);
  }
  if (badAnchors.length) add('anchors_used', `not offered: ${badAnchors.join(', ')}`, 'fix');
  for (const a of offered) if (a.title && titleRegex(a.title, 'i').test(reply)) used.add(a.slug);
  const notAllowed = (Array.isArray(c.offered_titles_not_allowed) ? c.offered_titles_not_allowed : [])
    .filter((t) => typeof t === 'string' && t.trim().split(/\s+/).length >= 2 && !byTitle.has(t.trim().toLowerCase()));
  const replaced = [];
  for (const t of notAllowed) {
    const re = titleRegex(t, 'gi');
    reply = reply.replace(re, (m) => {
      const capitalised = m.split(/\s+/).every((w) => /^[A-Z0-9]/.test(w));
      if (!capitalised) return m;
      replaced.push(m);
      return 'a classic problem';
    });
  }
  if (replaced.length) add('unoffered_title', `replaced: ${[...new Set(replaced)].join(', ')}`, 'fix');
  const anchorsUsed = offered.map((a) => a.slug).filter((s) => used.has(s));

  // 4. habits_used subset of offered keys
  const keys = new Set(offeredHabitKeys(c));
  const habitsUsed = [];
  const badHabits = [];
  for (const raw of parsed.habits_used) {
    const k = String(raw).trim();
    if (keys.has(k)) { if (!habitsUsed.includes(k)) habitsUsed.push(k); } else badHabits.push(raw);
  }
  if (badHabits.length) add('habits_used', `not offered: ${badHabits.join(', ')}`, 'fix');

  // 5. rung <= 3: no code
  if (rung <= 3) {
    const stripped = [];
    let heavy = false;
    reply = reply.replace(FENCE_RE, (m) => {
      const lines = fenceLines(m);
      const content = lines.join('\n');
      stripped.push(content);
      if (lines.length >= 2 || content.length > MAX_STRIP_CHARS) heavy = true;
      return ' ';
    });
    if (STRAY_FENCE_RE.test(reply)) {
      reply = reply.replace(STRAY_FENCE_RE, (m) => {
        const content = m.slice(3).trim();
        stripped.push(content);
        if (content.split('\n').length >= 2 || content.length > MAX_STRIP_CHARS) heavy = true;
        return ' ';
      });
    }
    reply = reply.replace(INLINE_RE, (m, span) => {
      const s = span.trim();
      if (IDENTIFIER.test(s)) return m;
      if (s.length <= MAX_STRIP_CHARS && REFERENCE.test(s)) { stripped.push(s); return s; }
      stripped.push(s);
      if (s.length > MAX_STRIP_CHARS) heavy = true;
      return ' ';
    });
    if (stripped.length) {
      reply = tidy(reply);
      add('code_at_low_rung', `stripped ${stripped.length} code span(s) at rung ${rung}`, 'fix');
      if (heavy) add('code_at_low_rung', 'code longer than one line or 40 chars at rung <= 3: rewrite with no code at all', 'retry');
    }
  }

  // 6. rung 4: one fenced block, only with ___ gaps and <= 12 lines
  if (rung === 4) {
    const keptBlocks = [];
    const dropped = [];
    let body = reply.replace(FENCE_RE, (m) => {
      const lines = fenceLines(m);
      const ok = lines.length <= MAX_FENCE_LINES && lines.some((l) => l.includes('___'));
      if (ok && keptBlocks.length === 0) { keptBlocks.push(m); return `\u0000${keptBlocks.length - 1}\u0000`; }
      dropped.push(ok ? 'extra block' : (lines.length > MAX_FENCE_LINES ? `${lines.length} lines` : 'no ___ gaps'));
      return ' ';
    });
    // Only an unmatched fence survives here (the kept block is a placeholder), so anything from ``` to the end is stray.
    if (STRAY_FENCE_RE.test(body)) { body = body.replace(STRAY_FENCE_RE, ' '); dropped.push('unterminated block'); }
    if (dropped.length) {
      reply = tidy(restoreFences(body, keptBlocks));
      add('rung4_fence', `dropped block(s): ${dropped.join('; ')}`, 'fix');
    }
  }

  // 7. rung 1: forbidden technique names
  if (rung === 1) {
    const hits = [];
    for (const { term, re } of FORBIDDEN_TERMS) if (re.test(reply)) hits.push(term);
    if (hits.length) add('forbidden_term', `technique names at rung 1: ${hits.slice(0, 5).join(', ')}`, 'retry');
  }

  // 8. verbatim LeetCode hint (8-word window)
  const hints = c.problem && Array.isArray(c.problem.leetcode_hints) ? c.problem.leetcode_hints : [];
  if (hints.length) {
    const hay = ` ${normWords(reply).join(' ')} `;
    let leak = null;
    for (const h of hints) {
      const hw = normWords(h);
      if (hw.length < 4) continue;
      const size = Math.min(HINT_WINDOW, hw.length);
      for (let i = 0; i + size <= hw.length && !leak; i += 1) {
        const window = ` ${hw.slice(i, i + size).join(' ')} `;
        if (hay.includes(window)) leak = window.trim();
      }
      if (leak) break;
    }
    if (leak) add('verbatim_hint', `quotes LeetCode's hint: "${leak}"`, 'retry');
  }

  // 9. rung 2: transition leak
  if (rung === 2 && RE_TRANSITION_LEAK.test(reply)) {
    add('transition_leak', `rung 2 must stop at the state; found "${(reply.match(RE_TRANSITION_LEAK) || [''])[0]}"`, 'retry');
  }

  // 10. rung 3: anchor as a statement
  if (rung === 3 && offered.length) {
    const prot = protectFences(reply);
    const titleRes = offered.filter((a) => a.title).map((a) => titleRegex(a.title, 'i'));
    const bad = sentences(prot.out).find((s) => RE_ANCHOR_STATEMENT.test(s) && titleRes.some((re) => re.test(s)));
    if (bad) add('anchor_as_statement', `rung 3 anchors must be a question about this problem, not "${bad.slice(0, 80)}"`, 'retry');
  }

  // 11. completion phrases -> delete the sentence, add the re-run line
  {
    const prot = protectFences(reply);
    let removed = 0;
    let body = prot.out.replace(SENTENCE_RE, (s) => {
      if (RE_COMPLETION.test(s)) { removed += 1; return ''; }
      return s;
    });
    if (removed) {
      body = tidy(body);
      const rerun = RERUN_SENTENCE[lang];
      const last = lastSentence(body);
      if (last && last.endsWith('?')) {
        const idx = body.lastIndexOf(last);
        body = `${body.slice(0, idx).trimEnd()} ${rerun} ${body.slice(idx)}`.trim();
      } else {
        body = `${body} ${rerun}`.trim();
      }
      reply = tidy(restoreFences(body, prot.blocks));
      add('completion_phrase', `deleted ${removed} sentence(s) implying one change finishes the problem`, 'fix');
    }
  }

  // 12. must end with exactly one question
  if (!endsWithQuestion(reply) || parsed.asks_question !== true) {
    add('ends_with_question', endsWithQuestion(reply) ? 'asks_question is not true' : 'the last sentence must be the one question', 'retry');
  }

  // 13. closing question already answered in the body
  {
    const plain = stripFences(reply);
    const list = sentences(plain);
    const q = list.length ? list[list.length - 1] : '';
    if (q.endsWith('?') && list.length > 1) {
      const excluded = excludedWords(c);
      const cand = [...new Set(words(q).filter((w) => w.length >= 4 && !STOPWORDS.has(w)).map(lemma))].filter((w) => !excluded.has(w));
      if (cand.length) {
        const bodyCounts = new Map();
        for (const s of list.slice(0, -1)) {
          if (s.endsWith('?')) continue;
          for (const w of words(s)) { const l = lemma(w); bodyCounts.set(l, (bodyCounts.get(l) || 0) + 1); }
        }
        let rarest = null;
        for (const w of cand) {
          const n = bodyCounts.get(w) || 0;
          if (!rarest || n < rarest.n || (n === rarest.n && w.length > rarest.w.length)) rarest = { w, n };
        }
        if (rarest && rarest.n >= 1) add('question_answered', `the closing question repeats "${rarest.w}", already covered in the body: ask something the body has not answered`, 'retry');
      }
    }
  }

  // 14. word cap
  const cap = WORD_CAPS[rung];
  const n = countWords(reply);
  if (cap && n > cap) add('word_cap', `${n} words, cap for rung ${rung} is ${cap}`, 'retry');

  const action = violations.some((v) => v.action === 'retry') ? 'retry' : 'accept';
  const result = { reply, anchors_used: anchorsUsed, habits_used: habitsUsed, violations, action };
  if (action === 'retry') result.retry_instructions = retryLine(violations);
  return result;
}

function retryLine(violations) {
  const items = violations.filter((v) => v.action === 'retry').map((v) => `${v.rule}: ${v.detail}`);
  return `Your previous reply broke these rules: ${items.join('; ')}. Rewrite the whole reply from scratch, follow every rule and the ladder for this rung, and answer with JSON only.`;
}

module.exports = {
  guardReply,
  RE_TRANSITION_LEAK,
  RE_ANCHOR_STATEMENT,
  RE_COMPLETION,
  RERUN_SENTENCE,
  FORBIDDEN_TERMS,
  STOPWORDS,
  lemma,
  sentences,
  fenceLines,
  endsWithQuestion,
  countWords
};
